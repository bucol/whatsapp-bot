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
const { spawn } = require('child_process')
const fs = require('fs-extra')

const BOT_NAME = 'WhatsappBotGro'
const DOWNLOAD_DIR = './downloads'
fs.ensureDirSync(DOWNLOAD_DIR)

const session = new Map()
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
`👋 *${BOT_NAME}*

1️⃣ AI Chat
2️⃣ Downloader
3️⃣ Tools (soon)

Balas:
- 1 / ai
- 2 / download
- menu`,
    ai: '🤖 AI siap. Kirim pesan apa aja.\n\nKetik *menu* untuk kembali.',
    askLink: '⬇️ Kirim link video (YT / IG / TikTok).',
    downloading: '⏬ Download dimulai...',
    done: '✅ Selesai.\n\nKetik *menu* untuk kembali.'
  },
  en: {
    menu:
`👋 *${BOT_NAME}*

1️⃣ AI Chat
2️⃣ Downloader
3️⃣ Tools (soon)

Reply:
- 1 / ai
- 2 / download
- menu`,
    ai: '🤖 AI ready.\n\nType *menu* to return.',
    askLink: '⬇️ Send video link.',
    downloading: '⏬ Downloading...',
    done: '✅ Done.\n\nType *menu* to return.'
  }
}

// ================= AI =================
async function aiReply(text) {
  const r = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: text }]
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`
      }
    }
  )
  return r.data.choices[0].message.content
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
    const key = isGroup ? `${chatId}:${sender}` : sender

    // GROUP FILTER
    if (isGroup && !session.has(key)) {
      const mentioned =
        msg.message.extendedTextMessage?.contextInfo?.mentionedJid || []
      if (!mentioned.includes(sock.user.id)) return
    }

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
      await sock.sendMessage(chatId, { text: TXT[lang].menu })
      return
    }

    if (!s.mode) {
      if (['1', 'ai'].includes(lower)) {
        s.mode = 'AI'
        await sock.sendMessage(chatId, { text: TXT[lang].ai })
        return
      }
      if (['2', 'download'].includes(lower)) {
        s.mode = 'DL'
        await sock.sendMessage(chatId, { text: TXT[lang].askLink })
        return
      }
      await sock.sendMessage(chatId, { text: TXT[lang].menu })
      return
    }

    if (s.mode === 'AI') {
      const r = await aiReply(text)
      await sock.sendMessage(chatId, { text: r })
      return
    }

    if (s.mode === 'DL' && /https?:\/\//i.test(text)) {
      if (activeDownload.has(key)) return
      activeDownload.add(key)

      await sock.sendMessage(chatId, { text: TXT[lang].downloading })

      spawn('yt-dlp', ['-f', 'mp4', text]).on('close', async () => {
        activeDownload.delete(key)
        s.mode = null
        await sock.sendMessage(chatId, { text: TXT[lang].done })
      })
    }
  })
}

start()