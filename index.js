const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestWaWebVersion, delay, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

let sock;
let discoveredChannels = new Map();

// ==================== কনফিগারেশন (Environment Variables) ====================
let ADMIN_NUMBER = process.env.ADMIN_NUMBER || "8801XXXXXXXXX@s.whatsapp.net";
if (ADMIN_NUMBER && !ADMIN_NUMBER.endsWith('@s.whatsapp.net')) {
    ADMIN_NUMBER = ADMIN_NUMBER.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
}

// একাধিক API Key গ্রহণ (কমা দিয়ে আলাদা করা)
const API_KEYS = process.env.API_KEYS 
    ? process.env.API_KEYS.split(',').map(k => k.trim()).filter(Boolean)
    : [];

// একাধিক মডেলের লিস্ট গ্রহণ (কমা দিয়ে আলাদা করা)
const MODELS = (process.env.LLM_MODELS || process.env.LLM_MODEL || "qwen3.5,glm-5.3-flash,deepseek-v4-flash")
    .split(',')
    .map(m => m.trim())
    .filter(Boolean);

const LLM_API_URL = process.env.LLM_API_URL || "https://ollama.com/v1/chat/completions";

// মেমোরি ও চ্যাট হিস্ট্রি ট্র্যাকিং
const chatHistories = new Map();
const pausedUsers = new Map();

const KNOWN_INVITES = [
    "0029VbCsrU6IHphJ1G2Ctv0X",
    "0029VbDN5b3CsU9XlRYVRq0s",
    "0029VbDIfE217EmxC6bLbb3A"
];

// ==================== গত ২ মাসের চাকরির ডাটা কালেকশন (Scraper) ====================
const JOB_SITES = [
    "https://bdgovtjob.net/wp-json/wp/v2/posts",
    "https://bdgovtnotice.com/wp-json/wp/v2/posts",
    "https://projobsbd.com/wp-json/wp/v2/posts"
];

function cleanHTML(html) {
    return html.replace(/<[^>]*>?/gm, '').replace(/\n\s*\n/g, '\n').trim();
}

async function fetchLastTwoMonthsJobs() {
    console.log("🔄 গত ২ মাসের চাকরির সার্কুলার স্ক্র্যাপিং শুরু হচ্ছে...");
    const twoMonthsAgo = new Date();
    twoMonthsAgo.setDate(twoMonthsAgo.getDate() - 60);

    let allJobs = [];

    for (const site of JOB_SITES) {
        let page = 1;
        let keepFetching = true;

        while (keepFetching && page <= 5) {
            try {
                const res = await fetch(`${site}?per_page=20&page=${page}`);
                if (!res.ok) break;

                const posts = await res.json();
                if (!posts || posts.length === 0) break;

                for (const post of posts) {
                    const postDate = new Date(post.date);
                    if (postDate < twoMonthsAgo) {
                        keepFetching = false;
                        break;
                    }

                    allJobs.push({
                        title: post.title.rendered,
                        date: post.date.split('T')[0],
                        details: cleanHTML(post.excerpt?.rendered || post.content?.rendered || "").slice(0, 250),
                        link: post.link
                    });
                }
                page++;
            } catch (err) {
                console.error(`Error fetching from ${site}:`, err.message);
                break;
            }
        }
    }

    try {
        fs.writeFileSync('./jobs.json', JSON.stringify(allJobs, null, 2));
        console.log(`✅ সফলভাবে মোট ${allJobs.length} টি চলতি সার্কুলার মেমরিতে সেভ করা হয়েছে!`);
    } catch (err) {
        console.error("Jobs file write error:", err);
    }
}

