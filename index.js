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
  'mixtral-8x7b-32768',
  'llama-3.1-70b-versatile'
]
fs.ensureDirSync(DOWNLOAD_DIR)

// ================= STATE =================
const session = new Map()          // sender -> { lang, mode }
const pendingLink = new Map()      // sender -> url
const activeDownloads = new Set()  // sender

// ================= LANGUAGE =================
function detectLang(t = '') {
  t = t.toLowerCase()
  if (/(gua|lu|bang|udah|kok|nggak|woy)/.test(t)) return 'id'
  if (/[áéíóúñ¿¡]/.test(t)) return 'es'
  if (/[ãõç]/.test(t)) return 'pt'
  return 'en'
}

const TXT = {
  id: {
    menu: () =>
`👋 Halo, gue ${BOT_NAME}

1️⃣ AI Chat
2️⃣ Downloader (YT / TikTok / IG)
3️⃣ Tools (coming soon)

Balas angka (1–3).
Ketik *menu* kapan saja.`,
    aiReady: `🤖 AI siap. Tulis apa saja.\n\nKetik *menu* untuk kembali.`,
    sendLink: `⬇️ Kirim link videonya.\n\nKetik *menu* untuk batal.`,
    chooseFmt:
`Pilih format:
1️⃣ Video (MP4)
2️⃣ Audio (MP3)

Balas angka (1–2) atau *menu*.`,
    downloading: '⏬ Download dimulai…',
    busy: '⏳ Masih ada proses berjalan.',
    fail: '❌ Gagal memproses.',
    done: '✅ Selesai.\n\nKetik *menu*.'
  },
  en: {
    menu: () =>
`👋 Hi, I'm ${BOT_NAME}

1️⃣ AI Chat
2️⃣ Downloader (YT / TikTok / IG)
3️⃣ Tools (coming soon)

Reply with a number (1–3).
Type *menu* anytime.`,
    aiReady: `🤖 AI ready. Say anything.\n\nType *menu* to go back.`,
    sendLink: `⬇️ Send the video link.\n\nType *menu* to cancel.`,
    chooseFmt:
`Choose format:
1️⃣ Video (MP4)
2️⃣ Audio (MP3)

Reply 1–2 or *menu*.`,
    downloading: '⏬ Download started…',
    busy: '⏳ A process is running.',
    fail: '❌ Failed.',
    done: '✅ Done.\n\nType *menu*.'
  }
}

// ================= AI =================
async function aiReply(text) {
  for (const model of GROQ_MODELS) {
    try {
      const r = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        { model, messages: [{ role: 'user', content: text }], temperature: 0.7 },
        {
          headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      )
      return r.data.choices[0].message.content
    } catch {}
  }
  return '⚠️ AI sedang bermasalah.'
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
    if (u.connection === 'open') {
      console.log(`✅ ${BOT_NAME} connected`)
    }
    if (
      u.connection === 'close' &&
      u.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
    ) {
      startBot()
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg?.message || msg.key.fromMe) return

    const chatId = msg.key.remoteJid
    const sender = jidNormalizedUser(msg.key.participant || chatId)
    const isGroup = chatId.endsWith('@g.us')

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ''
    const t = text.trim().toLowerCase()

    // ===== GROUP FILTER (ANTI SPAM) =====
    if (isGroup) {
      const mentioned =
        msg.message.extendedTextMessage?.contextInfo?.mentionedJid || []
      const isMentioned = mentioned.includes(sock.user.id)
      const isCalled = /^bot|^ai|^menu/i.test(t)

      if (!isMentioned && !isCalled) return
    }

    // ===== INIT SESSION =====
    if (!session.has(sender)) {
      const lang = detectLang(text)
      session.set(sender, { lang, mode: null })
      await sock.sendMessage(chatId, { text: TXT[lang].menu() })
      return
    }

    const s = session.get(sender)
    const lang = s.lang

    // ===== GLOBAL MENU =====
    if (t === 'menu') {
      s.mode = null
      pendingLink.delete(sender)
      await sock.sendMessage(chatId, { text: TXT[lang].menu() })
      return
    }

    // ===== MENU MODE =====
    if (!s.mode) {
      if (t === '1') {
        s.mode = 'AI'
        await sock.sendMessage(chatId, { text: TXT[lang].aiReady })
        return
      }
      if (t === '2') {
        s.mode = 'DL'
        await sock.sendMessage(chatId, { text: TXT[lang].sendLink })
        return
      }
      if (t === '3') {
        await sock.sendMessage(chatId, { text: '🧰 Tools: coming soon.\n\nType *menu*.' })
        return
      }
      await sock.sendMessage(chatId, { text: TXT[lang].menu() })
      return
    }

    // ===== AI MODE =====
    if (s.mode === 'AI') {
      const reply = await aiReply(text)
      await sock.sendMessage(chatId, { text: `${reply}\n\n—\n${TXT[lang].done}` })
      return
    }

    // ===== DL MODE (WAIT LINK) =====
    if (s.mode === 'DL' && !pendingLink.has(sender)) {
      if (/https?:\/\/(youtube|youtu|tiktok|instagram)/i.test(text)) {
        pendingLink.set(sender, text)
        await sock.sendMessage(chatId, { text: TXT[lang].chooseFmt })
        return
      }
      await sock.sendMessage(chatId, { text: TXT[lang].sendLink })
      return
    }

    // ===== DL MODE (FORMAT) =====
    if (s.mode === 'DL' && pendingLink.has(sender)) {
      if (t !== '1' && t !== '2') {
        await sock.sendMessage(chatId, { text: TXT[lang].chooseFmt })
        return
      }

      if (activeDownloads.has(sender)) {
        await sock.sendMessage(chatId, { text: TXT[lang].busy })
        return
      }

      activeDownloads.add(sender)
      await sock.sendMessage(chatId, { text: TXT[lang].downloading })

      const url = pendingLink.get(sender)
      pendingLink.delete(sender)

      const id = Date.now()
      const out = `${DOWNLOAD_DIR}/${id}.%(ext)s`
      const args =
        t === '2'
          ? ['-x', '--audio-format', 'mp3', '-o', out, url]
          : ['-f', 'mp4', '-o', out, url]

      const p = spawn('yt-dlp', args)

      p.on('close', async code => {
        activeDownloads.delete(sender)

        if (code !== 0) {
          await sock.sendMessage(chatId, { text: TXT[lang].fail })
          await sock.sendMessage(chatId, { text: TXT[lang].menu() })
          s.mode = null
          return
        }

        const file = (await fs.readdir(DOWNLOAD_DIR))
          .map(f => path.join(DOWNLOAD_DIR, f))
          .find(f => f.includes(id))

        if (t === '2') {
          await sock.sendMessage(chatId, {
            audio: { url: file },
            mimetype: 'audio/mpeg'
          })
        } else {
          await sock.sendMessage(chatId, { video: { url: file } })
        }

        await fs.remove(file)
        s.mode = null
        await sock.sendMessage(chatId, { text: TXT[lang].menu() })
      })
    }
  })
}

startBot().catch(console.error)