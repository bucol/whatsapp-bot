/**
 * WhatsappBotGro – Full Button UI
 * Termux / VPS / Laptop
 */

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

// Groq models (fallback otomatis)
const GROQ_MODELS = [
  'llama-3.1-8b-instant',
  'mixtral-8x7b-32768',
  'llama-3.1-70b-versatile'
]

fs.ensureDirSync(DOWNLOAD_DIR)

// ================= STATE =================
const pendingLink = new Map()       // sender -> link
const pendingMenu = new Map()       // sender -> 'AI' | 'DOWNLOAD' | 'TOOLS'
const activeDownloads = new Set()   // sender

// ================= UTIL =================
function detectLang(text = '') {
  // Simple heuristic (cepat & offline)
  const t = text.toLowerCase()
  if (/[áéíóúñ¿¡]/.test(t)) return 'es'
  if (/[ãõç]/.test(t)) return 'pt'
  if (/(baik|gua|lu|bang|kalo|udah|nggak|kok)/.test(t)) return 'id'
  return 'en'
}

function t(lang, key) {
  const dict = {
    id: {
      hi: `Halo 👋 gue ${BOT_NAME}. Pilih menu di bawah ya.`,
      menu: 'Menu Utama',
      ai: 'AI Chat',
      dl: 'Downloader',
      tools: 'Tools',
      pick: 'Pilih opsi:',
      sendLink: 'Kirim link video:',
      downloading: '⏬ Download dimulai…',
      busy: '⏳ Masih ada proses berjalan.',
      fail: '❌ Gagal. Coba lagi.',
      done: '✅ Selesai.'
    },
    en: {
      hi: `Hi 👋 I'm ${BOT_NAME}. Choose a menu below.`,
      menu: 'Main Menu',
      ai: 'AI Chat',
      dl: 'Downloader',
      tools: 'Tools',
      pick: 'Choose an option:',
      sendLink: 'Send the video link:',
      downloading: '⏬ Download started…',
      busy: '⏳ A process is still running.',
      fail: '❌ Failed. Try again.',
      done: '✅ Done.'
    },
    pt: {
      hi: `Olá 👋 sou o ${BOT_NAME}. Escolha um menu abaixo.`,
      menu: 'Menu Principal',
      ai: 'Chat IA',
      dl: 'Downloader',
      tools: 'Ferramentas',
      pick: 'Escolha uma opção:',
      sendLink: 'Envie o link do vídeo:',
      downloading: '⏬ Download iniciado…',
      busy: '⏳ Processo em andamento.',
      fail: '❌ Falhou. Tente novamente.',
      done: '✅ Concluído.'
    },
    es: {
      hi: `Hola 👋 soy ${BOT_NAME}. Elige un menú abajo.`,
      menu: 'Menú Principal',
      ai: 'Chat IA',
      dl: 'Descargador',
      tools: 'Herramientas',
      pick: 'Elige una opción:',
      sendLink: 'Envía el enlace del video:',
      downloading: '⏬ Descarga iniciada…',
      busy: '⏳ Proceso en curso.',
      fail: '❌ Falló. Intenta de nuevo.',
      done: '✅ Listo.'
    }
  }
  return dict[lang]?.[key] || dict.en[key]
}

// ================= AI (GROQ + FALLBACK) =================
async function aiReply(prompt) {
  if (!process.env.GROQ_API_KEY) return 'AI belum dikonfigurasi.'
  for (const model of GROQ_MODELS) {
    try {
      const res = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.7
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      )
      return res.data.choices[0].message.content
    } catch (e) {}
  }
  return '⚠️ Semua model AI bermasalah.'
}

