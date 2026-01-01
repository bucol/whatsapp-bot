const { Boom } = require('@hapi/boom');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrTerminal = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const OpenAI = require('openai');
const sharp = require('sharp');
const winston = require('winston');
const i18n = require('i18n');
const schedule = require('node-schedule');
const express = require('express');
const CryptoJS = require('crypto-js');
const Stripe = require('stripe');

// === CONFIG API KEYS ===
const openai = new OpenAI({ apiKey: 'sk-your-openai-key-here' });
const stripe = Stripe('sk_test_your_stripe_test_key');

// === DATABASE LOWDB OTOMATIS (pure JSON) ===
const dbAdapter = new JSONFile('db.json');
const db = new Low(dbAdapter);
await db.read();
db.data ||= { users: {}, logs: [] }; // Init kalau file baru
await db.write();
console.log('Database db.json siap otomatis!');

// === I18N & LOGGER ===
i18n.configure({
    locales: ['id', 'en'],
    directory: __dirname + '/locales',
    defaultLocale: 'id'
});

const logger = winston.createLogger({
    transports: [new winston.transports.File({ filename: 'logs.enc' })]
});

// === FOLDER & DASHBOARD ===
if (!fs.existsSync('./downloads')) fs.mkdirSync('./downloads');
const app = express();
app.get('/analytics', (req, res) => {
    res.json({ users: Object.values(db.data.users), total_logs: db.data.logs.length });
});
app.listen(3000, () => console.log('Dashboard: http://localhost:3000/analytics'));

// === HELPER FUNCTIONS ===
async function randomDelay(min = 2000, max = 15000) {
    await delay(Math.floor(Math.random() * (max - min + 1)) + min);
}

async function sendWithHumanBehavior(sock, jid, msg) {
    await sock.presenceSubscribe(jid);
    await randomDelay(2000, 8000);
    const actions = ['composing', 'recording', 'paused'];
    await sock.sendPresenceUpdate(actions[Math.floor(Math.random() * actions.length)], jid);
    await randomDelay(4000, 12000);
    await sock.sendMessage(jid, msg);
    await sock.sendPresenceUpdate('paused', jid);
}

async function saveUser(jid, updates) {
    db.data.users[jid] ||= { interactions: 0, downloads: 0, broadcasts: 0, lang: 'id', game_state: {}, reminders: [], custom_keywords: {} };
    Object.assign(db.data.users[jid], updates);
    db.data.users[jid].interactions = (db.data.users[jid].interactions || 0) + 1;
    await db.write();
}

function logAction(jid, action) {
    const encrypted = CryptoJS.AES.encrypt(JSON.stringify({ jid, action, time: new Date() }), 'secret123').toString();
    db.data.logs.push(encrypted);
    await db.write();
}

// === CONNECT TO WHATSAPP ===
async function connectToWhatsApp() {
    const browsers = [
        ['Chrome (Linux)', '', ''],
        ['Safari (MacOS)', '', ''],
        ['Firefox (Windows)', '', '']
    ];
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: browsers[Math.floor(Math.random() * browsers.length)],
    });

    sock.ev.on('qr', qr => {
        console.log('Scan QR ini di WhatsApp:');
        qrTerminal.generate(qr, { small: true });
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', update => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (reconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('Bot connected! Super powerful & human-like siap jalan.');
        }
    });

    // Call handling
    sock.ev.on('call', async calls => {
        for (const call of calls) {
            await sock.rejectCall(call.id, call.from);
            await sendWithHumanBehavior(sock, call.from, { text: 'Sorry ya, bot nggak bisa angkat call. Kirim voice message aja!' });
        }
    });

    // Messages handler
    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').toLowerCase().trim();

        await saveUser(sender, {});
        logAction(sender, text);

        if (text === 'menu') {
            await sendWithHumanBehavior(sock, sender, {
                text: 'Halo bro! Menu bot super lengkap nih:',
                buttons: [
                    { buttonId: 'sticker', buttonText: { displayText: 'Buat Sticker' }, type: 1 },
                    { buttonId: 'game', buttonText: { displayText: 'Main Game' }, type: 1 },
                    { buttonId: 'reminder', buttonText: { displayText: 'Set Reminder' }, type: 1 },
                    { buttonId: 'poll', buttonText: { displayText: 'Buat Poll' }, type: 1 },
                    { buttonId: 'ai_image', buttonText: { displayText: 'Generate Gambar AI' }, type: 1 }
                ]
            });
        } else if (text.startsWith('sticker') && msg.message.imageMessage) {
            const buffer = await sock.downloadMediaMessage(msg);
            const stickerBuffer = await sharp(buffer).webp().toBuffer();
            await sendWithHumanBehavior(sock, sender, { sticker: stickerBuffer });
        } else if (text.startsWith('generate ')) {
            const prompt = text.slice(9);
            const response = await openai.images.generate({ model: 'dall-e-3', prompt, n: 1 });
            const imageUrl = response.data[0].url;
            await sendWithHumanBehavior(sock, sender, { image: { url: imageUrl }, caption: 'Ini gambar AI sesuai requestmu!' });
        } else {
            await sendWithHumanBehavior(sock, sender, { text: 'Halo! Ada yang bisa dibantu? Ketik "menu" buat opsi lengkap ya 😊' });
        }
    });

    return sock;
}

connectToWhatsApp().catch(err => console.error('Error fatal:', err));