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

const GROQ_MODELS = [
  'llama-3.1-8b-instant',
  'mixtral-8x7b-32768'
]

fs.ensureDirSync(DOWNLOAD_DIR)

// ================= STATE =================
const userSession = new Map() // sender -> { lang, mode }
const pendingLink = new Map()
const activeDownloads = new Set()

// ================= LANGUAGE =================
function detectLang(text = '') {
  const t = text.toLowerCase()
  if (/(gua|lu|bang|udah|kok|nggak)/.test(t)) return 'id'
  if (/[áéíóúñ¿¡]/.test(t)) return 'es'
  if (/[ãõç]/.test(t)) return 'pt'
  return 'en'
}

const L = {
  id: {
    hi: `Halo 👋 gue ${BOT_NAME}. Pilih menu di bawah ya.`,
    ai: '🤖 AI Chat',
    dl: '⬇️ Downloader',
    tools: '🧰 Tools',
    sendLink: 'Kirim link videonya.',
    downloading: '⏬ Download dimulai...',
    busy: '⏳ Masih ada proses berjalan.',
    fail: '❌ Gagal download.'
  },
  en: {
    hi: `Hi 👋 I'm ${BOT_NAME}. Choose a menu below.`,
    ai: '🤖 AI Chat',
    dl: '⬇️ Downloader',
    tools: '🧰 Tools',
    sendLink: 'Send the video link.',
    downloading: '⏬ Download started...',
    busy: '⏳ A process is running.',
    fail: '❌ Download failed.'
  }
}

// ================= AI =================
async function aiReply(text) {
  for (const model of GROQ_MODELS) {
    try {
      const r = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model,
          messages: [{ role: 'user', content: text }]
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      )
      return r.data.choices[0].message.content
    } catch {}
  }
  return 'AI error.'
}

// ================= UI =================
function mainMenu(lang) {
  return {
    text: L[lang].hi,
    buttons: [
      { buttonId: 'MENU_AI', buttonText: { displayText: L[lang].ai }, type: 1 },
      { buttonId: 'MENU_DL', buttonText: { displayText: L[lang].dl }, type: 1 },
      { buttonId: 'MENU_TOOLS', buttonText: { displayText: L[lang].tools }, type: 1 }
    ],
    headerType: 1
  }
}

function downloadMenu() {
  return {
    text: 'Pilih format:',
    buttons: [
      { buttonId: 'DL_VIDEO', buttonText: { displayText: '🎥 Video' }, type: 1 },
      { buttonId: 'DL_AUDIO', buttonText: { displayText: '🎵 Audio' }, type: 1 },
      { buttonId: 'CANCEL', buttonText: { displayText: '❌ Cancel' }, type: 1 }
    ],
    headerType: 1
  }
}

// ================= BOT =================
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./session')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    auth: state,
    version,
    logger: Pino({ level: 'silent' })
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', u => {
    if (u.connection === 'open') console.log('✅ BOT CONNECTED')
    if (u.connection === 'close' &&
        u.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
      startBot()
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return

    const chatId = msg.key.remoteJid
    const sender = jidNormalizedUser(msg.key.participant || chatId)

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ''

    // ===== INIT SESSION =====
    if (!userSession.has(sender)) {
      const lang = detectLang(text)
      userSession.set(sender, { lang, mode: null })
      await sock.sendMessage(chatId, mainMenu(lang))
      return
    }

    const session = userSession.get(sender)
    const lang = session.lang

    // ===== BUTTON HANDLER =====
    if (msg.message.buttonsResponseMessage) {
      const id = msg.message.buttonsResponseMessage.selectedButtonId

      if (id === 'MENU_AI') {
        session.mode = 'AI'
        await sock.sendMessage(chatId, { text: '💬 AI ready.' })
        return
      }

      if (id === 'MENU_DL') {
        session.mode = 'DL'
        await sock.sendMessage(chatId, { text: L[lang].sendLink })
        return
      }

      if (id === 'MENU_TOOLS') {
        await sock.sendMessage(chatId, { text: 'Coming soon.' })
        return
      }

      if (id === 'CANCEL') {
        session.mode = null
        await sock.sendMessage(chatId, mainMenu(lang))
        return
      }
    }

    // ===== DOWNLOADER FLOW =====
    if (
      session.mode === 'DL' &&
      /https?:\/\/(youtube|youtu|tiktok|instagram)/i.test(text)
    ) {
      pendingLink.set(sender, text)
      await sock.sendMessage(chatId, downloadMenu())
      return
    }

    // ===== AI CHAT =====
    if (session.mode === 'AI') {
      const reply = await aiReply(text)
      await sock.sendMessage(chatId, { text: reply })
      return
    }

    // ===== FALLBACK =====
    await sock.sendMessage(chatId, mainMenu(lang))
  })
}

startBot().catch(console.error)