// ================= DOWNLOADER (NON-BLOCKING) =================
function downloadAsync(url, type, onDone, onFail) {
  const id = Date.now()
  const out = `${DOWNLOAD_DIR}/${id}.%(ext)s`
  const args = []

  if (type === 'audio') args.push('-x', '--audio-format', 'mp3')
  if (type === 'video') args.push('-f', 'mp4')

  args.push('-o', out, url)

  const p = spawn('yt-dlp', args)
  p.on('close', async code => {
    if (code !== 0) return onFail()
    const file = (await fs.readdir(DOWNLOAD_DIR))
      .map(f => path.join(DOWNLOAD_DIR, f))
      .find(f => f.includes(id))
    onDone(file)
  })
}

// ================= UI =================
function mainMenu(lang) {
  return {
    text: t(lang, 'hi'),
    buttons: [
      { buttonId: 'MENU_AI', buttonText: { displayText: '🤖 ' + t(lang, 'ai') }, type: 1 },
      { buttonId: 'MENU_DL', buttonText: { displayText: '⬇️ ' + t(lang, 'dl') }, type: 1 },
      { buttonId: 'MENU_TOOLS', buttonText: { displayText: '🧰 ' + t(lang, 'tools') }, type: 1 }
    ],
    headerType: 1
  }
}

function downloadChoice(lang) {
  return {
    text: t(lang, 'pick'),
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
    if (u.connection === 'open') console.log(`✅ ${BOT_NAME} connected`)
    if (u.connection === 'close') {
      if (u.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
        startBot()
      }
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

    const lang = detectLang(text)

    // ===== BUTTON HANDLER =====
    if (msg.message.buttonsResponseMessage) {
      const id = msg.message.buttonsResponseMessage.selectedButtonId

      if (id === 'MENU_AI') {
        pendingMenu.set(sender, 'AI')
        await sock.sendMessage(chatId, { text: '💬 AI siap. Tulis pesanmu.' })
        return
      }

      if (id === 'MENU_DL') {
        pendingMenu.set(sender, 'DOWNLOAD')
        await sock.sendMessage(chatId, { text: t(lang, 'sendLink') })
        return
      }

      if (id === 'MENU_TOOLS') {
        await sock.sendMessage(chatId, { text: '🧰 Coming soon.' })
        return
      }

      if (id === 'DL_VIDEO' || id === 'DL_AUDIO') {
        const url = pendingLink.get(sender)
        if (!url) return
        if (activeDownloads.has(sender)) {
          await sock.sendMessage(chatId, { text: t(lang, 'busy') })
          return
        }
        activeDownloads.add(sender)
        pendingLink.delete(sender)

        await sock.sendMessage(chatId, { text: t(lang, 'downloading') })

        downloadAsync(
          url,
          id === 'DL_AUDIO' ? 'audio' : 'video',
          async file => {
            if (id === 'DL_AUDIO') {
              await sock.sendMessage(chatId, {
                audio: { url: file },
                mimetype: 'audio/mpeg'
              })
            } else {
              await sock.sendMessage(chatId, {
                video: { url: file }
              })
            }
            await fs.remove(file)
            activeDownloads.delete(sender)
          },
          async () => {
            activeDownloads.delete(sender)
            await sock.sendMessage(chatId, { text: t(lang, 'fail') })
          }
        )
        return
      }

      if (id === 'CANCEL') {
        pendingLink.delete(sender)
        await sock.sendMessage(chatId, mainMenu(lang))
        return
      }
    }

    // ===== LINK DETECT (Downloader Flow) =====
    if (/https?:\/\/(www\.)?(youtube|youtu|tiktok|instagram)/i.test(text)) {
      pendingLink.set(sender, text)
      await sock.sendMessage(chatId, downloadChoice(lang))
      return
    }

    // ===== DEFAULT =====
    // Jika belum pilih menu, tampilkan menu
    if (!pendingMenu.has(sender)) {
      await sock.sendMessage(chatId, mainMenu(lang))
      return
    }

    // AI Chat
    if (pendingMenu.get(sender) === 'AI') {
      const reply = await aiReply(text)
      await sock.sendMessage(chatId, { text: reply })
      return
    }

    // Fallback
    await sock.sendMessage(chatId, mainMenu(lang))
  })
}

startBot().catch(console.error)