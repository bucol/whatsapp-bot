/**
 * WhatsApp Bot – Pairing Code Mode
 * Termux / VPS / Laptop SAFE
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys')

const Pino = require('pino')
const axios = require('axios')
const fs = require('fs-extra')
const readline = require('readline')

const PREFIX = '!'
const BOT_NAME = 'WA-BOT'

// ================== INPUT ==================
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

const ask = q => new Promise(res => rl.question(q, res))

// ================== AI ==================
async function aiReply(prompt) {
  const apiKey = process.env.AI_API_KEY
  if (!apiKey) return 'AI belum dikonfigurasi.'

  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }]
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

// ================== BOT ==================
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

  // ===== CONNECTION =====
  sock.ev.on('connection.update', update => {
    const { connection, lastDisconnect } = update

    if (connection === 'open') {
      console.log(`✅ ${BOT_NAME} connected`)
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      if (code !== DisconnectReason.loggedOut) {
        console.log('Reconnect...')
        startBot()
      } else {
        console.log('Session logout, hapus folder session.')
      }
    }
  })

  // ===== MESSAGE HANDLER =====
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return

    const chatId = msg.key.remoteJid
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ''

    if (!text) return

    await sock.sendPresenceUpdate('composing', chatId)

    // AUTO REPLY
    if (/^(halo|hai|hello)$/i.test(text)) {
      await sock.sendMessage(chatId, { text: `Halo 👋 gue ${BOT_NAME}` })
      return
    }

    // COMMAND
    if (text.startsWith(PREFIX)) {
      const [cmd, ...args] = text.slice(1).split(' ')
      switch (cmd.toLowerCase()) {
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
          await sock.sendMessage(chatId, {
            text: 'Command tidak dikenal ❌'
          })
      }
      return
    }

    // DEFAULT AI
    const reply = await aiReply(text)
    await sock.sendMessage(chatId, { text: reply })
  })
}

// ================== RUN ==================
startBot().catch(console.error)