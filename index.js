/**
 * WhatsApp Bot – STEP B
 * Groq AI + Anti-Ban + Downloader (yt-dlp)
 */

require('dotenv').config()

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys')

const Pino = require('pino')
const axios = require('axios')
const readline = require('readline')
const fs = require('fs-extra')
const { exec } = require('child_process')

// ================= CONFIG =================
const PREFIX = '!'
const BOT_NAME = 'WA-BOT'
const DOWNLOAD_DIR = './downloads'

// GROQ MODELS (fallback)
const GROQ_MODELS = [
  'llama-3.1-8b-instant',
  'mixtral-8x7b-32768',
  'llama-3.1-70b-versatile'
]

// RATE LIMIT
const USER_COOLDOWN_MS = 3000
const MAX_REQUESTS_PER_MINUTE = 5

// HUMAN BEHAVIOR
const TYPING_DELAY_MIN = 800
const TYPING_DELAY_MAX = 1600
const GLOBAL_THROTTLE_MS = 700

// ================= STATE =================
const userCooldown = new Map()
const userRequests = new Map()
const chatQueues = new Map()
let lastGlobalSend = 0

// ================= SETUP =================
fs.ensureDirSync(DOWNLOAD_DIR)

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})
const ask = q => new Promise(r => rl.question(q, r))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a

// ================= RATE LIMIT =================
function isRateLimited(user) {
  const now = Date.now()

  if (userCooldown.has(user) && now - userCooldown.get(user) < USER_COOLDOWN_MS) {
    return { limited: true, reason: 'cooldown' }
  }

  const windowStart = now - 60000
  const history = userRequests.get(user) || []
  const recent = history.filter(t => t > windowStart)

  if (recent.length >= MAX_REQUESTS_PER_MINUTE) {
    return { limited: true, reason: 'rate' }
  }

  recent.push(now)
  userRequests.set(user, recent)
  userCooldown.set(user, now)
  return { limited: false }
}

// ================= AI =================
async function aiReply(prompt) {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) return 'AI belum dikonfigurasi.'

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
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      )
      return res.data.choices[0].message.content
    } catch {}
  }
  return '⚠️ AI sedang bermasalah.'
}

// ================= QUEUE =================
async function enqueue(chatId, task) {
  const q = chatQueues.get(chatId) || Promise.resolve()
  const next = q.then(async () => {
    const wait = Math.max(0, GLOBAL_THROTTLE_MS - (Date.now() - lastGlobalSend))
    if (wait) await sleep(wait)
    await task()
    lastGlobalSend = Date.now()
  })
  chatQueues.set(chatId, next.catch(() => {}))
}

// ================= DOWNLOADER =================
function runYtDlp(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) reject(stderr || err.message)
      else resolve(stdout)
    })
  })
}

async function downloadMedia(url, type = 'auto') {
  const id = Date.now()
  const out = `${DOWNLOAD_DIR}/${id}.%(ext)s`

  let format = ''
  if (type === 'audio') {
    format = '-x --audio-format mp3'
  } else if (type === 'video') {
    format = '-f mp4'
  }

  await runYtDlp(`yt-dlp ${format} -o "${out}" "${url}"`)
  const files = await fs.readdir(DOWNLOAD_DIR)
  const file = files.find(f => f.startsWith(String(id)))
  return `${DOWNLOAD_DIR}/${file}`
}

// ================= BOT =================
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./session')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    auth: state,
    version,
    logger: Pino({ level: 'silent' }),
    printQRInTerminal: false
  })

  sock.ev.on('creds.update', saveCreds)

  if (!state.creds.registered) {
    const phone = await ask('Masukkan nomor (62xxx): ')
    const code = await sock.requestPairingCode(phone)
    console.log(`🔑 Pairing Code: ${code}`)
    rl.close()
  }

  sock.ev.on('connection.update', u => {
    if (u.connection === 'open') console.log(`✅ ${BOT_NAME} connected`)
    if (u.connection === 'close') {
      const c = u.lastDisconnect?.error?.output?.statusCode
      if (c !== DisconnectReason.loggedOut) startBot()
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return

    const chatId = msg.key.remoteJid
    const sender = msg.key.participant || chatId
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ''

    if (!text) return
    const limit = isRateLimited(sender)
    if (limit.limited) {
      await enqueue(chatId, async () => {
        await sock.sendMessage(chatId, {
          text: limit.reason === 'cooldown'
            ? '⏳ Pelan-pelan ya 😄'
            : '🚦 Kebanyakan request.'
        })
      })
      return
    }

    await enqueue(chatId, async () => {
      await sock.sendPresenceUpdate('composing', chatId)
      await sleep(rand(TYPING_DELAY_MIN, TYPING_DELAY_MAX))

      // ===== COMMAND =====
      if (text.startsWith(PREFIX)) {
        const [cmd, url] = text.slice(1).split(' ')
        if (!url && ['dl','yta','ytv'].includes(cmd)) {
          await sock.sendMessage(chatId, { text: 'URL-nya mana?' })
          return
        }

        if (cmd === 'dl' || cmd === 'yta' || cmd === 'ytv') {
          await sock.sendMessage(chatId, { text: '⏬ Downloading...' })

          const type =
            cmd === 'yta' ? 'audio' :
            cmd === 'ytv' ? 'video' : 'auto'

          try {
            const file = await downloadMedia(url, type)
            await sock.sendMessage(chatId, {
              document: { url: file },
              fileName: file.split('/').pop()
            })
            await fs.remove(file)
          } catch (e) {
            await sock.sendMessage(chatId, {
              text: '❌ Gagal download.'
            })
          }
          return
        }

        if (cmd === 'ai') {
          const reply = await aiReply(text.slice(4))
          await sock.sendMessage(chatId, { text: reply })
          return
        }
      }

      const reply = await aiReply(text)
      await sock.sendMessage(chatId, { text: reply })
    })
  })
}

// ================= RUN =================
startBot().catch(console.error)