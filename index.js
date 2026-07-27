const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestWaWebVersion } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const app = express();
app.use(express.json());

let sock;
let discoveredChannels = new Map();

// Your 3 WhatsApp Channel Invite Codes
const KNOWN_INVITES = [
    "0029VbCsrU6IHphJ1G2Ctv0X",
    "0029VbDN5b3CsU9XlRYVRq0s",
    "0029VbDIfE217EmxC6bLbb3A"
];

// Auto-resolve invite codes directly from WhatsApp WebSocket
async function syncKnownChannels() {
    if (!sock) return;
    for (const code of KNOWN_INVITES) {
        try {
            const meta = await sock.newsletterMetadata('invite', code);
            if (meta && meta.id) {
                discoveredChannels.set(meta.id, meta.name || code);
                discoveredChannels.set(code, meta.id);
                console.log(`✅ Auto-resolved ${code} => ${meta.id}`);
            }
        } catch (err) {
            console.log(`Notice resolving ${code}: ${err.message}`);
        }
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

            // Auto-resolve known channel invite codes 3 seconds after connection
            setTimeout(() => {
                syncKnownChannels();
            }, 3000);
        }
    });
}

connectToWhatsApp();

async function getJidFromInvite(code) {
    try {
        let clean = code.replace('https://whatsapp.com/channel/', '').replace('@newsletter', '').trim();
        if (clean.startsWith('120363')) {
            return clean.endsWith('@newsletter') ? clean : `${clean}@newsletter`;
        }

        if (discoveredChannels.has(clean)) {
            return discoveredChannels.get(clean);
        }

        try {
            const res = await sock.newsletterMetadata('invite', clean);
            if (res && res.id) {
                discoveredChannels.set(res.id, res.name || res.id);
                discoveredChannels.set(clean, res.id);
                return res.id;
            }
        } catch (err) {
            console.log(`Invite metadata notice for ${clean}:`, err.message);
        }

        if (discoveredChannels.size > 0) {
            const keys = Array.from(discoveredChannels.keys()).filter(k => k.startsWith('120363'));
            if (keys.length > 0) return keys[0];
        }
    } catch (err) {
        console.error(`Invite resolution error for ${code}:`, err.message);
    }
    return null;
}

app.get('/', (req, res) => {
    res.send('<h2>WhatsApp Channel Bridge Server is Running!</h2><p>Visit <a href="/qr">/qr</a> or <a href="/channels">/channels</a></p>');
});

app.get('/qr', async (req, res) => {
    if (app.locals.qr) {
        const qrImage = await QRCode.toDataURL(app.locals.qr);
        res.send(`<h2 style="font-family:sans-serif;text-align:center;">Scan with WhatsApp:</h2><div style="text-align:center;"><img src="${qrImage}"/></div>`);
    } else {
        res.send('<h2 style="font-family:sans-serif;text-align:center;color:green;">✅ WhatsApp is Already Connected!</h2>');
    }
});

// List All Resolved Channels Endpoint
app.get('/channels', async (req, res) => {
    await syncKnownChannels();
    const channels = Array.from(discoveredChannels.entries())
        .filter(([id]) => id.startsWith('120363'))
        .map(([id, name]) => ({ id, name }));

    res.json({
        status: 'success',
        count: channels.length,
        channels: channels
    });
});

app.post('/send', async (req, res) => {
    try {
        const { channel_id, text } = req.body;
        if (!sock) {
            return res.status(500).json({ status: 'error', error: 'WhatsApp socket not connected' });
        }

        let targetJid = await getJidFromInvite(channel_id);

        if (!targetJid) {
            return res.status(400).json({ 
                status: 'error', 
                error: `Could not resolve JID for '${channel_id}'. Please make sure WhatsApp socket is connected.` 
            });
        }

        console.log(`Sending message to newsletter JID: ${targetJid}`);
        await sock.sendMessage(targetJid, { text: text });
        res.json({ status: 'success', message: 'Posted to channel successfully!', jid: targetJid });

    } catch (error) {
        console.error('Send error:', error);
        res.status(500).json({ status: 'error', error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
