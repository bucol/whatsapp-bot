/**
 * WhatsApp Bot – Production Ready (JS Only)
 * Compatible: Termux / VPS / Laptop
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys')

const Pino = require('pino')
const qrcode = require('qrcode-terminal')
const axios = require('axios')
const fs = require('fs-extra')
const path = require('path')

const PREFIX = '!'
const BOT_NAME = 'WA-BOT'

// ================= UTIL =================
const sleep = ms => new Promise(r => setTimeout(r, ms))

function isCommand(text) {
  return text.startsWith(PREFIX)
}

function getText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    ''
  )
}

// ================= AI =================
async function aiReply(prompt) {
  const apiKey = process.env.AI_API_KEY
  if (!apiKey) return 'AI belum dikonfigurasi.'

  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    }
  )

  return res.data.choices[0].message.content
}

// ================= MAIN =================
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./session')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: Pino({ level: 'silent' }),
    printQRInTerminal: true
  })

  sock.ev.on('creds.update', saveCreds)

  // ===== CONNECTION =====
  sock.ev.on('connection.update', update => {
    const { connection, lastDisconnect, qr } = update

    if (qr) qrcode.generate(qr, { small: true })

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      if (code !== DisconnectReason.loggedOut) {
        console.log('Reconnect...')
        startBot()
      } else {
        console.log('Session logout.')
      }
    }

    if (connection === 'open') {
      console.log(`✅ ${BOT_NAME} connected`)
    }
  })

  // ===== MESSAGE HANDLER =====
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return

    const chatId = msg.key.remoteJid
    const text = getText(msg).trim()
    if (!text) return

    // typing indicator
    await sock.sendPresenceUpdate('composing', chatId)

    // AUTO REPLY
    if (/^(halo|hai|hello)$/i.test(text)) {
      await sock.sendMessage(chatId, { text: `Halo 👋 gue ${BOT_NAME}` })
      return
    }

    // COMMAND
    if (isCommand(text)) {
      const [cmd, ...args] = text.slice(1).split(' ')
      const command = cmd.toLowerCase()

      switch (command) {
        case 'ping':
          await sock.sendMessage(chatId, { text: 'pong 🏓' })
          break

        case 'menu':
          await sock.sendMessage(chatId, {
            text: `
📜 *MENU*
!ping
!menu
!ai <teks>
`
          })
          break

        case 'ai':
          if (!args.length) {
            await sock.sendMessage(chatId, {
              text: 'Contoh: !ai jelaskan python'
            })
            break
          }
          const reply = await aiReply(args.join(' '))
          await sock.sendMessage(chatId, { text: reply })
          break

        default:
          await sock.sendMessage(chatId, { text: 'Command tidak dikenal ❌' })
      }
      return
    }

    // DEFAULT AI CHAT
    const reply = await aiReply(text)
    await sock.sendMessage(chatId, { text: reply })
  })
}

// ================= RUN =================
startBot().catch(console.error)