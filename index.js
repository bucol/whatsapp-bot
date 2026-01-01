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
const openai = new OpenAI({ apiKey: 'sk-your-openai-key-here' }); // Ganti kalau mau pakai AI image
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
app.listen(3000, () => console.log('Dashboard jalan di http://localhost:3000/analytics (buka di browser laptop/VPS)'));

// === HELPER FUNCTIONS ===
async function randomDelay(min = 2000, max = 20000) {
    await delay(Math.floor(Math.random() * (max - min + 1)) + min);
}

async function sendWithHumanBehavior(sock, jid, msg) {
    await sock.presenceSubscribe(jid);
    await randomDelay(2000, 12000);
    const actions = ['composing', 'recording', 'paused', 'available'];
    const randomPhrases = ['Wah bentar ya, lagi proses nih...', 'Hmm, aku mikir dulu 😏', 'Oke, sabar sebentar!'];
    if (Math.random() > 0.5) await sock.sendMessage(jid, { text: randomPhrases[Math.floor(Math.random() * randomPhrases.length)] });
    for (let i = 0; i < Math.floor(Math.random() * 4) + 1; i++) {
        await sock.sendPresenceUpdate(actions[Math.floor(Math.random() * actions.length)], jid);
        await randomDelay(4000, 10000);
    }
    await sock.sendMessage(jid, msg);
    await sock.sendPresenceUpdate(Math.random() > 0.5 ? 'paused' : 'available', jid);
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
    console.log('Database db.json otomatis ready! Bot launching with full human-like power 🔥');

    const browsers = [
        ['Chrome (Linux)', '', '89.0'],
        ['Safari (MacOS)', '', '15.0'],
        ['Firefox (Windows)', '', '90.0'],
        ['Edge (Android)', '', '95.0'],
        ['Opera (Linux)', '', '80.0']
    ];

    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: browsers[Math.floor(Math.random() * browsers.length)],
        markOnlineOnConnect: Math.random() > 0.5 // Kadang online/kadang tidak langsung
    });

    sock.ev.on('qr', qr => {
        console.log('Scan QR cepat di WhatsApp kamu:');
        qrTerminal.generate(qr, { small: true });
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', update => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi putus, reconnect otomatis...');
            if (reconnect) startBot();
        } else if (connection === 'open') {
            console.log('Bot nyala full power! Human-like mode aktif, susah detect banget 😎');
        }
    });

    sock.ev.on('call', async calls => {
        for (const call of calls) {
            await sock.rejectCall(call.id, call.from);
            await sendWithHumanBehavior(sock, call.from, { text: 'Maap banget nih, bot lagi sibuk ga bisa angkat call 📞 Kirim voice message aja ya, lebih asik!' });
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
                text: 'Yo bro! Botku lagi mood bagus nih 😄 Pilih menu clickable di bawah ya:',
                buttons: [
                    { buttonId: 'sticker', buttonText: { displayText: 'Buat Sticker (kirim .webp)' }, type: 1 },
                    { buttonId: 'game', buttonText: { displayText: 'Main Game Mini' }, type: 1 },
                    { buttonId: 'reminder', buttonText: { displayText: 'Set Reminder' }, type: 1 },
                    { buttonId: 'poll', buttonText: { displayText: 'Buat Poll' }, type: 1 },
                    { buttonId: 'ai_image', buttonText: { displayText: 'Generate Gambar AI' }, type: 1 }
                ]
            });
        } else if (text.startsWith('sticker') && msg.message.documentMessage?.mimetype === 'image/webp') {
            // Sticker manual tanpa convert (kirim file .webp)
            const buffer = await sock.downloadMediaMessage(msg);
            await sendWithHumanBehavior(sock, sender, { sticker: buffer });
        } else if (text.startsWith('generate ')) {
            await sendWithHumanBehavior(sock, sender, { text: 'Keren requestnya! Lagi generate gambar AI, sabar bentar ya 🌟' });
            const prompt = text.slice(9);
            try {
                const response = await openai.images.generate({ model: 'dall-e-3', prompt, n: 1 });
                const imageUrl = response.data[0].url;
                await sendWithHumanBehavior(sock, sender, { image: { url: imageUrl }, caption: 'Nih hasilnya bro! Mantap kan? 🚀' });
            } catch (e) {
                await sendWithHumanBehavior(sock, sender, { text: 'Waduh, AI lagi capek nih. Coba lagi nanti ya!' });
            }
        } else {
            const randomReplies = [
                'Halo bro! Lagi apa nih hari ini? 😎 Ketik "menu" buat opsi seru!',
                'Yo! Ada yang bisa aku bantu? Ketik "menu" yuk 😉',
                'Wih, pesan masuk! Ketik "menu" buat liat fitur kerenku ya 🔥'
            ];
            await sendWithHumanBehavior(sock, sender, { text: randomReplies[Math.floor(Math.random() * randomReplies.length)] });
        }
    });
}

startBot().catch(err => console.error('Error fatal (harusnya ga ada lagi):', err));