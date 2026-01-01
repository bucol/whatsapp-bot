require('dotenv').config()

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys')

const Pino = require('pino')

// ================= CONFIG =================
const BOT_NAME = 'WhatsappBotGro'

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
    if (u.connection === 'close' &&
        u.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
      startBot()
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return

    const chatId = msg.key.remoteJid

    await sock.sendMessage(chatId, {
      text: `Halo 👋 gue ${BOT_NAME}`,
      footer: BOT_NAME,
      title: 'Menu Utama',
      buttonText: 'Buka Menu',
      sections: [
        {
          title: 'Fitur',
          rows: [
            { title: '🤖 AI Chat', rowId: 'AI' },
            { title: '⬇️ Downloader', rowId: 'DL' },
            { title: '🧰 Tools', rowId: 'TOOLS' }
          ]
        }
      ]
    })
  })
}

startBot().catch(console.error)