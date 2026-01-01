const { Boom } = require('@hapi/boom');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrTerminal = require('qrcode-terminal');
const fs = require('fs');

// Database sederhana JSON
let db = {};
const dbFile = './db.json';
if (fs.existsSync(dbFile)) {
    db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
} else {
    db = { users: {} }; // Init struktur: users[sender] = { custom: 'data' }
    fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));
}
function saveDB() {
    fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));
}

// Fungsi retry send dengan error handling
async function sendMessageWithRetry(sock, jid, message, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await sock.sendMessage(jid, message);
            return; // Sukses, keluar
        } catch (err) {
            console.error(`Gagal kirim ke ${jid} (attempt ${attempt}):`, err);
            if (attempt === retries) throw err; // Gagal total
            await delay(Math.pow(2, attempt) * 1000 + Math.random() * 2000); // Exponential backoff + random 1-3 detik
        }
    }
}

// Fungsi untuk connect ke WhatsApp
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }), // Silent logger biar ga banjir log
        printQRInTerminal: false, // Kita handle QR manual
        auth: state,
        browser: ['Chrome (Linux)', '', ''], // Fake browser biar susah detect
        syncFullHistory: false, // Hemat data
    });

    // Generate dan tampilkan QR
    sock.ev.on('qr', (qr) => {
        console.log('Scan QR ini di WhatsApp kamu:');
        qrTerminal.generate(qr, { small: true });
    });

    // Handle update creds
    sock.ev.on('creds.update', saveCreds);

    // Handle connection update
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus:', lastDisconnect?.error, 'Reconnect?', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('Bot connected! Siap jalan.');
        }
    });

    // Auto-welcome untuk group (join member atau bot join)
    sock.ev.on('group-participants.update', async (update) => {
        const { id, participants, action } = update;
        if (action === 'add') {
            for (const participant of participants) {
                await delay(Math.floor(Math.random() * 7000) + 1000); // Delay random 1-8 detik
                await sock.presenceSubscribe(id);
                await sock.sendPresenceUpdate('composing', id);

                // Kirim welcome dengan menu list + buttons
                const welcomeText = `Selamat datang @${participant.split('@')[0]} di group ini! Ketik "menu" atau klik di bawah untuk opsi bot.`;
                const sections = [
                    {
                        title: 'Pilih Command',
                        rows: [
                            { title: 'Help', rowId: 'help', description: 'Dapatkan bantuan bot' },
                            { title: 'Info', rowId: 'info', description: 'Info tentang bot' },
                            { title: 'Broadcast', rowId: 'broadcast', description: 'Kirim pesan massal (contoh)' }
                        ]
                    }
                ];
                const listMessage = {
                    text: welcomeText,
                    footer: 'Bot by xAI',
                    title: 'Menu Bot',
                    buttonText: 'Klik untuk Pilih',
                    sections,
                    mentions: [participant]
                };
                const buttons = {
                    text: 'Quick Actions',
                    buttons: [
                        { buttonId: 'quick_help', buttonText: { displayText: 'Help' }, type: 1 },
                        { buttonId: 'quick_info', buttonText: { displayText: 'Info' }, type: 1 }
                    ]
                };
                await sendMessageWithRetry(sock, id, listMessage);
                await sendMessageWithRetry(sock, id, buttons);
                await sock.sendPresenceUpdate('paused', id);

                // Simpan ke DB (contoh: catat user baru)
                if (!db.users[participant]) db.users[participant] = { joined: new Date().toISOString() };
                saveDB();
            }
        }
    });

    // Handle pesan masuk
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return; // Skip pesan sendiri

        const sender = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').toLowerCase();
        console.log(`Pesan dari ${sender}: ${text}`);

        // Update DB (contoh: catat interaksi)
        if (!db.users[sender]) db.users[sender] = { interactions: 0 };
        db.users[sender].interactions = (db.users[sender].interactions || 0) + 1;
        saveDB();

        // Tambah human-like behavior
        await sock.presenceSubscribe(sender); // Subscribe presence
        await delay(Math.floor(Math.random() * 7000) + 1000); // Delay random 1-8 detik (variatif)
        await sock.sendPresenceUpdate('composing', sender); // Tampilkan typing
        await delay(Math.floor(Math.random() * 5000) + 2000); // Delay typing 2-7 detik random (variatif)

        // Command handler interactive (list + buttons)
        if (text === 'menu') {
            // Kirim list message
            const sections = [
                {
                    title: 'Pilih Command',
                    rows: [
                        { title: 'Help', rowId: 'help', description: 'Dapatkan bantuan bot' },
                        { title: 'Info', rowId: 'info', description: 'Info tentang bot' },
                        { title: 'Broadcast', rowId: 'broadcast', description: 'Kirim pesan massal (contoh)' }
                    ]
                }
            ];
            const listMessage = {
                text: 'Halo! Pilih menu di bawah ini:',
                footer: 'Bot by xAI',
                title: 'Menu Bot',
                buttonText: 'Klik untuk Pilih',
                sections
            };
            await sendMessageWithRetry(sock, sender, listMessage);

            // Tambah buttons sederhana
            const buttons = {
                text: 'Atau klik button cepat:',
                buttons: [
                    { buttonId: 'btn_help', buttonText: { displayText: 'Help' }, type: 1 },
                    { buttonId: 'btn_info', buttonText: { displayText: 'Info' }, type: 1 },
                    { buttonId: 'btn_broadcast', buttonText: { displayText: 'Broadcast' }, type: 1 }
                ]
            };
            await sendMessageWithRetry(sock, sender, buttons);
        } else if (msg.message.listResponseMessage) {
            // Handle klik list
            const selected = msg.message.listResponseMessage.singleSelectReply.selectedRowId;
            let responseText = '';
            if (selected === 'help') {
                responseText = 'Ini adalah help: Bot ini bisa auto-reply, welcome group, db save, dll. Tambah fitur yuk!';
            } else if (selected === 'info') {
                responseText = `Bot versi 2.0, dibuat dengan Baileys. User kamu: ${db.users[sender]?.interactions || 0} interaksi. Powerful dan human-like!`;
            } else if (selected === 'broadcast') {
                responseText = 'Fitur broadcast belum aktif, tapi bisa ditambah nanti.';
            } else {
                responseText = 'Command tidak dikenal.';
            }
            await sendMessageWithRetry(sock, sender, { text: responseText });
        } else if (msg.message.buttonsResponseMessage) {
            // Handle klik button
            const selected = msg.message.buttonsResponseMessage.selectedButtonId;
            let responseText = '';
            if (selected === 'btn_help' || selected === 'quick_help') {
                responseText = 'Help via button: Ini bantuan cepat!';
            } else if (selected === 'btn_info' || selected === 'quick_info') {
                responseText = 'Info via button: Bot super stabil!';
            } else if (selected === 'btn_broadcast') {
                responseText = 'Broadcast via button: Coming soon!';
            } else {
                responseText = 'Button tidak dikenal.';
            }
            await sendMessageWithRetry(sock, sender, { text: responseText });
        } else {
            // Default auto-reply dengan button quick
            await sendMessageWithRetry(sock, sender, { text: 'Halo! Ini respons otomatis dari botku. Ketik "menu" untuk opsi.' });
            const defaultButtons = {
                text: 'Coba klik ini:',
                buttons: [
                    { buttonId: 'default_menu', buttonText: { displayText: 'Menu' }, type: 1 }
                ]
            };
            await sendMessageWithRetry(sock, sender, defaultButtons);
        }

        await sock.sendPresenceUpdate('paused', sender); // Stop typing
    });

    return sock;
}

// Jalankan bot
connectToWhatsApp().catch(err => console.error('Error:', err));