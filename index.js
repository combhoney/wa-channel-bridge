const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestWaWebVersion, delay, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs');
const pdfParse = require('pdf-parse');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

let sock;
let discoveredChannels = new Map();

// ==================== কনফিগারেশন ====================
let ADMIN_NUMBER = process.env.ADMIN_NUMBER || "8801540503092@s.whatsapp.net";
if (ADMIN_NUMBER && !ADMIN_NUMBER.endsWith('@s.whatsapp.net')) {
    ADMIN_NUMBER = ADMIN_NUMBER.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
}

const API_KEYS = process.env.API_KEYS 
    ? process.env.API_KEYS.split(',').map(k => k.trim()).filter(Boolean)
    : [];

// ছবি পড়ার সুবিধার্থে ভিশন সমর্থিত মডেলগুলোকে শুরুতে রাখা হয়েছে
const DEFAULT_MODELS = "qwen3.5,glm-5.3-flash,gemma4:31b,gpt-oss:120b,gpt-oss:20b,nemotron-3-super,deepseek-v4-flash";

const MODELS = (process.env.LLM_MODELS || process.env.LLM_MODEL || DEFAULT_MODELS)
    .split(',')
    .map(m => m.trim())
    .filter(Boolean);

const LLM_API_URL = process.env.LLM_API_URL || "https://ollama.com/v1/chat/completions";
const CHANNEL_LINK = "https://whatsapp.com/channel/0029VbDIfE217EmxC6bLbb3A";

const chatHistories = new Map();
const pausedUsers = new Map();

const KNOWN_INVITES = [
    "0029VbCsrU6IHphJ1G2Ctv0X",
    "0029VbDN5b3CsU9XlRYVRq0s",
    "0029VbDIfE217EmxC6bLbb3A"
];

// ==================== গত ২ মাসের সার্কুলার স্ক্র্যাপার ====================
const JOB_SITES = [
    "https://bdgovtjob.net/wp-json/wp/v2/posts",
    "https://bdgovtnotice.com/wp-json/wp/v2/posts",
    "https://projobsbd.com/wp-json/wp/v2/posts"
];

function cleanHTML(html) {
    return html.replace(/<[^>]*>?/gm, '').replace(/\n\s*\n/g, '\n').trim();
}

async function fetchLastTwoMonthsJobs() {
    console.log("🔄 সার্কুলার স্ক্র্যাপিং শুরু হচ্ছে...");
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
                break;
            }
        }
    }
    try {
        fs.writeFileSync('./jobs.json', JSON.stringify(allJobs, null, 2));
        console.log(`✅ ${allJobs.length} টি চলতি সার্কুলার লোড হয়েছে!`);
    } catch (e) {}
}

