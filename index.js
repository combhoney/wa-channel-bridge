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

const DEFAULT_MODELS = "qwen3.5,glm-5.3-flash,gemma4:31b,gpt-oss:120b,gpt-oss:20b,nemotron-3-super,deepseek-v4-flash";
const MODELS = (process.env.LLM_MODELS || process.env.LLM_MODEL || DEFAULT_MODELS)
    .split(',')
    .map(m => m.trim())
    .filter(Boolean);

const LLM_API_URL = process.env.LLM_API_URL || "https://ollama.com/v1/chat/completions";

const pausedUsers = new Map();
const botSentMessageIds = new Set();

const KNOWN_INVITES = [
    "0029VbCsrU6IHphJ1G2Ctv0X",
    "0029VbDN5b3CsU9XlRYVRq0s",
    "0029VbDIfE217EmxC6bLbb3A"
];

// ==================== মাস্টার অন/অফ সুইচ (bot_status.json) ====================
const BOT_STATUS_FILE = './bot_status.json';

function isBotGloballyActive() {
    if (!fs.existsSync(BOT_STATUS_FILE)) return true;
    try {
        const data = JSON.parse(fs.readFileSync(BOT_STATUS_FILE, 'utf-8'));
        return data.active !== false;
    } catch (e) {
        return true;
    }
}

function setGlobalBotStatus(status) {
    try {
        fs.writeFileSync(BOT_STATUS_FILE, JSON.stringify({ active: status, time: Date.now() }, null, 2));
    } catch (e) {}
}

// ==================== ChatFilter.json (যাদের অলরেডি টেমপ্লেট দেওয়া হয়েছে) ====================
const CHAT_FILTER_FILE = './ChatFilter.json';

function getStoppedUsersList() {
    if (!fs.existsSync(CHAT_FILTER_FILE)) return new Set();
    try {
        const raw = fs.readFileSync(CHAT_FILTER_FILE, 'utf-8');
        const data = JSON.parse(raw);
        return new Set(Array.isArray(data) ? data : []);
    } catch (e) {
        return new Set();
    }
}

function addStoppedUser(jid) {
    const list = getStoppedUsersList();
    list.add(jid);
    try {
        fs.writeFileSync(CHAT_FILTER_FILE, JSON.stringify(Array.from(list), null, 2));
    } catch (e) {}
}

function isChatFiltered(jid) {
    const list = getStoppedUsersList();
    return list.has(jid);
}

// ==================== নির্দিষ্ট টেক্সট ফাইল থেকে মেসেজ পড়ার ফাংশন ====================
function getFileContent(fileName, defaultText) {
    const path = `./${fileName}`;
    if (fs.existsSync(path)) {
        try {
            const content = fs.readFileSync(path, 'utf-8').trim();
            if (content.length > 0) return content;
        } catch (e) {}
    }
    return defaultText;
}

// ==================== সার্কুলার স্ক্র্যাপার ও রিয়েল-টাইম সার্চ ====================
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
                        details: cleanHTML(post.content?.rendered || post.excerpt?.rendered || "").slice(0, 1000),
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

async function searchJobOnline(userMessage) {
    const cleanQuery = userMessage
        .replace(/(আবেদন|কিভাবে|করব|করতে|চাই|চাকরি|নিয়োগ|সার্কুলার|সম্পর্কে|জানতে|ভাই|বট|হবে|কি|আছে|তথ্য|প্লিজ)/gi, '')
        .trim();

    if (cleanQuery.length < 3) return null;

    if (fs.existsSync('./jobs.json')) {
        try {
            const jobs = JSON.parse(fs.readFileSync('./jobs.json', 'utf-8'));
            for (const job of jobs) {
                if (job.title.toLowerCase().includes(cleanQuery.toLowerCase())) {
                    return `বিজ্ঞপ্তি: ${job.title}\nবিস্তারিত: ${job.details}`;
                }
            }
        } catch (e) {}
    }

    const encoded = encodeURIComponent(cleanQuery);
    for (const site of JOB_SITES) {
        try {
            const res = await fetch(`${site}?search=${encoded}&per_page=1`, { signal: AbortSignal.timeout(3000) });
            if (res.ok) {
                const posts = await res.json();
                if (posts && posts.length > 0) {
                    const p = posts[0];
                    const fullText = cleanHTML(p.content?.rendered || p.excerpt?.rendered || "");
                    return `বিজ্ঞপ্তি: ${p.title.rendered}\nনিয়মাবলী: ${fullText.slice(0, 1500)}`;
                }
            }
        } catch (err) {}
    }
    return null;
}

