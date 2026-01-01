/**
 * WhatsApp Bot – Groq AI
 * Auto Fallback Model + Rate Limit + Cooldown
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

// 🔁 GROQ MODEL PRIORITY
const GROQ_MODELS = [
  'llama-3.1-8b-instant',
  'mixtral-8x7b-32768',
  'llama-3.1-70b-versatile'
]

// ⏱️ RATE LIMIT CONFIG
const USER_COOLDOWN_MS = 3000          // 3 detik
const MAX_REQUESTS_PER_MINUTE = 5

// ================= STATE =================
const userCooldown = new Map()         // userJid -> lastTimestamp
const userRequests = new Map()         // userJid -> [timestamps]

// ================= INPUT =================
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})
const ask = q => new Promise(r => rl.question(q, r))

// ================= RATE LIMIT =================
function isRateLimited(user) {
  const now = Date.now()

  // Cooldown
  if (userCooldown.has(user)) {
    const last = userCooldown.get(user)
    if (now - last < USER_COOLDOWN_MS) {
      return { limited: true, reason: 'cooldown' }
    }
  }

  // Per-minute limit
  const windowStart = now - 60_000
  const history = userRequests.get(user) || []
  const recent = history.filter(ts => ts > windowStart)

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

      console.log(`🤖 AI reply using: ${model}`)
      return res.data.choices[0].message.content
    } catch (err) {
      console.error(
        `⚠️ Model ${model} failed:`,
        err.response?.data?.error?.code || err.message
      )
    }
  }

  return '⚠️ Semua model AI sedang bermasalah.'
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

  // 🔑 PAIRING CODE
  if (!state.creds.registered) {
    const phone = await ask('Masukkan nomor (62xxx): ')
    const code = await sock.requestPairingCode(phone)
    console.log(`\n🔑 Pairing Code: ${code}\n`)
    rl.close()
  }

  // CONNECTION
  sock.ev.on('connection.update', update => {
    const { connection, lastDisconnect } = update

    if (connection === 'open') {
      console.log(`✅ ${BOT_NAME} connected`)
      console.log(`🤖 Models: ${GROQ_MODELS.join(', ')}`)
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      if (code !== DisconnectReason.loggedOut) {
        console.log('🔁 Reconnecting...')
        startBot()
      } else {
        console.log('❌ Session logout, hapus folder session.')
      }
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
      const reply =
        limit.reason === 'cooldown'
          ? '⏳ Pelan-pelan bro 😄'
          : '🚦 Kebanyakan request, tunggu 1 menit ya.'
      await sock.sendMessage(chatId, { text: reply })
      return
    }

    await sock.sendPresenceUpdate('composing', chatId)

    // AUTO REPLY
    if (/^(halo|hai|hello|oi|oii+)$/i.test(text)) {
      await sock.sendMessage(chatId, {
        text: `Halo 👋 gue ${BOT_NAME}`
      })
      return
    }

    // COMMAND
    if (text.startsWith(PREFIX)) {
      const [cmd, ...args] = text.slice(1).split(' ')
      const command = cmd.toLowerCase()

      if (command === 'ping') {
        await sock.sendMessage(chatId, { text: 'pong 🏓' })
        return
      }

      if (command === 'menu') {
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

      if (command === 'ai') {
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

      await sock.sendMessage(chatId, {
        text: 'Command tidak dikenal ❌'
      })
      return
    }

    // DEFAULT AI CHAT
    const reply = await aiReply(text)
    await sock.sendMessage(chatId, { text: reply })
  })
}

// ================= RUN =================
startBot().catch(err => {
  console.error('❌ FATAL ERROR:', err)
})