const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestWaWebVersion, delay } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const app = express();

// Increase JSON limits to allow uploading multiple High Quality Photos
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

let sock;
let discoveredChannels = new Map();

const KNOWN_INVITES = [
    "0029VbCsrU6IHphJ1G2Ctv0X",
    "0029VbDN5b3CsU9XlRYVRq0s",
    "0029VbDIfE217EmxC6bLbb3A"
];

async function syncKnownChannels() {
    if (!sock) return;
    for (const code of KNOWN_INVITES) {
        try {
            const meta = await sock.newsletterMetadata('invite', code);
            if (meta && meta.id) {
                discoveredChannels.set(meta.id, meta.name || code);
                discoveredChannels.set(code, meta.id);
            }
        } catch (err) { }
    }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth');
    const { version } = await fetchLatestWaWebVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', (m) => {
        if (m && m.messages) {
            m.messages.forEach(msg => {
                const jid = msg.key ? msg.key.remoteJid : null;
                if (jid && (jid.endsWith('@newsletter') || jid.startsWith('120363'))) {
                    discoveredChannels.set(jid, jid);
                }
            });
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, qr } = update;
        if (qr) {
            app.locals.qr = qr;
        }
        if (connection === 'close') {
            console.log('Reconnecting WhatsApp...');
            connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Connected Successfully!');
            app.locals.qr = null;
            setTimeout(() => { syncKnownChannels(); }, 3000);
        }
    });
}

connectToWhatsApp();

async function getJidFromInvite(code) {
    try {
        let clean = code.replace('https://whatsapp.com/channel/', '').replace('@newsletter', '').trim();
        if (clean.startsWith('120363')) return clean.endsWith('@newsletter') ? clean : `${clean}@newsletter`;
        if (discoveredChannels.has(clean)) return discoveredChannels.get(clean);

        try {
            const res = await sock.newsletterMetadata('invite', clean);
            if (res && res.id) {
                discoveredChannels.set(res.id, res.name || res.id);
                discoveredChannels.set(clean, res.id);
                return res.id;
            }
        } catch (err) { }

        if (discoveredChannels.size > 0) {
            const keys = Array.from(discoveredChannels.keys()).filter(k => k.startsWith('120363'));
            if (keys.length > 0) return keys[0];
        }
    } catch (err) { }
    return null;
}

app.get('/qr', async (req, res) => {
    if (app.locals.qr) {
        const qrImage = await QRCode.toDataURL(app.locals.qr);
        res.send(`<h2 style="font-family:sans-serif;text-align:center;">Scan with WhatsApp:</h2><div style="text-align:center;"><img src="${qrImage}"/></div>`);
    } else {
        res.send('<h2 style="font-family:sans-serif;text-align:center;color:green;">✅ WhatsApp is Already Connected!</h2>');
    }
});

// Powerful Mutliple Photos Base64 Sender API Endpoint
app.post('/send', async (req, res) => {
    try {
        const { channel_id, text, images } = req.body;
        if (!sock) return res.status(500).json({ status: 'error', error: 'WhatsApp socket not connected' });

        let targetJid = await getJidFromInvite(channel_id);
        if (!targetJid) {
            return res.status(400).json({ status: 'error', error: `Could not resolve JID` });
        }

        if (images && Array.isArray(images) && images.length > 0) {
            console.log(`Sending Multiple (${images.length}) images to JID: ${targetJid}`);
            
            // First image comes with the Title + Details caption!
            const mainBuffer = Buffer.from(images[0], 'base64');
            await sock.sendMessage(targetJid, { image: mainBuffer, caption: text });

            // Next images will be pushed directly without text, creating a smooth visual album flow
            for (let i = 1; i < images.length; i++) {
                await delay(1200); // 1.2 second pause for Anti-Spam protection!
                const buffer = Buffer.from(images[i], 'base64');
                await sock.sendMessage(targetJid, { image: buffer });
            }
        } else {
            console.log(`Sending TEXT message to newsletter JID: ${targetJid}`);
            await sock.sendMessage(targetJid, { text: text });
        }

        res.json({ status: 'success', message: 'Posted Album to channel successfully!', jid: targetJid });

    } catch (error) {
        console.error('Send error:', error);
        res.status(500).json({ status: 'error', error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
