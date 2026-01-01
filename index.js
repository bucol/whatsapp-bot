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
const openai = new OpenAI({ apiKey: 'sk-your-openai-key-here' }); // Ganti dengan keymu
const stripe = Stripe('sk_test_your_stripe_test_key'); // Test mode gratis

// === DATABASE LOWDB OTOMATIS ===
const dbAdapter = new JSONFile('db.json');
const db = new Low(dbAdapter);

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
app.get('/analytics', async (req, res) => {
    await db.read();
    res.json({ users: Object.values(db.data?.users || {}), total_logs: db.data?.logs?.length || 0 });
});
app.listen(3000, () => console.log('Dashboard jalan di http://localhost:3000/analytics'));

// === HELPER FUNCTIONS ===
async function randomDelay(min = 2000, max = 18000) {
    await delay(Math.floor(Math.random() * (max - min + 1)) + min);
}

async function sendWithHumanBehavior(sock, jid, msg) {
    await sock.presenceSubscribe(jid);
    await randomDelay(2000, 10000);
    const actions = ['composing', 'recording', 'paused', 'available'];
    for (let i = 0; i < Math.floor(Math.random() * 3) + 1; i++) { // Kadang ganti presence tengah jalan
        await sock.sendPresenceUpdate(actions[Math.floor(Math.random() * actions.length)], jid);
        await randomDelay(3000, 8000);
    }
    await sock.sendMessage(jid, msg);
    await sock.sendPresenceUpdate('paused', jid);
}

async function saveUser(jid, updates = {}) {
    await db.read();
    db.data.users ||= {};
    db.data.users[jid] ||= { interactions: 0, downloads: 0, broadcasts: 0, lang: 'id', game_state: {}, reminders: [], custom_keywords: {} };
    Object.assign(db.data.users[jid], updates);
    db.data.users[jid].interactions = (db.data.users[jid].interactions || 0) + 1;
    await db.write();
}

function logAction(jid, action) {
    db.read().then(() => {
        db.data.logs ||= [];
        const encrypted = CryptoJS.AES.encrypt(JSON.stringify({ jid, action, time: new Date() }), 'secret123').toString();
        db.data.logs.push(encrypted);
        db.write();
    });
}

// === INIT DB & START BOT ===
async function startBot() {
    await db.read();
    db.data ||= { users: {}, logs: [] };
    await db.write();
    console.log('Database db.json otomatis siap! Bot starting...');

    const browsers = [
        ['Chrome (Linux)', '', ''],
        ['Safari (MacOS)', '', ''],
        ['Firefox (Windows)', '', ''],
        ['Edge (Android)', '', '']
    ];

    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: browsers[Math.floor(Math.random() * browsers.length)],
    });

    sock.ev.on('qr', qr => {
        console.log('Scan QR ini di WhatsApp kamu:');
        qrTerminal.generate(qr, { small: true });
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', update => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (reconnect) startBot();
        } else if (connection === 'open') {
            console.log('Bot connected! Powerfull, human-like, dan susah detect siap beraksi 🔥');
        }
    });

    sock.ev.on('call', async calls => {
        for (const call of calls) {
            await sock.rejectCall(call.id, call.from);
            await sendWithHumanBehavior(sock, call.from, { text: 'Wah sorry bro, bot lagi ga bisa angkat call nih. Kirim voice message aja ya, aku transkrip!' });
        }
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').toLowerCase().trim();

        await saveUser(sender);
        logAction(sender, text);

        if (text === 'menu') {
            await sendWithHumanBehavior(sock, sender, {
                text: 'Halo! Botku lagi online nih 😎 Pilih menu di bawah ya:',
                buttons: [
                    { buttonId: 'sticker', buttonText: { displayText: 'Buat Sticker' }, type: 1 },
                    { buttonId: 'game', buttonText: { displayText: 'Main Game' }, type: 1 },
                    { buttonId: 'reminder', buttonText: { displayText: 'Set Reminder' }, type: 1 },
                    { buttonId: 'poll', buttonText: { displayText: 'Buat Poll' }, type: 1 },
                    { buttonId: 'ai_image', buttonText: { displayText: 'Generate Gambar AI' }, type: 1 }
                ]
            });
        } else if (text.startsWith('sticker') && msg.message.imageMessage) {
            await sendWithHumanBehavior(sock, sender, { text: 'Bentar ya, lagi bikin sticker...' });
            const buffer = await sock.downloadMediaMessage(msg);
            const stickerBuffer = await sharp(buffer).webp().toBuffer();
            await sendWithHumanBehavior(sock, sender, { sticker: stickerBuffer });
        } else if (text.startsWith('generate ')) {
            await sendWithHumanBehavior(sock, sender, { text: 'Oke, lagi generate gambar AI nih... Sabar ya!' });
            const prompt = text.slice(9);
            const response = await openai.images.generate({ model: 'dall-e-3', prompt, n: 1 });
            const imageUrl = response.data[0].url;
            await sendWithHumanBehavior(sock, sender, { image: { url: imageUrl }, caption: 'Nih hasilnya! Keren kan? 🔥' });
        } else {
            await sendWithHumanBehavior(sock, sender, { text: 'Halo bro! Ada yang bisa aku bantu? Ketik "menu" buat liat opsi lengkap ya 😉' });
        }
    });
}

startBot().catch(err => console.error('Error fatal:', err));