// ==================== এআই লজিক (দ্বি-স্তরীয় Fallback লুপ: Key ➡️ Models) ====================
async function getAIReply(userPhone, userMessage) {
    let jobsData = "";
    if (fs.existsSync('./jobs.json')) {
        try {
            const jobs = JSON.parse(fs.readFileSync('./jobs.json', 'utf-8'));
            jobsData = jobs.slice(0, 25).map(j => `- ${j.title} (তারিখ: ${j.date})`).join("\n");
        } catch (e) { }
    }

    const systemPrompt = `
তুমি একজন প্রফেশনাল জব অ্যাপ্লিকেশান কাস্টমার সাপোর্ট এআই।
কঠোর নিয়মাবলী:
১. শুধুমাত্র যতটুকু জানতে চেয়েছে ঠিক ততটুকুই সংক্ষিপ্তভাবে উত্তর দিবে। কোনো অতিরিক্ত কথা, বাড়তি ভূমিকা বা অপ্রয়োজনীয় বাক্য লিখবে না।
২. সার্ভিস চার্জ:
   - সরকারি চাকরির আবেদন সার্ভিস চার্জ ৫০ টাকা।
   - বেসরকারি চাকরির আবেদন সার্ভিস চার্জ ১০০ টাকা।
   - কাস্টমার যদি শুধু বলে "সার্ভিস চার্জ কত?", আগের মেসেজের প্রসঙ্গ দেখে বুঝে নিবে সে কোন চাকরির কথা বলছে। যদি সরকারি হয় বলবে "৫০ টাকা", বেসরকারি হলে "১০০ টাকা"। স্পষ্ট না বুঝলে বলবে: "সরকারি ৫০ টাকা, বেসরকারি ১০০ টাকা।"
৩. প্রয়োজনীয় ডকুমেন্টস:
   - সিভি থাকলে সিভি দিলেই হবে।
   - সিভি না থাকলে আগের কোনো অ্যাপ্লিকেন্ট কপি।
   - একদম প্রথমবার আবেদন করলে: ভোটার আইডি/সনদ, ১ কপি পাসপোর্ট সাইজ ছবি এবং সাদা কাগজে স্বাক্ষরের স্পষ্ট ছবি।
৪. কাস্টমার যদি জিজ্ঞেস করে "মানুষ নাকি বট?" বা "এত দ্রুত উত্তর দিচ্ছেন কীভাবে?": বলবে "আমি একটি কাস্টমার সার্ভিস এআই সহকারী।"
৫. পেমেন্ট আলোচনা: কাস্টমার যদি বিকাশ/নগদ নম্বর চায় বা পেমেন্ট সংক্রান্ত তথ্য জানতে চায়, তবে উত্তরে বলবে "পেমেন্টের বিষয়ে আমাদের একজন টিম মেম্বার খুব শীঘ্রই আপনার সাথে যুক্ত হচ্ছেন।" এবং উত্তরের শেষে অবশ্যই [ALERT_ADMIN] ট্যাগটি যুক্ত করবে।
৬. চলমান চাকরির তালিকা:
${jobsData}
`;

    if (!chatHistories.has(userPhone)) {
        chatHistories.set(userPhone, []);
    }
    const history = chatHistories.get(userPhone);
    history.push({ role: "user", content: userMessage });

    if (history.length > 6) history.shift();

    const messagesToSend = [
        { role: "system", content: systemPrompt },
        ...history
    ];

    if (API_KEYS.length === 0) {
        return "API Key সেট করা হয়নি। অনুগ্রহ করে Render Environment Variables চেক করুন।";
    }

    // 🔥 দ্বি-স্তরীয় লুপ: প্রথমে Key লুপ, ভেতরে Model লুপ
    for (let k = 0; k < API_KEYS.length; k++) {
        const currentKey = API_KEYS[k];

        for (let m = 0; m < MODELS.length; m++) {
            const currentModel = MODELS[m];

            try {
                const res = await fetch(LLM_API_URL, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${currentKey}`
                    },
                    body: JSON.stringify({
                        model: currentModel,
                        messages: messagesToSend,
                        temperature: 0.2
                    })
                });

                if (!res.ok) {
                    const errText = await res.text().catch(() => "");
                    throw new Error(`Status ${res.status}: ${errText.slice(0, 80)}`);
                }

                const data = await res.json();
                const reply = data.choices?.[0]?.message?.content?.trim();

                if (reply) {
                    history.push({ role: "assistant", content: reply });
                    return reply; // সফল হলে উত্তর ফেরত পাঠাবে
                }

            } catch (error) {
                console.log(`⚠️ Key #${k + 1}-এ মডেল '${currentModel}' সমস্যা করেছে (${error.message})। পরবর্তী মডেল ট্রাই করা হচ্ছে...`);
            }
        }
        console.log(`❌ Key #${k + 1}-এর সবগুলো মডেল ব্যর্থ হয়েছে। পরবর্তী API Key-তে যাওয়া হচ্ছে...`);
    }

    return "দুঃখিত, সংযোগে সমস্যা হচ্ছে। কিছুক্ষণ পর আবার চেষ্টা করুন।";
}

// ==================== হোয়াটসঅ্যাপ সংযোগ ও বার্তা হ্যান্ডলিং ====================
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

    sock.ev.on('messages.upsert', async (m) => {
        if (!m || !m.messages) return;

        for (const msg of m.messages) {
            const jid = msg.key?.remoteJid;
            if (!jid) continue;

            if (jid.endsWith('@newsletter') || jid.startsWith('120363')) {
                discoveredChannels.set(jid, jid);
                continue;
            }

            if (jid.endsWith('@g.us') || jid === 'status@broadcast') continue;

            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
            if (!text.trim()) continue;

            // অ্যাডমিন ইন্টারভেনশন ও অটো-পজ লজিক
            if (msg.key.fromMe) {
                if (text.trim() === "#start") {
                    pausedUsers.delete(jid);
                    await sock.sendMessage(jid, { text: "বট পুনরায় চালু করা হয়েছে।" });
                } else if (text.trim() === "#stop") {
                    pausedUsers.set(jid, Date.now() + 24 * 60 * 60 * 1000);
                    await sock.sendMessage(jid, { text: "বট সাময়িকভাবে বন্ধ করা হলো।" });
                } else {
                    pausedUsers.set(jid, Date.now() + 24 * 60 * 60 * 1000);
                }
                continue;
            }

            if (pausedUsers.has(jid)) {
                if (Date.now() < pausedUsers.get(jid)) {
                    continue;
                } else {
                    pausedUsers.delete(jid);
                }
            }

            // এআই উত্তর তৈরি
            const aiResponse = await getAIReply(jid, text);

            // পেমেন্ট সংক্রান্ত অ্যালার্ট
            if (aiResponse.includes("[ALERT_ADMIN]")) {
                const cleanReply = aiResponse.replace("[ALERT_ADMIN]", "").trim();
                await sock.sendMessage(jid, { text: cleanReply });

                if (ADMIN_NUMBER && ADMIN_NUMBER.includes("@s.whatsapp.net")) {
                    await sock.sendMessage(ADMIN_NUMBER, {
                        text: `⚠️ [পেমেন্ট অ্যালার্ট] কাস্টমার: ${jid.split('@')[0]}\nপেমেন্ট বা গুরুত্বপূর্ণ বিষয়ে কথা বলতে চাচ্ছে। অনুগ্রহ করে চ্যাটে নজর দিন!`
                    });
                }

                pausedUsers.set(jid, Date.now() + 24 * 60 * 60 * 1000);
                continue;
            }

            await sock.sendMessage(jid, { text: aiResponse });
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, qr } = update;
        if (qr) app.locals.qr = qr;

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

// ==================== আগের চ্যানেল পোস্ট ও QR কোড API ====================
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

app.post('/send', async (req, res) => {
    try {
        const { channel_id, text, images } = req.body;
        if (!sock) return res.status(500).json({ status: 'error', error: 'WhatsApp socket not connected' });

        let targetJid = await getJidFromInvite(channel_id);
        if (!targetJid) return res.status(400).json({ status: 'error', error: `Could not resolve JID` });

        if (images && Array.isArray(images) && images.length > 0) {
            const mainBuffer = Buffer.from(images[0], 'base64');
            await sock.sendMessage(targetJid, { image: mainBuffer, caption: text });

            for (let i = 1; i < images.length; i++) {
                await delay(1200);
                const buffer = Buffer.from(images[i], 'base64');
                await sock.sendMessage(targetJid, { image: buffer });
            }
        } else {
            await sock.sendMessage(targetJid, { text: text });
        }

        res.json({ status: 'success', message: 'Posted Album to channel successfully!', jid: targetJid });
    } catch (error) {
        console.error('Send error:', error);
        res.status(500).json({ status: 'error', error: error.message });
    }
});

fetchLastTwoMonthsJobs();
setInterval(fetchLastTwoMonthsJobs, 12 * 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
