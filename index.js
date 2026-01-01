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
const pendingLink = new Map()
const activeDownload = new Set()

// ================= UTILS =================
const getText = m =>
  m.message?.conversation ||
  m.message?.extendedTextMessage?.text ||
  m.message?.buttonsResponseMessage?.selectedButtonId ||
  m.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson
    ? JSON.parse(m.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson).id
    : ''

const detectLang = t =>
  /(gue|lu|kok|udah|bang|woy)/i.test(t) ? 'id' : 'en'

// ================= BUTTON =================
const menuButtons = (lang) => ({
  viewOnceMessage: {
    message: {
      interactiveMessage: {
        header: { title: `👋 ${BOT_NAME}` },
        body: {
          text: lang === 'id'
            ? 'Pilih menu di bawah'
            : 'Choose a menu below'
        },
        footer: { text: BOT_NAME },
        nativeFlowMessage: {
          buttons: [
            { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '🤖 AI Chat', id: 'AI' }) },
            { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '⬇️ Downloader', id: 'DL' }) },
            { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '🧰 Tools', id: 'TOOLS' }) }
          ]
        }
      }
    }
  }
})

const backButton = () => ({
  viewOnceMessage: {
    message: {
      interactiveMessage: {
        body: { text: '⬅️ Back to menu' },
        nativeFlowMessage: {
          buttons: [
            { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: '📋 Menu', id: 'MENU' }) }
          ]
        }
      }
    }
  }
})

// ================= AI =================
async function aiReply(text) {
  const r = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: text }]
    },
    { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` } }
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
    const text = getText(msg)
    const key = isGroup ? `${chatId}:${sender}` : sender

    // GROUP: hanya respon kalau dipanggil
    if (isGroup && !session.has(key)) {
      const mentioned =
        msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
      if (!mentioned.includes(sock.user.id)) return
    }

    if (!session.has(key)) {
      const lang = detectLang(text)
      session.set(key, { lang, mode: null })
      await sock.sendMessage(chatId, menuButtons(lang))
      return
    }

    const s = session.get(key)

    if (text === 'MENU') {
      s.mode = null
      await sock.sendMessage(chatId, menuButtons(s.lang))
      return
    }

    if (text === 'AI') {
      s.mode = 'AI'
      await sock.sendMessage(chatId, { text: '🤖 AI ready. Say anything.' })
      await sock.sendMessage(chatId, backButton())
      return
    }

    if (s.mode === 'AI') {
      const r = await aiReply(text)
      await sock.sendMessage(chatId, { text: r })
      await sock.sendMessage(chatId, backButton())
      return
    }

    if (text === 'DL') {
      s.mode = 'DL'
      await sock.sendMessage(chatId, { text: '⬇️ Send video link (YT / IG / TikTok)' })
      await sock.sendMessage(chatId, backButton())
      return
    }

    if (s.mode === 'DL' && /https?:\/\//i.test(text)) {
      if (activeDownload.has(key)) return
      activeDownload.add(key)

      await sock.sendMessage(chatId, { text: '⏬ Downloading...' })

      spawn('yt-dlp', ['-f', 'mp4', text]).on('close', () => {
        activeDownload.delete(key)
        sock.sendMessage(chatId, { text: '✅ Done (file saved on server)' })
        sock.sendMessage(chatId, menuButtons(s.lang))
      })
    }
  })
}

start()