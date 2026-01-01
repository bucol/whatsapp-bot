/**
 * WhatsApp Bot – STEP B FIXED
 * Groq AI + Anti-Ban + Downloader (yt-dlp)
 * FIX: Proper MIME (video/audio) – no more PDF
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
const path = require('path')

// ================= CONFIG =================
const PREFIX = '!'
const BOT_NAME = 'WA-BOT'
const DOWNLOAD_DIR = './downloads'

// GROQ MODELS
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
function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err) => (err ? reject(err) : resolve()))
  })
}

async function downloadMedia(url, type) {
  const id = Date.now()
  const out = `${DOWNLOAD_DIR}/${id}.%(ext)s`

  let flags = ''
  if (type === 'audio') flags = '-x --audio-format mp3'
  if (type === 'video') flags = '-f mp4'

  await run(`yt-dlp ${flags} -o "${out}" "${url}"`)
  const file = (await fs.readdir(DOWNLOAD_DIR))
    .map(f => path.join(DOWNLOAD_DIR, f))
    .find(f => f.includes(id))

  return file
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
    if (isRateLimited(sender).limited) return

    await enqueue(chatId, async () => {
      await sock.sendPresenceUpdate('composing', chatId)
      await sleep(rand(TYPING_DELAY_MIN, TYPING_DELAY_MAX))

      if (text.startsWith(PREFIX)) {
        const [cmd, url] = text.slice(1).split(' ')
        if (['dl','yta','ytv'].includes(cmd)) {
          if (!url) {
            await sock.sendMessage(chatId, { text: 'URL-nya mana?' })
            return
          }

          await sock.sendMessage(chatId, { text: '⏬ Downloading...' })

          const type = cmd === 'yta' ? 'audio' : 'video'
          try {
            const file = await downloadMedia(url, type)
            const ext = path.extname(file)

            if (type === 'audio') {
              await sock.sendMessage(chatId, {
                audio: { url: file },
                mimetype: 'audio/mpeg'
              })
            } else {
              await sock.sendMessage(chatId, {
                video: { url: file },
                mimetype: `video/${ext.replace('.', '')}`
              })
            }

            await fs.remove(file)
          } catch {
            await sock.sendMessage(chatId, { text: '❌ Gagal download.' })
          }
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