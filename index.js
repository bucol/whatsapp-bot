require('dotenv').config()

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  proto
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
const session = new Map() // sender -> { lang, mode }
const pendingLink = new Map()
const activeDownloads = new Set()

// ================= LANGUAGE =================
function detectLang(t = '') {
  t = t.toLowerCase()
  if (/(gua|lu|bang|woy|udah|kok)/.test(t)) return 'id'
  if (/[áéíóúñ¿¡]/.test(t)) return 'es'
  if (/[ãõç]/.test(t)) return 'pt'
  return 'en'
}

const TXT = {
  id: {
    hi: `Halo 👋 gue ${BOT_NAME}. Pilih menu di bawah.`,
    ai: '🤖 AI Chat',
    dl: '⬇️ Downloader',
    tools: '🧰 Tools',
    sendLink: 'Kirim link videonya.',
    downloading: '⏬ Download dimulai...',
    busy: '⏳ Masih ada proses.',
    fail: '❌ Gagal.'
  },
  en: {
    hi: `Hi 👋 I'm ${BOT_NAME}. Choose a menu below.`,
    ai: '🤖 AI Chat',
    dl: '⬇️ Downloader',
    tools: '🧰 Tools',
    sendLink: 'Send the video link.',
    downloading: '⏬ Download started...',
    busy: '⏳ Process running.',
    fail: '❌ Failed.'
  }
}

// ================= AI =================
async function aiReply(text) {
  for (const model of GROQ_MODELS) {
    try {
      const r = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        { model, messages: [{ role: 'user', content: text }] },
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

// ================= UI (NATIVE BUTTONS) =================
function mainMenu(lang) {
  return {
    interactiveMessage: proto.Message.InteractiveMessage.create({
      body: proto.Message.InteractiveMessage.Body.create({
        text: TXT[lang].hi
      }),
      footer: proto.Message.InteractiveMessage.Footer.create({
        text: BOT_NAME
      }),
      nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
        buttons: [
          { name: 'quick_reply', buttonParamsJson: JSON.stringify({ id: 'AI', title: TXT[lang].ai }) },
          { name: 'quick_reply', buttonParamsJson: JSON.stringify({ id: 'DL', title: TXT[lang].dl }) },
          { name: 'quick_reply', buttonParamsJson: JSON.stringify({ id: 'TOOLS', title: TXT[lang].tools }) }
        ]
      })
    })
  }
}

function downloadMenu() {
  return {
    interactiveMessage: proto.Message.InteractiveMessage.create({
      body: proto.Message.InteractiveMessage.Body.create({
        text: 'Pilih format download:'
      }),
      nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
        buttons: [
          { name: 'quick_reply', buttonParamsJson: JSON.stringify({ id: 'VIDEO', title: '🎥 Video' }) },
          { name: 'quick_reply', buttonParamsJson: JSON.stringify({ id: 'AUDIO', title: '🎵 Audio' }) },
          { name: 'quick_reply', buttonParamsJson: JSON.stringify({ id: 'CANCEL', title: '❌ Cancel' }) }
        ]
      })
    })
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
    if (u.connection === 'open') console.log('✅ WhatsappBotGro connected')
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

    // INIT SESSION
    if (!session.has(sender)) {
      const lang = detectLang(text)
      session.set(sender, { lang, mode: null })
      await sock.sendMessage(chatId, mainMenu(lang))
      return
    }

    const s = session.get(sender)
    const lang = s.lang

    // HANDLE BUTTON
    const btn =
      msg.message.interactiveResponseMessage?.nativeFlowResponseMessage?.name ||
      msg.message.buttonsResponseMessage?.selectedButtonId

    if (btn === 'AI') {
      s.mode = 'AI'
      await sock.sendMessage(chatId, { text: '💬 AI ready.' })
      return
    }

    if (btn === 'DL') {
      s.mode = 'DL'
      await sock.sendMessage(chatId, { text: TXT[lang].sendLink })
      return
    }

    if (btn === 'VIDEO' || btn === 'AUDIO') {
      const url = pendingLink.get(sender)
      if (!url) return

      if (activeDownloads.has(sender)) {
        await sock.sendMessage(chatId, { text: TXT[lang].busy })
        return
      }

      activeDownloads.add(sender)
      await sock.sendMessage(chatId, { text: TXT[lang].downloading })

      const type = btn === 'AUDIO' ? 'audio' : 'video'
      const id = Date.now()
      const out = `${DOWNLOAD_DIR}/${id}.%(ext)s`

      const args =
        type === 'audio'
          ? ['-x', '--audio-format', 'mp3', '-o', out, url]
          : ['-f', 'mp4', '-o', out, url]

      const p = spawn('yt-dlp', args)
      p.on('close', async code => {
        activeDownloads.delete(sender)
        if (code !== 0) {
          await sock.sendMessage(chatId, { text: TXT[lang].fail })
          return
        }
        const file = (await fs.readdir(DOWNLOAD_DIR))
          .map(f => path.join(DOWNLOAD_DIR, f))
          .find(f => f.includes(id))

        if (type === 'audio') {
          await sock.sendMessage(chatId, { audio: { url: file }, mimetype: 'audio/mpeg' })
        } else {
          await sock.sendMessage(chatId, { video: { url: file } })
        }
        await fs.remove(file)
      })
      return
    }

    // LINK DETECT
    if (s.mode === 'DL' && /https?:\/\/(youtube|youtu|tiktok|instagram)/i.test(text)) {
      pendingLink.set(sender, text)
      await sock.sendMessage(chatId, downloadMenu())
      return
    }

    // AI CHAT
    if (s.mode === 'AI') {
      const reply = await aiReply(text)
      await sock.sendMessage(chatId, { text: reply })
      return
    }

    // FALLBACK
    await sock.sendMessage(chatId, mainMenu(lang))
  })
}

startBot().catch(console.error)