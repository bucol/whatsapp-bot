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
const PREFIX = '!'
const OWNER = '628xxxxxxxxx@s.whatsapp.net' // ganti
const DOWNLOAD_DIR = './downloads'
const GROQ_MODEL = 'llama-3.1-8b-instant'

// ================= STATE =================
const activeDownloads = new Set()
const groupSettings = new Map() // groupId -> config

fs.ensureDirSync(DOWNLOAD_DIR)

// ================= UTILS =================
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function aiReply(prompt) {
  if (!process.env.GROQ_API_KEY) return 'AI belum dikonfigurasi.'

  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: prompt }],
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

// ================= NON-BLOCKING DOWNLOAD =================
function downloadAsync(url, type, onDone, onError) {
  const id = Date.now()
  const out = `${DOWNLOAD_DIR}/${id}.%(ext)s`

  let args = []
  if (type === 'audio') args = ['-x', '--audio-format', 'mp3']
  if (type === 'video') args = ['-f', 'mp4']

  args.push('-o', out, url)

  const proc = spawn('yt-dlp', args)

  proc.on('close', async code => {
    if (code !== 0) return onError()

    const file = (await fs.readdir(DOWNLOAD_DIR))
      .map(f => path.join(DOWNLOAD_DIR, f))
      .find(f => f.includes(id))

    onDone(file)
  })
}

// ================= GROUP MODERATION =================
function defaultGroupConfig() {
  return {
    antiLink: true,
    welcome: true,
    goodbye: true
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
    if (u.connection === 'open') console.log('✅ BOT CONNECTED')
    if (u.connection === 'close') {
      if (u.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
        startBot()
      }
    }
  })

  // ===== GROUP EVENTS =====
  sock.ev.on('group-participants.update', async ev => {
    const cfg = groupSettings.get(ev.id) || defaultGroupConfig()

    for (const user of ev.participants) {
      if (ev.action === 'add' && cfg.welcome) {
        await sock.sendMessage(ev.id, {
          text: `👋 Welcome @${user.split('@')[0]}!`,
          mentions: [user]
        })
      }

      if (ev.action === 'remove' && cfg.goodbye) {
        await sock.sendMessage(ev.id, {
          text: `👋 Bye @${user.split('@')[0]}`,
          mentions: [user]
        })
      }
    }
  })

  // ===== MESSAGE HANDLER =====
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return

    const chatId = msg.key.remoteJid
    const isGroup = chatId.endsWith('@g.us')
    const sender = jidNormalizedUser(msg.key.participant || chatId)

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ''

    // ===== ANTI LINK =====
    if (isGroup) {
      const cfg = groupSettings.get(chatId) || defaultGroupConfig()
      groupSettings.set(chatId, cfg)

      if (cfg.antiLink && /https?:\/\//i.test(text)) {
        await sock.sendMessage(chatId, {
          delete: msg.key
        })
        await sock.sendMessage(chatId, {
          text: '❌ Link dilarang di grup ini.'
        })
        return
      }
    }

    // ===== COMMAND =====
    if (text.startsWith(PREFIX)) {
      const [cmd, arg] = text.slice(1).split(' ')

      // === DOWNLOADER ===
      if (['dl', 'yta', 'ytv'].includes(cmd)) {
        if (activeDownloads.has(sender)) {
          await sock.sendMessage(chatId, {
            text: '⏳ Download kamu masih diproses, tunggu ya.'
          })
          return
        }

        if (!arg) {
          await sock.sendMessage(chatId, { text: 'URL-nya mana?' })
          return
        }

        activeDownloads.add(sender)

        await sock.sendMessage(chatId, { text: '⏬ Download dimulai...' })

        downloadAsync(
          arg,
          cmd === 'yta' ? 'audio' : 'video',
          async file => {
            if (!file) throw new Error()

            if (cmd === 'yta') {
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
    }

    // ===== AI CHAT =====
    const reply = await aiReply(text)
    await sock.sendMessage(chatId, { text: reply })
  })
}

startBot().catch(console.error)