// ==================== এআই ক্লাসিফায়ার (শুধুমাত্র ক্যাটাগরি বের করবে) ====================
async function classifyJobMethod(articleText, base64Image = null) {
    const systemPrompt = `
You are a job application method classifier.
Read the job circular details carefully and classify the application method into EXACTLY ONE of these 4 categories:
1. ONLINE (If applied via website, online portal, or teletalk online form)
2. FORM (If applied by sending physical form or documents via POST OFFICE / ডাকযোগে / কুরিয়ার)
3. WALKIN (If walk-in interview, or must physically go to their office for interview/document submission on specified dates)
4. BSL (If it is from BOESL / বোয়েসেল for overseas employment)

CRITICAL RULE:
Respond with ONLY ONE WORD: ONLINE, FORM, WALKIN, or BSL.
Do not write any explanation or punctuation.
`;

    let userContent;
    if (base64Image) {
        userContent = [
            { type: "text", text: "Classify this job circular: ONLINE, FORM, WALKIN, or BSL?" },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
        ];
    } else {
        userContent = `Job Circular Content:\n${articleText}`;
    }

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
                        messages: [
                            { role: "system", content: systemPrompt },
                            { role: "user", content: userContent }
                        ],
                        temperature: 0.0
                    })
                });

                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                let result = data.choices?.[0]?.message?.content?.trim().toUpperCase() || "";
                result = result.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

                if (result.includes("WALKIN") || result.includes("WALK-IN")) return "WALKIN";
                if (result.includes("FORM") || result.includes("POST") || result.includes("DAK")) return "FORM";
                if (result.includes("BSL") || result.includes("BOESL")) return "BSL";
                if (result.includes("ONLINE")) return "ONLINE";
            } catch (err) {}
        }
    }
    return "ONLINE"; // ডিফল্ট ক্যাটাগরি
}

