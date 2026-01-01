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
const MODELS = [
  'llama-3.1-8b-instant',
  'mixtral-8x7b-32768'
]

fs.ensureDirSync(DOWNLOAD_DIR)

// ================= STATE =================
const session = new Map()
const pendingLink = new Map()
const activeDownload = new Set()

// ================= UTILS =================
const getText = m =>
  m.message?.conversation ||
  m.message?.extendedTextMessage?.text ||
  m.message?.imageMessage?.caption ||
  m.message?.videoMessage?.caption ||
  ''

const detectLang = t =>
  /(gue|lu|kok|udah|bang|woy)/i.test(t) ? 'id' : 'en'

const TXT = {
  id: {
    menu:
`👋 Halo, gue ${BOT_NAME}

1️⃣ AI Chat
2️⃣ Downloader (YT / TikTok / IG)
3️⃣ Tools (coming soon)

Balas angka (1–3)
Ketik *menu* kapan aja.`,
    ai: '🤖 AI siap. Kirim pesan.\n\nKetik *menu* buat balik.',
    askLink: '⬇️ Kirim link video (YT / Shorts / IG / TikTok).',
    askFormat:
`Pilih format:
1️⃣ Video (MP4)
2️⃣ Audio (MP3)`,
    downloading: '⏬ Download dimulai...',
    done: '✅ Selesai.\n\nKetik *menu* buat kembali.',
    busy: '⏳ Masih ada proses download.',
    invalid: '❌ Format tidak valid.'
  },
  en: {
    menu:
`👋 Hi, I'm ${BOT_NAME}

1️⃣ AI Chat
2️⃣ Downloader (YT / TikTok / IG)
3️⃣ Tools (coming soon)

Reply 1–3
Type *menu* anytime.`,
    ai: '🤖 AI ready.',
    askLink: '⬇️ Send the video link.',
    askFormat:
`Choose format:
1️⃣ Video (MP4)
2️⃣ Audio (MP3)`,
    downloading: '⏬ Download started...',
    done: '✅ Done.\n\nType *menu* to return.',
    busy: '⏳ Download in progress.',
    invalid: '❌ Invalid format.'
  }
}

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
    const text = getText(msg).trim()
    const lower = text.toLowerCase()

    // ===== GROUP FILTER =====
    if (isGroup) {
      const mentioned =
        msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
      const replied =
        msg.message?.extendedTextMessage?.contextInfo?.participant === sock.user.id

      if (
        !mentioned.includes(sock.user.id) &&
        !replied &&
        !/^menu|^[123]$/.test(lower)
      ) return
    }

    const key = isGroup ? `${chatId}:${sender}` : sender

    if (!session.has(key)) {
      const lang = detectLang(text)
      session.set(key, { lang, mode: null })
      await sock.sendMessage(chatId, { text: TXT[lang].menu })
      return
    }

    const s = session.get(key)
    const lang = s.lang

    if (lower === 'menu') {
      s.mode = null
      pendingLink.delete(key)
      await sock.sendMessage(chatId, { text: TXT[lang].menu })
      return
    }

    // ===== MENU =====
    if (!s.mode) {
      if (lower === '1') {
        s.mode = 'AI'
        await sock.sendMessage(chatId, { text: TXT[lang].ai })
        return
      }
      if (lower === '2') {
        s.mode = 'DL'
        await sock.sendMessage(chatId, { text: TXT[lang].askLink })
        return
      }
      await sock.sendMessage(chatId, { text: TXT[lang].menu })
      return
    }

    // ===== AI =====
    if (s.mode === 'AI') {
      const r = await aiReply(text)
      await sock.sendMessage(chatId, { text: r + '\n\n—\nmenu' })
      return
    }

    // ===== DL STEP 1 (LINK) =====
    if (s.mode === 'DL' && /https?:\/\//i.test(text)) {
      pendingLink.set(key, text)
      await sock.sendMessage(chatId, { text: TXT[lang].askFormat })
      return
    }

    // ===== DL STEP 2 (FORMAT) =====
    if (s.mode === 'DL' && pendingLink.has(key)) {
      if (!['1', '2'].includes(lower)) {
        await sock.sendMessage(chatId, { text: TXT[lang].invalid })
        return
      }

      if (activeDownload.has(key)) {
        await sock.sendMessage(chatId, { text: TXT[lang].busy })
        return
      }

      activeDownload.add(key)
      await sock.sendMessage(chatId, { text: TXT[lang].downloading })

      const url = pendingLink.get(key)
      pendingLink.delete(key)

      const out = `${DOWNLOAD_DIR}/${Date.now()}.%(ext)s`
      const args =
        lower === '2'
          ? ['-x', '--audio-format', 'mp3', '-o', out, url]
          : ['-f', 'mp4', '-o', out, url]

      spawn('yt-dlp', args).on('close', async () => {
        activeDownload.delete(key)
        s.mode = null
        await sock.sendMessage(chatId, { text: TXT[lang].done })
      })
    }
  })
}

start()