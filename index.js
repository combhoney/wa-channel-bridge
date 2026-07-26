const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestWaWebVersion } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const app = express();
app.use(express.json());

let sock;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth');
    const { version } = await fetchLatestWaWebVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, qr } = update;
        if (qr) {
            app.locals.qr = qr;
        }
        if (connection === 'close') {
            console.log('Reconnecting WhatsApp...');
            connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('WhatsApp Connected!');
            app.locals.qr = null;
        }
    });
}

connectToWhatsApp();

// QR Code View Endpoint
app.get('/qr', async (req, res) => {
    if (app.locals.qr) {
        const qrImage = await QRCode.toDataURL(app.locals.qr);
        res.send(`<h2 style="font-family:sans-serif;text-align:center;">Scan with WhatsApp:</h2><div style="text-align:center;"><img src="${qrImage}"/></div>`);
    } else {
        res.send('<h2 style="font-family:sans-serif;text-align:center;color:green;">✅ WhatsApp is Already Connected!</h2>');
    }
});

// Post to WhatsApp Channel Endpoint with Auto Invite Resolver
app.post('/send', async (req, res) => {
    try {
        const { channel_id, text } = req.body;
        if (!sock) {
            return res.status(500).json({ status: 'error', error: 'WhatsApp socket not connected' });
        }

        let cleanCode = channel_id.replace('@newsletter', '').replace('https://whatsapp.com/channel/', '').trim();
        let jid = cleanCode;

        // Auto-resolve channel invite code to actual Newsletter JID
        if (!cleanCode.startsWith('120363')) {
            try {
                const metadata = await sock.newsletterMetadata("invite", cleanCode);
                if (metadata && metadata.id) {
                    jid = metadata.id;
                }
            } catch (metaErr) {
                console.log(`Failed resolving metadata for ${cleanCode}, falling back...`);
                jid = `${cleanCode}@newsletter`;
            }
        } else if (!cleanCode.endsWith('@newsletter')) {
            jid = `${cleanCode}@newsletter`;
        }

        await sock.sendMessage(jid, { text: text });
        res.json({ status: 'success', message: 'Posted to channel successfully!' });
    } catch (error) {
        console.error('Send error:', error);
        res.status(500).json({ status: 'error', error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
