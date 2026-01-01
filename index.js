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

// ========== CONFIG ==========
const OWNER = '628xxxxxxxxx@s.whatsapp.net' // GANTI
const DOWNLOAD_DIR = './downloads'
const GROQ_MODEL = 'llama-3.1-8b-instant'

// ========== STATE ==========
const pendingChoice = new Map() // sender -> url
const activeDownloads = new Set()

fs.ensureDirSync(DOWNLOAD_DIR)

// ========== AI ==========
async function aiReply(text) {
  if (!process.env.GROQ_API_KEY) return 'AI belum dikonfigurasi.'

  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: text }],
      temperature: 0.7
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  )

  return res.data.choices[0].message.content
}

// ========== DOWNLOADER (NON-BLOCKING) ==========
function downloadAsync(url, type, done, fail) {
  const id = Date.now()
  const out = `${DOWNLOAD_DIR}/${id}.%(ext)s`

  let args = []
  if (type === 'audio') args = ['-x', '--audio-format', 'mp3']
  if (type === 'video') args = ['-f', 'mp4']

  args.push('-o', out, url)

  const proc = spawn('yt-dlp', args)

  proc.on('close', async code => {
    if (code !== 0) return fail()

    const file = (await fs.readdir(DOWNLOAD_DIR))
      .map(f => path.join(DOWNLOAD_DIR, f))
      .find(f => f.includes(id))

    done(file)
  })
}

// ========== BOT ==========
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
    if (u.connection === 'close') {
      if (u.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
        startBot()
      }
    }
  })

  // ===== MESSAGE HANDLER =====
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return

    const chatId = msg.key.remoteJid
    const sender = jidNormalizedUser(msg.key.participant || chatId)

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ''

    // ===== BUTTON RESPONSE =====
    if (msg.message.buttonsResponseMessage) {
      const id = msg.message.buttonsResponseMessage.selectedButtonId
      const url = pendingChoice.get(sender)

      if (!url) return

      if (activeDownloads.has(sender)) {
        await sock.sendMessage(chatId, { text: '⏳ Download masih berjalan.' })
        return
      }

      activeDownloads.add(sender)
      pendingChoice.delete(sender)

      await sock.sendMessage(chatId, { text: '⏬ Download dimulai...' })

      downloadAsync(
        url,
        id === 'audio' ? 'audio' : 'video',
        async file => {
          if (id === 'audio') {
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
          await sock.sendMessage(chatId, { text: '❌ Gagal download.' })
        }
      )

      return
    }

    // ===== LINK DETECT =====
    if (/https?:\/\/(www\.)?(youtube|youtu|tiktok|instagram)/i.test(text)) {
      pendingChoice.set(sender, text)

      await sock.sendMessage(chatId, {
        text: 'Pilih format download:',
        buttons: [
          { buttonId: 'video', buttonText: { displayText: '🎥 Video' }, type: 1 },
          { buttonId: 'audio', buttonText: { displayText: '🎵 Audio' }, type: 1 },
          { buttonId: 'cancel', buttonText: { displayText: '❌ Batal' }, type: 1 }
        ],
        headerType: 1
      })

      return
    }

    // ===== AI CHAT =====
    const reply = await aiReply(text)
    await sock.sendMessage(chatId, { text: reply })
  })
}

startBot().catch(console.error)