// ==================== এআই লজিক ও প্রম্পট ইঞ্জিনিয়ারিং ====================
async function getAIReply(userPhone, userMessage, base64Image = null) {
    let jobsData = "";
    if (fs.existsSync('./jobs.json')) {
        try {
            const jobs = JSON.parse(fs.readFileSync('./jobs.json', 'utf-8'));
            jobsData = jobs.slice(0, 20).map(j => `- ${j.title} (${j.date})`).join("\n");
        } catch (e) {}
    }

    const systemPrompt = `
তুমি একজন আন্তরিক, বন্ধুসুলভ জব অ্যাপ্লিকেশান অ্যাসিস্ট্যান্ট। কথাবার্তা খুব বেশি ফরমাল বা রোবটের মতো বলবে না, সম্পূর্ণ ক্যাজুয়াল ও সহজ বাংলা ভাষায় উত্তর দেবে (যেমন: "এটা তো অনলাইনে হবে না ভাই", "আমাদের অফিসে যাওয়া লাগবে না, আপনি তাদের অফিসে যাবেন")।

গুরুত্বপূর্ণ নিয়মাবলী:
১. সার্কুলার বিশ্লেষণ (ছবি বা ডকুমেন্টের ক্ষেত্রে):
   - যদি নিয়োগটিতে "সরাসরি সাক্ষাৎকার / Walk-in Interview / সরাসরি যোগাযোগ" থাকে: পরিষ্কারভাবে বলবে— "এটা তো অনলাইনে আবেদন করা যাবে না। আপনাকে সরাসরি তাদের অফিসে গিয়ে ইন্টারভিউ দিতে হবে/কাগজপত্র জমা দিতে হবে।" এবং সংক্ষেপে তারিখ, সময়, স্থান ও কী কী কাগজপত্র লাগবে তা উল্লেখ করবে।
   - যদি "ডাকযোগে বা কুরিয়ারে" পাঠানোর কথা থাকে: বলবে— "এটা আপনাকে ডাক বিভাগের/কুরিয়ারের মাধ্যমে পাঠাতে হবে। অনলাইন আবেদনের অপশন নাই।"
   - যদি "অনলাইনে আবেদনযোগ্য" হয়: বলবে— "হ্যাঁ, এটা আমরা অনলাইনে আবেদন করে দিতে পারব।" এরপর প্রয়োজনীয় কাগজপত্র ও ফি জানতে চাইলে বলবে।
২. "চাকরি দেওয়া" সংক্রান্ত প্রশ্ন: কেউ যদি বলে "আমাকে একটা চাকরি দেন / চাকরি পাওয়া যাবে?": বলবে— "আমরা চাকরি দেই না, আমরা চাকরির আবেদনের অনলাইন সার্ভিস প্রদান করি। আপনি আমাদের চলমান চাকরির তালিকা থেকে পছন্দ করলে আবেদন করে দিতে পারব।"
৩. সার্ভিস চার্জ: সরকারি চাকরির অনলাইন আবেদন চার্জ ৫০ টাকা, বেসরকারি ১০০ টাকা। প্রসঙ্গ বুঝে সংক্ষেপে জানাবে।
৪. কথাবার্তা শেষ বা কাঙ্ক্ষিত চাকরি না থাকলে: কাস্টমারকে বলবে— "আপনি আমাদের হোয়াটসঅ্যাপ চ্যানেলে জয়েন হয়ে থাইকেন। ওইখানে সব চলমান নিয়োগ প্রতিনিয়ত আপলোড করা হয়, মাঝেমধ্যে চেক করবেন: ${CHANNEL_LINK}"
৫. পেমেন্ট আলোচনা: কাস্টমার বিকাশ/নগদ নম্বর চাইলে বা টাকা পাঠাতে চাইলে বলবে— "পেমেন্টের বিষয়ে আমাদের একজন টিম মেম্বার খুব শীঘ্রই নক দিচ্ছেন।" এবং মেসেজের শেষে [ALERT_ADMIN] লিখবে।
৬. অতিরিক্ত কোনো ভূমিকা বা অনাবশ্যক বড় লেকচার দেবে না। উত্তর হবে খুবই সংক্ষিপ্ত ও পয়েন্ট-টু-পয়েন্ট।

চলমান চাকরির কিছু তালিকা:
${jobsData}
`;

    if (!chatHistories.has(userPhone)) {
        chatHistories.set(userPhone, []);
    }
    const history = chatHistories.get(userPhone);

    // মেসেজ কনটেন্ট প্রস্তুত করা (ছবি থাকলে ভিশন ফরম্যাটে যাবে)
    let currentContent;
    if (base64Image) {
        currentContent = [
            { type: "text", text: userMessage || "এই সার্কুলারটি দেখে বলো এটা কি অনলাইনে আবেদন করা যাবে নাকি সরাসরি অফিস বা ডাকযোগে যেতে হবে? প্রয়োজনীয় তথ্য সংক্ষেপে বলো।" },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
        ];
    } else {
        currentContent = userMessage;
    }

    history.push({ role: "user", content: currentContent });
    if (history.length > 6) history.shift();

    const messagesToSend = [
        { role: "system", content: systemPrompt },
        ...history
    ];

    if (API_KEYS.length === 0) return "API Key পাওয়া যায়নি। Render চেক করুন।";

    // দ্বি-স্তরীয় ফলব্যাক লুপ (Key ➡️ Model)
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

                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                const reply = data.choices?.[0]?.message?.content?.trim();

                if (reply) {
                    history.push({ role: "assistant", content: reply });
                    return reply;
                }
            } catch (err) {
                console.log(`⚠️ Key #${k+1} এ মডেল ${currentModel} ফেইল করেছে। পরবর্তী চেষ্টা করা হচ্ছে...`);
            }
        }
    }
    return "দুঃখিত, বর্তমানে সংযোগে সমস্যা হচ্ছে। একটু পর আবার চেষ্টা করুন।";
}

