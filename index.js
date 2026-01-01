require('dotenv').config()

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser
} = require('@whiskeysockets/baileys')

const Pino = require('pino')
const axios = require('axios')
const fs = require('fs-extra')
const { spawn } = require('child_process')

// ================= CONFIG =================
const BOT_NAME = 'WhatsappBotGro'
const DOWNLOAD_DIR = './downloads'
fs.ensureDirSync(DOWNLOAD_DIR)

const MODELS = [
  'llama-3.1-8b-instant',
  'mixtral-8x7b-32768'
]

// ================= STATE =================
const session = new Map()
const pendingLink = new Map()
const activeDownload = new Set()

// ================= UTILS =================
const getText = m =>
  m.message?.conversation ||
  m.message?.extendedTextMessage?.text ||
  m.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
  ''

const detectLang = t =>
  /(gue|lu|kok|udah|bang|woy)/i.test(t) ? 'id' : 'en'

// ================= TEXT =================
const TXT = {
  id: {
    hi: `👋 Halo, gue ${BOT_NAME}`,
    ai: '🤖 AI siap. Kirim pesan apa aja.',
    askLink: '⬇️ Kirim link video (YT / IG / TikTok).',
    downloading: '⏬ Download dimulai...',
    done: '✅ Selesai.',
    busy: '⏳ Masih ada proses.',
    invalid: '❌ Pilihan tidak valid.'
  },
  en: {
    hi: `👋 Hi, I'm ${BOT_NAME}`,
    ai: '🤖 AI ready.',
    askLink: '⬇️ Send the video link.',
    downloading: '⏬ Download started...',
    done: '✅ Done.',
    busy: '⏳ Process running.',
    invalid: '❌ Invalid choice.'
  }
}

// ================= LIST BUILDER =================
const mainMenu = lang => ({
  text: TXT[lang].hi,
  footer: 'Select a menu',
  title: '📋 Main Menu',
  buttonText: 'Open Menu',
  sections: [
    {
      title: 'Features',
      rows: [
        { title: '🤖 AI Chat', rowId: 'MENU_AI' },
        { title: '⬇️ Downloader', rowId: 'MENU_DL' },
        { title: '🧰 Tools', rowId: 'MENU_TOOLS' }
      ]
    }
  ]
})

const formatMenu = lang => ({
  text: 'Pilih format',
  footer: 'Downloader',
  title: '🎞 Download Format',
  buttonText: 'Choose',
  sections: [
    {
      title: 'Format',
      rows: [
        { title: '🎥 Video (MP4)', rowId: 'DL_VIDEO' },
        { title: '🎵 Audio (MP3)', rowId: 'DL_AUDIO' }
      ]
    }
  ]
})

const backMenu = lang => ({
  text: 'Kembali ke menu utama',
  footer: BOT_NAME,
  title: '⬅️ Back',
  buttonText: 'Menu',
  sections: [
    {
      title: 'Navigation',
      rows: [{ title: '📋 Main Menu', rowId: 'MENU_HOME' }]
    }
  ]
})

// ================= AI =================
async function aiReply(text) {
  for (const model of MODELS) {
    try {
      const r = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        { model, messages: [{ role: 'user', content: text }] },
        { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` } }
      )
      return r.data.choices[0].message.content
    } catch {}
  }
  return 'AI error.'
}

// ================= BOT =================
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./session')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    auth: state,
    version,
    logger: Pino({ level: 'silent' })
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', u => {
    if (u.connection === 'open')
      console.log(`✅ ${BOT_NAME} connected`)
    if (
      u.connection === 'close' &&
      u.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
    ) start()
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg?.message || msg.key.fromMe) return

    const chatId = msg.key.remoteJid
    const isGroup = chatId.endsWith('@g.us')
    const sender = jidNormalizedUser(msg.key.participant || chatId)
    const text = getText(msg)
    const key = isGroup ? `${chatId}:${sender}` : sender

    // ===== GROUP ENTRY FILTER =====
    if (isGroup && !session.has(key)) {
      const mentioned =
        msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
      if (!mentioned.includes(sock.user.id)) return
    }

    // ===== INIT =====
    if (!session.has(key)) {
      const lang = detectLang(text)
      session.set(key, { lang, mode: null })
      await sock.sendMessage(chatId, { listMessage: mainMenu(lang) })
      return
    }

    const s = session.get(key)
    const lang = s.lang

    // ===== MENU HANDLER =====
    if (text === 'MENU_HOME') {
      s.mode = null
      pendingLink.delete(key)
      await sock.sendMessage(chatId, { listMessage: mainMenu(lang) })
      return
    }

    if (text === 'MENU_AI') {
      s.mode = 'AI'
      await sock.sendMessage(chatId, {
        text: TXT[lang].ai,
        listMessage: backMenu(lang)
      })
      return
    }

    if (text === 'MENU_DL') {
      s.mode = 'DL'
      await sock.sendMessage(chatId, {
        text: TXT[lang].askLink,
        listMessage: backMenu(lang)
      })
      return
    }

    // ===== AI =====
    if (s.mode === 'AI') {
      const r = await aiReply(text)
      await sock.sendMessage(chatId, {
        text: r,
        listMessage: backMenu(lang)
      })
      return
    }

    // ===== DL LINK =====
    if (s.mode === 'DL' && /https?:\/\//i.test(text)) {
      pendingLink.set(key, text)
      await sock.sendMessage(chatId, { listMessage: formatMenu(lang) })
      return
    }

    // ===== DL FORMAT =====
    if (s.mode === 'DL' && pendingLink.has(key)) {
      if (activeDownload.has(key)) {
        await sock.sendMessage(chatId, { text: TXT[lang].busy })
        return
      }

      const isAudio = text === 'DL_AUDIO'
      if (!['DL_AUDIO', 'DL_VIDEO'].includes(text)) {
        await sock.sendMessage(chatId, { text: TXT[lang].invalid })
        return
      }

      activeDownload.add(key)
      await sock.sendMessage(chatId, { text: TXT[lang].downloading })

      const url = pendingLink.get(key)
      pendingLink.delete(key)

      const out = `${DOWNLOAD_DIR}/${Date.now()}.%(ext)s`
      const args = isAudio
        ? ['-x', '--audio-format', 'mp3', '-o', out, url]
        : ['-f', 'mp4', '-o', out, url]

      spawn('yt-dlp', args).on('close', async () => {
        activeDownload.delete(key)
        s.mode = null
        await sock.sendMessage(chatId, {
          text: TXT[lang].done,
          listMessage: mainMenu(lang)
        })
      })
    }
  })
}

start()