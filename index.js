/**
 * WhatsApp Bot – Groq AI
 * STEP A COMPLETE:
 * - Auto fallback model
 * - Rate limit + cooldown
 * - Message queue
 * - Human-like typing delay
 * - Global throttle
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

// ================= CONFIG =================
const PREFIX = '!'
const BOT_NAME = 'WA-BOT'

// GROQ MODEL PRIORITY
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

// ================= INPUT =================
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})
const ask = q => new Promise(r => rl.question(q, r))

// ================= UTIL =================
const sleep = ms => new Promise(r => setTimeout(r, ms))

function randomTypingDelay() {
  return (
    Math.floor(
      Math.random() * (TYPING_DELAY_MAX - TYPING_DELAY_MIN + 1)
    ) + TYPING_DELAY_MIN
  )
}

// ================= RATE LIMIT =================
function isRateLimited(user) {
  const now = Date.now()

  if (userCooldown.has(user)) {
    if (now - userCooldown.get(user) < USER_COOLDOWN_MS) {
      return { limited: true, reason: 'cooldown' }
    }
  }

  const windowStart = now - 60_000
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

// ================= AI (GROQ + FALLBACK) =================
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

      console.log(`🤖 AI model used: ${model}`)
      return res.data.choices[0].message.content
    } catch (err) {
      console.error(
        `⚠️ ${model} failed:`,
        err.response?.data?.error?.code || err.message
      )
    }
  }

  return '⚠️ Semua model AI sedang bermasalah.'
}

// ================= QUEUE HANDLER =================
async function enqueueMessage(chatId, task) {
  const queue = chatQueues.get(chatId) || Promise.resolve()

  const next = queue.then(async () => {
    const now = Date.now()
    const wait = Math.max(0, GLOBAL_THROTTLE_MS - (now - lastGlobalSend))
    if (wait > 0) await sleep(wait)

    await task()
    lastGlobalSend = Date.now()
  })

  chatQueues.set(chatId, next.catch(() => {}))
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

  // PAIRING
  if (!state.creds.registered) {
    const phone = await ask('Masukkan nomor (62xxx): ')
    const code = await sock.requestPairingCode(phone)
    console.log(`\n🔑 Pairing Code: ${code}\n`)
    rl.close()
  }

  // CONNECTION
  sock.ev.on('connection.update', u => {
    if (u.connection === 'open') {
      console.log(`✅ ${BOT_NAME} connected`)
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode
      if (code !== DisconnectReason.loggedOut) startBot()
    }
  })

  // MESSAGE HANDLER
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
      const warn =
        limit.reason === 'cooldown'
          ? '⏳ Pelan-pelan ya 😄'
          : '🚦 Kebanyakan request, tunggu sebentar.'
      await enqueueMessage(chatId, async () => {
        await sock.sendMessage(chatId, { text: warn })
      })
      return
    }

    await enqueueMessage(chatId, async () => {
      await sock.sendPresenceUpdate('composing', chatId)
      await sleep(randomTypingDelay())

      if (/^(halo|hai|hello|oi|oii+)$/i.test(text)) {
        await sock.sendMessage(chatId, { text: `Halo 👋 gue ${BOT_NAME}` })
        return
      }

      if (text.startsWith(PREFIX)) {
        const [cmd, ...args] = text.slice(1).split(' ')
        const c = cmd.toLowerCase()

        if (c === 'ping') {
          await sock.sendMessage(chatId, { text: 'pong 🏓' })
          return
        }

        if (c === 'menu') {
          await sock.sendMessage(chatId, {
            text: `
📜 *MENU*
!ping
!menu
!ai <teks>
`
          })
          return
        }

        if (c === 'ai') {
          if (!args.length) {
            await sock.sendMessage(chatId, {
              text: 'Contoh: !ai jelasin nodejs'
            })
            return
          }
          const reply = await aiReply(args.join(' '))
          await sock.sendMessage(chatId, { text: reply })
          return
        }

        await sock.sendMessage(chatId, { text: 'Command tidak dikenal ❌' })
        return
      }

      const reply = await aiReply(text)
      await sock.sendMessage(chatId, { text: reply })
    })
  })
}

// ================= RUN =================
startBot().catch(err => console.error('❌ FATAL:', err))