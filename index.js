/**
 * WhatsApp Bot – Pairing Code + Downloader
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
const { exec } = require('child_process')
const path = require('path')
require('dotenv').config()
const PREFIX = '!'
const BOT_NAME = 'WA-BOT'
const DOWNLOAD_DIR = './downloads'

// ================= UTIL =================
fs.ensureDirSync(DOWNLOAD_DIR)

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

const ask = q => new Promise(r => rl.question(q, r))

const sleep = ms => new Promise(r => setTimeout(r, ms))

const getText = msg =>
  msg.message?.conversation ||
  msg.message?.extendedTextMessage?.text ||
  ''

const isUrl = text => /(https?:\/\/[^\s]+)/i.test(text)

// ================= AI =================
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

// ================= DOWNLOADER =================
function runYtDlp(url, audio = false) {
  return new Promise((resolve, reject) => {
    const output = path.join(
      DOWNLOAD_DIR,
      `${Date.now()}.%(ext)s`
    )

    const cmd = audio
      ? `yt-dlp -x --audio-format mp3 -o "${output}" "${url}"`
      : `yt-dlp -f mp4 -o "${output}" "${url}"`

    exec(cmd, (err, stdout, stderr) => {
      if (err) return reject(stderr)
      resolve(fs.readdirSync(DOWNLOAD_DIR).pop())
    })
  })
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

  // 🔑 Pairing Code
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
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      if (code !== DisconnectReason.loggedOut) startBot()
      else console.log('Session logout.')
    }
  })

  // MESSAGE
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return

    const chatId = msg.key.remoteJid
    const text = getText(msg).trim()
    if (!text) return

    await sock.sendPresenceUpdate('composing', chatId)

    // AUTO LINK DOWNLOAD
    if (isUrl(text)) {
      await sock.sendMessage(chatId, { text: '⏳ Downloading...' })
      try {
        const file = await runYtDlp(text)
        await sock.sendMessage(chatId, {
          document: fs.readFileSync(path.join(DOWNLOAD_DIR, file)),
          fileName: file,
          mimetype: 'video/mp4'
        })
      } catch {
        await sock.sendMessage(chatId, { text: '❌ Gagal download' })
      }
      return
    }

    // COMMAND
    if (text.startsWith(PREFIX)) {
      const [cmd, ...args] = text.slice(1).split(' ')
      const url = args[0]

      switch (cmd.toLowerCase()) {
        case 'yt':
        case 'dl':
          await sock.sendMessage(chatId, { text: '⏳ Download video...' })
          try {
            const file = await runYtDlp(url)
            await sock.sendMessage(chatId, {
              document: fs.readFileSync(path.join(DOWNLOAD_DIR, file)),
              fileName: file,
              mimetype: 'video/mp4'
            })
          } catch {
            await sock.sendMessage(chatId, { text: '❌ Gagal download' })
          }
          break

        case 'mp3':
          await sock.sendMessage(chatId, { text: '🎵 Download audio...' })
          try {
            const file = await runYtDlp(url, true)
            await sock.sendMessage(chatId, {
              document: fs.readFileSync(path.join(DOWNLOAD_DIR, file)),
              fileName: file,
              mimetype: 'audio/mpeg'
            })
          } catch {
            await sock.sendMessage(chatId, { text: '❌ Gagal download' })
          }
          break

        case 'ai':
          const reply = await aiReply(args.join(' '))
          await sock.sendMessage(chatId, { text: reply })
          break

        case 'menu':
          await sock.sendMessage(chatId, {
            text: `
📜 *MENU*
!yt <url>
!mp3 <url>
!dl <url>
!ai <teks>
`
          })
          break

        default:
          await sock.sendMessage(chatId, { text: 'Command tidak dikenal ❌' })
      }
      return
    }

    // DEFAULT AI
    const reply = await aiReply(text)
    await sock.sendMessage(chatId, { text: reply })
  })
}

startBot().catch(console.error)