// ==================== হোয়াটসঅ্যাপ ইভেন্ট হ্যান্ডলার ====================
async function syncKnownChannels() {
    if (!sock) return;
    for (const code of KNOWN_INVITES) {
        try {
            const meta = await sock.newsletterMetadata('invite', code);
            if (meta && meta.id) {
                discoveredChannels.set(meta.id, meta.name || code);
                discoveredChannels.set(code, meta.id);
            }
        } catch (err) {}
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

            let text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.documentMessage?.caption || "";
            let base64Image = null;

            // ছবি ডাউনলোড ও হ্যান্ডলিং
            if (msg.message?.imageMessage) {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    base64Image = buffer.toString('base64');
                } catch (e) {
                    console.error("Image download error:", e);
                }
            }

            // পিডিএফ ডাউনলোড ও টেক্সট কনভার্ট
            if (msg.message?.documentMessage && msg.message.documentMessage.mimetype === 'application/pdf') {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    const pdfData = await pdfParse(buffer);
                    text = `[পিডিএফ সার্কুলার ফাইল থেকে প্রাপ্ত টেক্সট]:\n${pdfData.text.slice(0, 3000)}\n\nকাস্টমারের প্রশ্ন: ${text || "এই নিয়োগ সম্পর্কে বিস্তারিত ও আবেদনের নিয়ম জানাও।"}`;
                } catch (e) {
                    console.error("PDF parse error:", e);
                }
            }

            if (!text.trim() && !base64Image) continue;

            // আপনি নিজে উত্তর দিলে ২৪ ঘণ্টার জন্য অটো-পজ হবে
            if (msg.key.fromMe) {
                if (text.trim() === "#start") {
                    pausedUsers.delete(jid);
                    await sock.sendMessage(jid, { text: "বট চালু করা হয়েছে।" });
                } else if (text.trim() === "#stop") {
                    pausedUsers.set(jid, Date.now() + 24 * 60 * 60 * 1000);
                    await sock.sendMessage(jid, { text: "বট বন্ধ করা হলো।" });
                } else {
                    pausedUsers.set(jid, Date.now() + 24 * 60 * 60 * 1000);
                }
                continue;
            }

            // পজ লিস্ট চেক
            if (pausedUsers.has(jid)) {
                if (Date.now() < pausedUsers.get(jid)) continue;
                pausedUsers.delete(jid);
            }

            // এআই রিপ্লাই তৈরি
            const aiResponse = await getAIReply(jid, text, base64Image);

            // পেমেন্ট ও অ্যাডমিন অ্যালার্ট
            if (aiResponse.includes("[ALERT_ADMIN]")) {
                const cleanReply = aiResponse.replace("[ALERT_ADMIN]", "").trim();
                await sock.sendMessage(jid, { text: cleanReply });

                if (ADMIN_NUMBER && ADMIN_NUMBER.includes("@s.whatsapp.net")) {
                    await sock.sendMessage(ADMIN_NUMBER, {
                        text: `⚠️ [পেমেন্ট অ্যালার্ট] কাস্টমার: ${jid.split('@')[0]}\nপেমেন্ট করতে চাচ্ছে। চ্যাটে নজর দিন!`
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
            connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Connected Successfully!');
            app.locals.qr = null;
            setTimeout(() => { syncKnownChannels(); }, 3000);
        }
    });
}

connectToWhatsApp();

// ==================== চ্যানেল পোস্ট API ও QR কোড ====================
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
        } catch (err) {}

        if (discoveredChannels.size > 0) {
            const keys = Array.from(discoveredChannels.keys()).filter(k => k.startsWith('120363'));
            if (keys.length > 0) return keys[0];
        }
    } catch (err) {}
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

        res.json({ status: 'success', message: 'Posted to channel successfully!', jid: targetJid });
    } catch (error) {
        res.status(500).json({ status: 'error', error: error.message });
    }
});

fetchLastTwoMonthsJobs();
setInterval(fetchLastTwoMonthsJobs, 12 * 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
