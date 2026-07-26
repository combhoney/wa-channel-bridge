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

    sock.ev.on('connection.update', async (update) => {
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
            
            // Print all owned/subscribed channels to Render Logs automatically
            try {
                setTimeout(async () => {
                    if (sock) {
                        const newsletters = await sock.newsletterSubscribed();
                        console.log("\n================ WHATSAPP CHANNELS LIST ================");
                        newsletters.forEach(n => console.log(`CHANNEL: ${n.name} | JID: ${n.id}`));
                        console.log("========================================================\n");
                    }
                }, 3000);
            } catch (err) {
                console.error("Error fetching channels list:", err.message);
            }
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

// View All Channels & JIDs Endpoint
app.get('/channels', async (req, res) => {
    try {
        if (!sock) return res.status(500).json({ status: 'error', error: 'WhatsApp socket not ready' });
        const newsletters = await sock.newsletterSubscribed();
        const channels = newsletters.map(n => ({ name: n.name, id: n.id }));
        res.json({ status: 'success', channels });
    } catch (error) {
        res.status(500).json({ status: 'error', error: error.message });
    }
});

// Post to WhatsApp Channel Endpoint
app.post('/send', async (req, res) => {
    try {
        const { channel_id, text } = req.body;
        if (!sock) {
            return res.status(500).json({ status: 'error', error: 'WhatsApp socket not connected' });
        }

        let cleanInput = channel_id.replace('https://whatsapp.com/channel/', '').trim();
        let targetJid = null;

        // 1. Check if input is already a numeric JID (120363...@newsletter)
        if (cleanInput.startsWith('120363')) {
            targetJid = cleanInput.includes('@newsletter') ? cleanInput : `${cleanInput}@newsletter`;
        } else {
            // 2. Try resolving via invite code
            const cleanCode = cleanInput.replace('@newsletter', '').trim();
            try {
                const metadata = await sock.newsletterMetadata("invite", cleanCode);
                if (metadata && metadata.id) {
                    targetJid = metadata.id;
                }
            } catch (e) {
                console.log(`Invite code lookup failed for ${cleanCode}`);
            }

            // 3. Fallback: Search in subscribed newsletters
            if (!targetJid) {
                try {
                    const newsletters = await sock.newsletterSubscribed();
                    if (newsletters && newsletters.length > 0) {
                        const matched = newsletters.find(n => n.id.includes(cleanCode) || n.name.includes(cleanCode));
                        if (matched) {
                            targetJid = matched.id;
                        }
                    }
                } catch (err) {
                    console.log('Newsletter search error:', err.message);
                }
            }
        }

        if (!targetJid) {
            return res.status(400).json({ 
                status: 'error', 
                error: `Could not resolve valid Channel JID for '${channel_id}'. Please pass numeric JID (e.g. 120363...@newsletter).` 
            });
        }

        console.log(`Sending post to resolved Channel JID: ${targetJid}`);
        await sock.sendMessage(targetJid, { text: text });
        res.json({ status: 'success', message: 'Posted to channel successfully!', jid: targetJid });

    } catch (error) {
        console.error('Send error:', error);
        res.status(500).json({ status: 'error', error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
