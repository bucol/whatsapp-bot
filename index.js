const { Boom } = require('@hapi/boom');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrTerminal = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const OpenAI = require('openai');
const winston = require('winston');
const i18n = require('i18n');
const schedule = require('node-schedule');
const express = require('express');
const CryptoJS = require('crypto-js');
const Stripe = require('stripe');

// === CONFIG API KEYS ===
const openai = new OpenAI({ apiKey: 'sk-your-openai-key-here' }); // Ganti kalau mau AI image generate
const stripe = Stripe('sk_test_your_stripe_test_key'); // Test mode gratis forever

// === DATABASE LOWDB OTOMATIS (fix untuk versi baru) ===
const dbAdapter = new JSONFile('db.json');
const db = new Low(dbAdapter, { users: {}, logs: [] }); // Default data wajib di sini!

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
    res.json({ users: Object.values(db.data.users), total_logs: db.data.logs.length });
});
app.listen(3000, () => console.log('Dashboard ready di http://localhost:3000/analytics'));

// === HELPER FUNCTIONS ===
async function randomDelay(min = 2000, max = 22000) {
    await delay(Math.floor(Math.random() * (max - min + 1)) + min);
}

async function sendWithHumanBehavior(sock, jid, msg) {
    await sock.presenceSubscribe(jid);
    await randomDelay(3000, 14000);
    const actions = ['composing', 'recording', 'paused', 'available'];
    const thinkingMsgs = ['Bentar ya bro, lagi mikir nih 🤔', 'Hmm oke, sabar sebentar!', 'Wih menarik, lagi proses dulu ya 😏', ''];
    const randomThink = thinkingMsgs[Math.floor(Math.random() * thinkingMsgs.length)];
    if (randomThink) await sock.sendMessage(jid, { text: randomThink });
    for (let i = 0; i < Math.floor(Math.random() * 5) + 1; i++) { // Switch presence kayak lagi distraksi
        await sock.sendPresenceUpdate(actions[Math.floor(Math.random() * actions.length)], jid);
        await randomDelay(4000, 12000);
    }
    await sock.sendMessage(jid, msg);
    await sock.sendPresenceUpdate(Math.random() > 0.4 ? 'paused' : 'available', jid);
}

async function saveUser(jid, updates = {}) {
    await db.read();
    db.data.users[jid] ||= { interactions: 0, downloads: 0, broadcasts: 0, lang: 'id', game_state: {}, reminders: [], custom_keywords: {} };
    Object.assign(db.data.users[jid], updates);
    db.data.users[jid].interactions = (db.data.users[jid].interactions || 0) + 1;
    await db.write();
}

function logAction(jid, action) {
    db.read().then(async () => {
        db.data.logs.push(CryptoJS.AES.encrypt(JSON.stringify({ jid, action, time: new Date() }), 'secret123').toString());
        await db.write();
    });
}

// === INIT DB & START BOT ===
async function startBot() {
    await db.read();
    await db.write(); // Pastiin file db.json dibuat otomatis
    console.log('Database db.json ready otomatis! Bot launching with max human-like vibes 🔥');

    const browsers = [
        ['Chrome (Linux)', '', '120.0'],
        ['Safari (iOS)', '', '17.0'],
        ['Firefox (Android)', '', '115.0'],
        ['Edge (Windows)', '', '120.0'],
        ['Opera (MacOS)', '', '100.0'],
        ['Brave (Linux)', '', '1.60']
    ];

    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: browsers[Math.floor(Math.random() * browsers.length)],
        markOnlineOnConnect: Math.random() > 0.3 // Kadang langsung online, kadang delay
    });

    sock.ev.on('qr', qr => {
        console.log('Scan QR cepet di WhatsApp kamu ya:');
        qrTerminal.generate(qr, { small: true });
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', update => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Putus koneksi, auto reconnect lagi...');
            if (reconnect) startBot();
        } else if (connection === 'open') {
            console.log('Bot nyala total! Human-like super natural, susah detect, powerfull abis 🚀');
        }
    });

    sock.ev.on('call', async calls => {
        for (const call of calls) {
            await sock.rejectCall(call.id, call.from);
            await sendWithHumanBehavior(sock, call.from, { text: 'Waduh maap nih bro, lagi ga bisa angkat call 📵 Kirim voice message aja, lebih seru!' });
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
                text: 'Halo bro! Lagi santai nih 😎 Menu clickable super keren ready:',
                buttons: [
                    { buttonId: 'sticker', buttonText: { displayText: 'Buat Sticker (.webp)' }, type: 1 },
                    { buttonId: 'game', buttonText: { displayText: 'Main Game Seru' }, type: 1 },
                    { buttonId: 'reminder', buttonText: { displayText: 'Set Reminder' }, type: 1 },
                    { buttonId: 'poll', buttonText: { displayText: 'Buat Poll' }, type: 1 },
                    { buttonId: 'ai_image', buttonText: { displayText: 'AI Gambar Keren' }, type: 1 }
                ]
            });
        } else if (text.startsWith('sticker') && msg.message.documentMessage?.mimetype === 'image/webp') {
            await sendWithHumanBehavior(sock, sender, { text: 'Mantap! Lagi bikin sticker nih...' });
            const buffer = await sock.downloadMediaMessage(msg);
            await sendWithHumanBehavior(sock, sender, { sticker: buffer });
        } else if (text.startsWith('generate ')) {
            await sendWithHumanBehavior(sock, sender, { text: 'Wih kreatif! Lagi generate AI image, tunggu bentar ya 🌈' });
            const prompt = text.slice(9);
            try {
                const response = await openai.images.generate({ model: 'dall-e-3', prompt, n: 1 });
                const imageUrl = response.data[0].url;
                await sendWithHumanBehavior(sock, sender, { image: { url: imageUrl }, caption: 'Boom! Hasilnya epic kan bro? 🔥' });
            } catch (e) {
                await sendWithHumanBehavior(sock, sender, { text: 'Ups, AI lagi istirahat nih. Coba lagi ya!' });
            }
        } else {
            const randomReplies = [
                'Yo apa kabar bro? Ada yang seru hari ini? 😄 Ketik "menu" yuk!',
                'Halo! Lagi mikir apa nih? Ketik "menu" buat fitur asik 😉',
                'Wih pesan masuk! Mau main apa hari ini? "menu" aja bro 🚀',
                'Hey there! Bot lagi mood bagus, ketik "menu" deh!'
            ];
            await sendWithHumanBehavior(sock, sender, { text: randomReplies[Math.floor(Math.random() * randomReplies.length)] });
        }
    });
}

startBot().catch(err => console.error('Error (seharusnya ga ada lagi):', err));