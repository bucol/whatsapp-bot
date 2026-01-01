const { Boom } = require('@hapi/boom');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrTerminal = require('qrcode-terminal');
const fs = require('fs');

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

    // Handle pesan masuk
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return; // Skip pesan sendiri

        const sender = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').toLowerCase();
        console.log(`Pesan dari ${sender}: ${text}`);

        // Tambah human-like behavior
        await sock.presenceSubscribe(sender); // Subscribe presence
        await delay(Math.floor(Math.random() * 6000) + 1000); // Delay random 1-7 detik (variatif lebih)
        await sock.sendPresenceUpdate('composing', sender); // Tampilkan typing
        await delay(Math.floor(Math.random() * 4000) + 2000); // Delay typing 2-6 detik random (variatif)

        // Command handler interactive (klik-able)
        if (text === 'menu') {
            // Kirim interactive list message
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
            await sock.sendMessage(sender, listMessage);
        } else if (msg.message.listResponseMessage) {
            // Handle klik dari list
            const selected = msg.message.listResponseMessage.singleSelectReply.selectedRowId;
            let responseText = '';
            if (selected === 'help') {
                responseText = 'Ini adalah help: Bot ini bisa auto-reply, dll. Tambah fitur yuk!';
            } else if (selected === 'info') {
                responseText = 'Bot versi 1.0, dibuat dengan Baileys. Powerful dan human-like!';
            } else if (selected === 'broadcast') {
                responseText = 'Fitur broadcast belum aktif, tapi bisa ditambah nanti.';
            } else {
                responseText = 'Command tidak dikenal.';
            }
            await sock.sendMessage(sender, { text: responseText });
        } else {
            // Default auto-reply kalau bukan command
            await sock.sendMessage(sender, { text: 'Halo! Ini respons otomatis dari botku. Ketik "menu" untuk opsi.' });
        }

        await sock.sendPresenceUpdate('paused', sender); // Stop typing
    });

    return sock;
}

// Jalankan bot
connectToWhatsApp().catch(err => console.error('Error:', err));
