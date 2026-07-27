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
            console.log('✅ WhatsApp Connected Successfully!');
            app.locals.qr = null;
        }
    });
}

connectToWhatsApp();

// Helper function to resolve invite code to JID safely
async function getJidFromInvite(code) {
    try {
        const clean = code.replace('https://whatsapp.com/channel/', '').replace('@newsletter', '').trim();
        if (clean.startsWith('120363')) {
            return clean.endsWith('@newsletter') ? clean : `${clean}@newsletter`;
        }
        const res = await sock.newsletterMetadata('invite', clean);
        if (res && res.id) {
            // Auto follow newsletter if not already following
            try { await sock.newsletterFollow(res.id); } catch(e){}
            return res.id;
        }
    } catch (err) {
        console.error(`Invite resolution error for ${code}:`, err.message);
    }
    return null;
}

// QR Code Endpoint
app.get('/qr', async (req, res) => {
    if (app.locals.qr) {
        const qrImage = await QRCode.toDataURL(app.locals.qr);
        res.send(`<h2 style="font-family:sans-serif;text-align:center;">Scan with WhatsApp:</h2><div style="text-align:center;"><img src="${qrImage}"/></div>`);
    } else {
        res.send('<h2 style="font-family:sans-serif;text-align:center;color:green;">✅ WhatsApp is Already Connected!</h2>');
    }
});

// Resolve Channel Endpoint (Visit in browser)
app.get('/resolve/:code', async (req, res) => {
    try {
        if (!sock) return res.status(500).json({ error: 'Socket not ready' });
        const jid = await getJidFromInvite(req.params.code);
        if (jid) {
            res.json({ status: 'success', inviteCode: req.params.code, jid: jid });
        } else {
            res.status(400).json({ status: 'error', error: 'Could not resolve JID' });
        }
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
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
                error: `Could not resolve JID for '${channel_id}'. Make sure your WhatsApp account follows or owns this channel.` 
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