// ==================== হোয়াটসঅ্যাপ কানেকশন ও হ্যান্ডলার ====================
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

    // মেসেজ রিসিভ
    sock.ev.on('messages.upsert', async (m) => {
        if (!m || !m.messages || m.type !== 'notify') return;

        for (const msg of m.messages) {
            const jid = msg.key?.remoteJid;
            const msgId = msg.key?.id;
            if (!jid) continue;

            const timestamp = (msg.messageTimestamp?.low || msg.messageTimestamp || 0) * 1000;
            if (timestamp && (Date.now() - timestamp > 60000)) continue;

            if (jid.endsWith('@newsletter') || jid.startsWith('120363')) {
                discoveredChannels.set(jid, jid);
                continue;
            }
            if (jid.endsWith('@g.us') || jid === 'status@broadcast') continue;

            if (botSentMessageIds.has(msgId)) {
                botSentMessageIds.delete(msgId);
                continue;
            }

            const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.documentMessage?.caption || "").trim();

            // এডমিনের কন্ট্রোল কমান্ড (#off, #on, #stop)
            if (msg.key.fromMe) {
                const cleanCmd = text.toLowerCase();
                if (cleanCmd === "#off") { setGlobalBotStatus(false); return; }
                if (cleanCmd === "#on") { setGlobalBotStatus(true); return; }
                if (cleanCmd === "#stop") { addStoppedUser(jid); pausedUsers.set(jid, Infinity); return; }
                pausedUsers.set(jid, Date.now() + 30 * 60 * 1000);
                continue;
            }

            // 🛑 মাস্টার সুইচ চেক
            if (!isBotGloballyActive()) continue;

            // 🚫 এই কাস্টমারকে কি পূর্বে টেমপ্লেট টেক্সট দেওয়া হয়েছে? হলে বট আজীবনের জন্য চুপ থাকবে!
            if (isChatFiltered(jid)) continue;

            if (pausedUsers.has(jid)) {
                if (Date.now() < pausedUsers.get(jid)) continue;
                pausedUsers.delete(jid);
            }

            let base64Image = null;
            let extractedPdfText = "";

            if (msg.message?.imageMessage) {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    base64Image = buffer.toString('base64');
                } catch (e) {}
            }

            if (msg.message?.documentMessage && msg.message.documentMessage.mimetype === 'application/pdf') {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    const pdfData = await pdfParse(buffer);
                    extractedPdfText = pdfData.text.slice(0, 2000);
                } catch (e) {}
            }

            if (!text && !base64Image && !extractedPdfText) continue;

            // ==================== ধাপ ১: সাধারণ কুশল বিনিময় (শুধুমাত্র সালাম/হাই) ====================
            const lowerText = text.toLowerCase();
            const isPureGreeting = /^(সালাম|আসসালামু\s*আলাইকুম|assalam|salam|slm|হাই|হ্যালো|hello|hi|hlw|kemon asen|kmn asen|কেমন আছেন|ভালো আছেন)[\s!?.]*$/i.test(text);

            if (isPureGreeting && !base64Image && !extractedPdfText) {
                let greetingReply = "জি ভাই, বলুন কীভাবে সাহায্য করতে পারি?";
                if (/সালাম|আসসালামু|salam|assalam|slm/i.test(text)) {
                    greetingReply = "ওয়ালাইকুম আসসালাম।";
                } else if (/কেমন আছেন|kemon asen|kmn asen|ভালো আছেন/i.test(text)) {
                    greetingReply = "আলহামদুলিল্লাহ, ভালো আছি।";
                }

                try { await sock.sendPresenceUpdate('composing', jid); } catch (e) {}
                await delay(1500);
                const sent = await sock.sendMessage(jid, { text: greetingReply });
                if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
                try { await sock.sendPresenceUpdate('paused', jid); } catch (e) {}
                continue; // কুশল বিনিময় শেষে কাস্টমারের পরবর্তী মূল প্রশ্নের অপেক্ষা করবে
            }

            // ==================== ধাপ ২: নিয়োগ সম্পর্কিত প্রশ্ন বা আবেদন পদ্ধতি যাচাই ====================
            try { await sock.sendPresenceUpdate('composing', jid); } catch (e) {}

            let methodCategory = "ONLINE";

            // ক) যদি বোয়েসেল সম্পর্কিত হয়
            if (/বোয়েসেল|বোয়েসেল|boesl/i.test(text)) {
                methodCategory = "BSL";
            } 
            // খ) যদি ছবি বা পিডিএফ পাঠায়
            else if (base64Image || extractedPdfText) {
                methodCategory = await classifyJobMethod(extractedPdfText, base64Image);
            } 
            // গ) যদি চাকরির নাম লিখে সার্চ করতে হয়
            else {
                const article = await searchJobOnline(text);
                if (article) {
                    methodCategory = await classifyJobMethod(article, null);
                } else {
                    // নির্দিষ্ট না পেলে টেক্সট থেকেই ক্লাসিফাই করবে
                    methodCategory = await classifyJobMethod(text, null);
                }
            }

            // ==================== ধাপ ৩: উপযুক্ত টেক্সট ফাইল থেকে মেসেজ ডেলিভারি ====================
            let finalReply = "";

            if (methodCategory === "WALKIN") {
                finalReply = getFileContent("walkin.txt", "এটি সরাসরি অফিসে গিয়ে ইন্টারভিউ দিতে হবে বা কাগজপত্র জমা দিতে হবে। অনলাইনে আবেদন করা যাবে না।");
            } else if (methodCategory === "FORM") {
                finalReply = getFileContent("form.txt", "এটি ডাকযোগে বা কুরিয়ারে আবেদন ফরম পাঠাতে হবে। অনলাইনে আবেদন করা যাবে না।");
            } else if (methodCategory === "BSL") {
                finalReply = getFileContent("bsl.txt", "বোয়েসেলের এই নিয়োগে তাদের নিয়ম অনুযায়ী আবেদন সম্পন্ন করতে হবে।");
            } else {
                // ডিফল্ট অনলাইন আবেদন
                finalReply = getFileContent("online.txt", "হ্যাঁ ভাই, এটা আমরা অনলাইনে আবেদন করে দিতে পারব। আপনার প্রয়োজনীয় কাগজপত্র পাঠিয়ে দিন।");
            }

            await delay(2000);

            // টেক্সট ফাইল থেকে হুবহু মেসেজটি পাঠিয়ে দেওয়া
            const sent = await sock.sendMessage(jid, { text: finalReply });
            if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
            try { await sock.sendPresenceUpdate('paused', jid); } catch (e) {}

            // 🔒 অতি গুরুত্বপূর্ণ: টেক্সট পাঠানো শেষ! এই কাস্টমারকে আজীবনের জন্য লক করা হলো।
            addStoppedUser(jid);
            pausedUsers.set(jid, Infinity);
            console.log(`🛑 ${jid} নম্বরে ${methodCategory} টেমপ্লেট পাঠানো হয়েছে এবং বট পার্মানেন্ট পজ করা হয়েছে।`);
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) app.locals.qr = qr;

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === DisconnectReason.loggedOut) {
                if (fs.existsSync('baileys_auth')) {
                    fs.rmSync('baileys_auth', { recursive: true, force: true });
                }
            }
            connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Connected Successfully!');
            app.locals.qr = null;
            setTimeout(() => { syncKnownChannels(); }, 3000);
        }
    });
}

connectToWhatsApp();

// ==================== রিসেট, QR কোড ও চ্যানেল পোস্ট API ====================
app.get('/reset', (req, res) => {
    try {
        if (fs.existsSync('baileys_auth')) {
            fs.rmSync('baileys_auth', { recursive: true, force: true });
        }
        app.locals.qr = null;
        connectToWhatsApp();
        res.send('<h2 style="font-family:sans-serif;text-align:center;color:blue;">🔄 সেশন রিসেট হয়েছে! ২ সেকেন্ড পর <a href="/qr">এখানে ক্লিক করে QR স্ক্যান করুন</a>।</h2>');
    } catch (e) {
        res.send('Reset error: ' + e.message);
    }
});

app.get('/qr', async (req, res) => {
    if (app.locals.qr) {
        const qrImage = await QRCode.toDataURL(app.locals.qr);
        res.send(`<h2 style="font-family:sans-serif;text-align:center;">Scan with WhatsApp:</h2><div style="text-align:center;"><img src="${qrImage}"/></div>`);
    } else {
        res.send('<h2 style="font-family:sans-serif;text-align:center;color:green;">✅ WhatsApp is Already Connected!</h2>');
    }
});

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

// 📢 চ্যানেলে অটো-পোস্ট রুট (২৪/৭ চালু থাকবে)
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
