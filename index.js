const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestWaWebVersion } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const app = express();
app.use(express.json());

let sock;
let discoveredChannels = new Map(); // Dynamically store discovered channel JIDs

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth');
    const { version } = await fetchLatestWaWebVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    // 1. Listen to Real-time Message Events (Guaranteed Channel JID Discovery)
    sock.ev.on('messages.upsert', (m) => {
        if (m && m.messages) {
            m.messages.forEach(msg => {
                const jid = msg.key ? msg.key.remoteJid : null;
                if (jid && (jid.endsWith('@newsletter') || jid.startsWith('120363'))) {
                    discoveredChannels.set(jid, jid);
                    console.log(`✅ DISCOVERED CHANNEL JID VIA MESSAGE: ${jid}`);
                }
            });
        }
    });

    // 2. Listen to History Sync Events
    sock.ev.on('messaging-history.set', ({ chats, messages }) => {
        if (chats) {
            chats.forEach(c => {
                if (c.id && (c.id.endsWith('@newsletter') || c.id.startsWith('120363'))) {
                    discoveredChannels.set(c.id, c.name || c.id);
                }
            });
        }
        if (messages) {
            messages.forEach(msg => {
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
        }
    });
}

connectToWhatsApp();

// Helper to resolve invite code or return matching channel JID
async function getJidFromInvite(code) {
    try {
        let clean = code.replace('https://whatsapp.com/channel/', '').replace('@newsletter', '').trim();
        if (clean.startsWith('120363')) {
            return clean.endsWith('@newsletter') ? clean : `${clean}@newsletter`;
        }

        // 1. Try Baileys metadata query
        try {
            const res = await sock.newsletterMetadata('invite', clean);
            if (res && res.id) {
                discoveredChannels.set(res.id, res.name || res.id);
                return res.id;
            }
        } catch (err) {
            console.log(`Invite metadata notice for ${clean}:`, err.message);
        }

        // 2. Match from discoveredChannels map
        if (discoveredChannels.size > 0) {
            const keys = Array.from(discoveredChannels.keys());
            const found = keys.find(k => k.includes(clean));
            if (found) return found;
            return keys[0]; // fallback to discovered channel
        }
    } catch (err) {
        console.error(`Invite resolution error for ${code}:`, err.message);
    }
    return null;
}

// QR Code View Endpoint
app.get('/qr', async (req, res) => {
    if (app.locals.qr) {
        const qrImage = await QRCode.toDataURL(app.locals.qr);
        res.send(`<h2 style="font-family:sans-serif;text-align:center;">Scan with WhatsApp:</h2><div style="text-align:center;"><img src="${qrImage}"/></div>`);
    } else {
        res.send('<h2 style="font-family:sans-serif;text-align:center;color:green;">✅ WhatsApp is Already Connected!</h2>');
    }
});

// List All Discovered Channels Endpoint
app.get('/channels', (req, res) => {
    const channels = Array.from(discoveredChannels.entries()).map(([id, name]) => ({ id, name }));
    res.json({
        status: 'success',
        count: channels.length,
        channels: channels,
        instruction: channels.length === 0 ? "Send any test message inside your channel on mobile, then refresh this page!" : "Here are your channel JIDs!"
    });
});

// Post to WhatsApp Channel Endpoint
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
                error: `Could not resolve JID for '${channel_id}'. Please send a test message inside your channel on mobile, then try again.` 
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
