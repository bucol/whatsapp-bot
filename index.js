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
const path = require('path')
const { spawn } = require('child_process')

// ================= CONFIG =================
const BOT_NAME = 'WhatsappBotGro'
const DOWNLOAD_DIR = './downloads'
const MODELS = [
  'llama-3.1-8b-instant',
  'mixtral-8x7b-32768',
  'llama-3.1-70b-versatile'
]
fs.ensureDirSync(DOWNLOAD_DIR)

// ================= STATE =================
const session = new Map()
const pendingLink = new Map()
const activeDownloads = new Set()

// ================= UTILS =================
const getText = msg =>
  msg.message?.conversation ||
  msg.message?.extendedTextMessage?.text ||
  msg.message?.imageMessage?.caption ||
  msg.message?.videoMessage?.caption ||
  ''

const detectLang = t =>
  /(gua|lu|kok|udah|nggak|bang|woy)/i.test(t) ? 'id' : 'en'

const TXT = {
  id: {
    menu:
`👋 Halo, gue ${BOT_NAME}

1️⃣ AI Chat
2️⃣ Downloader (YT / TikTok / IG)
3️⃣ Tools (coming soon)

Balas angka (1–3).
Ketik *menu* kapan aja.`,
    ai: '🤖 AI siap. Kirim pesan.\n\nKetik *menu* buat balik.',
    link: '⬇️ Kirim link videonya.',
    format:
`Pilih format:
1️⃣ Video (MP4)
2️⃣ Audio (MP3)`,
    downloading: '⏬ Download dimulai…',
    busy: '⏳ Masih ada proses berjalan.',
    fail: '❌ Gagal.'
  },
  en: {
    menu:
`👋 Hi, I'm ${BOT_NAME}

1️⃣ AI Chat
2️⃣ Downloader (YT / TikTok / IG)
3️⃣ Tools (coming soon)

Reply 1–3.
Type *menu* anytime.`,
    ai: '🤖 AI ready.',
    link: '⬇️ Send the video link.',
    format:
`Choose format:
1️⃣ Video (MP4)
2️⃣ Audio (MP3)`,
    downloading: '⏬ Download started…',
    busy: '⏳ Process running.',
    fail: '❌ Failed.'
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
      const repliedBot =
        msg.message?.extendedTextMessage?.contextInfo?.participant === sock.user.id

      if (
        !mentioned.includes(sock.user.id) &&
        !repliedBot &&
        !/^menu|^[123]$/.test(lower)
      ) return
    }

    // ===== SESSION KEY =====
    const sessionKey = isGroup ? `${chatId}:${sender}` : sender

    if (!session.has(sessionKey)) {
      const lang = detectLang(text)
      session.set(sessionKey, { lang, mode: null })
      await sock.sendMessage(chatId, { text: TXT[lang].menu })
      return
    }

    const s = session.get(sessionKey)
    const lang = s.lang

    if (lower === 'menu') {
      s.mode = null
      pendingLink.delete(sessionKey)
      await sock.sendMessage(chatId, { text: TXT[lang].menu })
      return
    }

    // ===== MAIN MENU =====
    if (!s.mode) {
      if (lower === '1') {
        s.mode = 'AI'
        await sock.sendMessage(chatId, { text: TXT[lang].ai })
        return
      }
      if (lower === '2') {
        s.mode = 'DL'
        await sock.sendMessage(chatId, { text: TXT[lang].link })
        return
      }
      await sock.sendMessage(chatId, { text: TXT[lang].menu })
      return
    }

    // ===== AI =====
    if (s.mode === 'AI') {
      const reply = await aiReply(text)
      await sock.sendMessage(chatId, {
        text: reply + '\n\n—\nType *menu*'
      })
      return
    }

    // ===== DL =====
    if (s.mode === 'DL' && !pendingLink.has(sessionKey)) {
      if (/https?:\/\//i.test(text)) {
        pendingLink.set(sessionKey, text)
        await sock.sendMessage(chatId, { text: TXT[lang].format })
      }
      return
    }

    if (s.mode === 'DL' && pendingLink.has(sessionKey)) {
      if (!['1', '2'].includes(lower)) return
      if (activeDownloads.has(sessionKey)) {
        await sock.sendMessage(chatId, { text: TXT[lang].busy })
        return
      }

      activeDownloads.add(sessionKey)
      await sock.sendMessage(chatId, { text: TXT[lang].downloading })

      const url = pendingLink.get(sessionKey)
      pendingLink.delete(sessionKey)

      const out = `${DOWNLOAD_DIR}/${Date.now()}.%(ext)s`
      const args =
        lower === '2'
          ? ['-x', '--audio-format', 'mp3', '-o', out, url]
          : ['-f', 'mp4', '-o', out, url]

      spawn('yt-dlp', args).on('close', async () => {
        activeDownloads.delete(sessionKey)
        s.mode = null
        await sock.sendMessage(chatId, { text: TXT[lang].menu })
      })
    }
  })
}

start()