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

// Direct Stanza Query to fetch all subscribed/owned channels from WhatsApp
async function getSubscribedNewsletters() {
    if (!sock) return [];
    try {
        const result = await sock.query({
            tag: 'iq',
            attrs: {
                to: '@newsletter',
                type: 'get',
                xmlns: 'newsletter'
            },
            content: [
                { tag: 'subscribed', attrs: {} }
            ]
        });

        const newsletters = [];
        if (result && result.content) {
            for (const child of result.content) {
                if (child.tag === 'subscribed' && child.content) {
                    for (const item of child.content) {
                        if (item.tag === 'newsletter') {
                            const id = item.attrs.jid || item.attrs.id;
                            let name = 'WhatsApp Channel';
                            if (item.content) {
                                const meta = item.content.find(c => c.tag === 'metadata');
                                if (meta && meta.content) {
                                    const nameTag = meta.content.find(c => c.tag === 'name');
                                    if (nameTag && nameTag.content) name = nameTag.content.toString();
                                }
                            }
                            newsletters.push({ id: id.includes('@newsletter') ? id : `${id}@newsletter`, name });
                        }
                    }
                }
            }
        }
        return newsletters;
    } catch (e) {
        console.error('Error fetching newsletters via stanza:', e.message);
        return [];
    }
}

// Helper function to resolve invite code or match channel JID
async function getJidFromInvite(code) {
    try {
        const clean = code.replace('https://whatsapp.com/channel/', '').replace('@newsletter', '').trim();
        if (clean.startsWith('120363')) {
            return clean.endsWith('@newsletter') ? clean : `${clean}@newsletter`;
        }

        // 1. Try Baileys metadata lookup
        try {
            const res = await sock.newsletterMetadata('invite', clean);
            if (res && res.id) {
                return res.id;
            }
        } catch (err) {
            console.log(`Invite metadata notice for ${clean}: ${err.message}`);
        }

        // 2. Fallback to Stanza Query
        const list = await getSubscribedNewsletters();
        if (list && list.length > 0) {
            const matched = list.find(n => n.id.includes(clean) || n.name.includes(clean));
            if (matched) return matched.id;
            return list[0].id;
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

// List All Channels Endpoint
app.get('/channels', async (req, res) => {
    try {
        if (!sock) return res.status(500).json({ status: 'error', error: 'WhatsApp socket not connected' });
        const channels = await getSubscribedNewsletters();
        res.json({ status: 'success', count: channels.length, channels });
    } catch (error) {
        res.status(500).json({ status: 'error', error: error.message });
    }
});

// Resolve Channel Endpoint
app.get('/resolve/:code', async (req, res) => {
    try {
        if (!sock) return res.status(500).json({ error: 'Socket not ready' });
        const jid = await getJidFromInvite(req.params.code);
        if (jid) {
            res.json({ status: 'success', inviteCode: req.params.code, jid: jid });
        } else {
            const allChannels = await getSubscribedNewsletters();
            res.json({ status: 'info', note: 'Invite lookup bypassed. Here are your channels:', channels: allChannels });
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
