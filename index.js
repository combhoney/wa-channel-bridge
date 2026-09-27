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
const CHANNEL_LINK = "https://whatsapp.com/channel/0029VbDIfE217EmxC6bLbb3A";

// ট্র্যাকিং
const chatHistories = new Map();
const pausedUsers = new Map();
const channelSentUsers = new Set();
const botSentMessageIds = new Set();

const KNOWN_INVITES = [
    "0029VbCsrU6IHphJ1G2Ctv0X",
    "0029VbDN5b3CsU9XlRYVRq0s",
    "0029VbDIfE217EmxC6bLbb3A"
];

// ==================== ChatFilter.json হ্যান্ডলার (#Stop / #Start) ====================
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

function updateChatFilter(jid, action) {
    const list = getStoppedUsersList();
    if (action === 'stop') {
        list.add(jid);
    } else if (action === 'start') {
        list.delete(jid);
    }

    try {
        fs.writeFileSync(CHAT_FILTER_FILE, JSON.stringify(Array.from(list), null, 2));
    } catch (e) {
        console.error("ChatFilter.json write error:", e);
    }
}

function isChatFiltered(jid) {
    const list = getStoppedUsersList();
    return list.has(jid);
}

// ==================== history.json ডায়নামিক মেমোরি হ্যান্ডলার ====================
const HISTORY_FILE = './history.json';
const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000;

function getCustomerMemory(userPhone) {
    if (!fs.existsSync(HISTORY_FILE)) return null;
    try {
        const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
        return data[userPhone] || null;
    } catch (e) {
        return null;
    }
}

function saveDynamicMemory(userPhone, profileUpdate = {}, hasMedia = false) {
    let data = {};
    if (fs.existsSync(HISTORY_FILE)) {
        try {
            data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
        } catch (e) {
            data = {};
        }
    }

    const now = Date.now();

    for (const [phone, profile] of Object.entries(data)) {
        if (profile.last_active && (now - profile.last_active > SIX_MONTHS_MS)) {
            delete data[phone];
        }
    }

    const current = data[userPhone] || {
        last_active: now,
        interests: [],
        docs_provided: false,
        notes: ""
    };

    current.last_active = now;

    if (hasMedia || profileUpdate.docs_provided === true) {
        current.docs_provided = true;
    }

    if (profileUpdate.interest && typeof profileUpdate.interest === 'string') {
        const newInt = profileUpdate.interest.trim();
        if (newInt && !current.interests.includes(newInt)) {
            current.interests.push(newInt);
        }
    }

    if (profileUpdate.note) {
        current.notes = current.notes ? `${current.notes}; ${profileUpdate.note}` : profileUpdate.note;
    }

    data[userPhone] = current;

    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error("history.json write error:", e);
    }
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
                        details: cleanHTML(post.content?.rendered || post.excerpt?.rendered || "").slice(0, 500),
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

// 🔍 কাস্টমার নাম বললে ওয়েবসাইটগুলোতে রিয়েল-টাইম সার্চ করার ফাংশন
async function searchJobOnline(userMessage) {
    // সাধারণ প্রশ্ন বা কুশল বিনিময় হলে সার্চ করবে না
    if (userMessage.length < 4) return null;

    // অপ্রয়োজনীয় শব্দ বাদ দিয়ে মূল চাকরির নাম বের করা
    const cleanQuery = userMessage
        .replace(/(আবেদন|কিভাবে|করব|করতে|চাই|চাকরি|নিয়োগ|সার্কুলার|সম্পর্কে|জানতে|ভাই|বট|হবে|কি|আছে|তথ্য|প্লিজ)/gi, '')
        .trim();

    if (cleanQuery.length < 3) return null;

    // ১. প্রথমে লোকাল jobs.json এ খোঁজা
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

    // ২. লোকাল ফাইলে না থাকলে নির্দিষ্ট ওয়েবসাইট ৩টিতে সরাসরি সার্চ করা
    const encoded = encodeURIComponent(cleanQuery);
    for (const site of JOB_SITES) {
        try {
            const res = await fetch(`${site}?search=${encoded}&per_page=1`, { signal: AbortSignal.timeout(3000) });
            if (res.ok) {
                const posts = await res.json();
                if (posts && posts.length > 0) {
                    const p = posts[0];
                    const fullText = cleanHTML(p.content?.rendered || p.excerpt?.rendered || "");
                    return `বিজ্ঞপ্তি: ${p.title.rendered}\nনিয়মাবলী ও বিবরণ: ${fullText.slice(0, 1000)}`;
                }
            }
        } catch (err) {}
    }

    return null;
}

// ==================== এআই লজিক ও আবেদন মাধ্যম ভেরিফিকেশন ====================
async function getAIReply(userPhone, userMessage, base64Image = null, hasMedia = false) {
    const hasChannelLinkAlready = channelSentUsers.has(userPhone);
    const userMemory = getCustomerMemory(userPhone);

    // যদি কাস্টমার ছবি না দেয়, তবে ইন্টারনেটে সার্কুলারটি সার্চ করে যাচাই করা
    let searchedJobInfo = "";
    if (!base64Image) {
        const found = await searchJobOnline(userMessage);
        if (found) {
            searchedJobInfo = `\n[ওয়েবসাইটে প্রাপ্ত সার্কুলারের আসল তথ্য]:\n${found}\n`;
        }
    }

    let memoryContext = "";
    if (userMemory) {
        memoryContext = `
[কাস্টমারের পূর্বের প্রোফাইল ও তথ্য]:
- পছন্দ বা আগ্রহ: ${userMemory.interests?.length > 0 ? userMemory.interests.join(", ") : "জানা নেই"}
- প্রয়োজনীয় কাগজপত্র জমা আছে কি না: ${userMemory.docs_provided ? "হ্যাঁ, জমা আছে (পুনরায় চাইবে না)" : "না"}
- অন্যান্য নোট: ${userMemory.notes || "নাই"}
`;
    }

    const systemPrompt = `
তুমি একজন চাকরির অনলাইন আবেদন সহকারী। তোমার প্রথম ও প্রধান দায়িত্ব হলো—যেকোনো সার্কুলারের ক্ষেত্রে এটি কীভাবে আবেদন করতে হবে (অনলাইন নাকি ডাকযোগ নাকি সরাসরি অফিসে যাওয়া) তা আগে নিশ্চিত হওয়া।

${searchedJobInfo}
${memoryContext}

কঠোর যাচাই ও উত্তর দেওয়ার নিয়মাবলী:
১. আবেদনের মাধ্যম যাচাই (সবচেয়ে গুরুত্বপূর্ণ):
   - যদি বিজ্ঞপ্তিতে অনলাইন ওয়েবসাইট বা Teletalk লিংক থাকে: "হ্যাঁ ভাই, এটা অনলাইনে আবেদন করা যাবে। আবেদন ফি ছাড়া সার্ভিস চার্জ সরকারি ৫০ টাকা / বেসরকারি ১০০ টাকা। আবেদন করতে চাইলে প্রয়োজনীয় কাগজপত্র পাঠান।"
   - যদি ডাকযোগে বা কুরিয়ারে পাঠানোর কথা থাকে: "এটা তো অনলাইনে আবেদন করা যাবে না ভাই, ডাক বিভাগের/কুরিয়ারের মাধ্যমে কাগজপত্র পাঠাতে হবে।"
   - যদি সরাসরি সাক্ষাৎকার (Walk-in Interview) বা অফিসে উপস্থিত হওয়ার কথা থাকে: "এটা তো অনলাইনে আবেদন হবে না ভাই, সরাসরি তাদের অফিসে গিয়ে ইন্টারভিউ দিতে হবে/কাগজপত্র জমা দিতে হবে।"
   - যদি কাস্টমার কোনো সার্কুলারের নাম বলে কিন্তু উপরে প্রাপ্ত তথ্যে বা তোমার কাছে সেটির সঠিক হদিস না থাকে: "এই নিয়োগটির সঠিক তথ্য খুঁজে পাচ্ছি না ভাই, আপনার কাছে সার্কুলারের কোনো ছবি বা পিডিএফ থাকলে পাঠিয়ে দিন, দেখে নিশ্চিত করে বলে দিচ্ছি।"

২. সহজ ও সংক্ষিপ্ত ডেলিভারি: উত্তর হবে সর্বোচ্চ ১ থেকে ২ লাইনের। কোনো অতিরিক্ত ভূমিকা বা নীতিবাক্য লিখবে না। কাস্টমার বাংলিশে লিখলে তা বুঝে বাংলায় উত্তর দেবে।
৩. কাগজপত্র হ্যান্ডলিং: কাস্টমার পূর্বে কাগজপত্র জমা দিয়ে থাকলে (${userMemory?.docs_provided ? "হ্যাঁ দিয়েছে" : "না দেয় নাই"}), তার কাছে আর নতুন করে কাগজপত্র চাইবে না।
৪. সার্ভিস চার্জ: সরকারি চাকরির অনলাইন আবেদন ৫০ টাকা, বেসরকারি ১০০ টাকা।
${!hasChannelLinkAlready ? `৫. কথা শেষ হলে বা চাকরি না থাকলে একবার চ্যানেলে যুক্ত হতে বলবে: "${CHANNEL_LINK}"` : `৫. চ্যানেলের লিংক পূর্বে দেওয়া হয়ে গেছে, তাই নতুন করে লিংক দিবে না।`}
৬. পেমেন্ট আলোচনা: বিকাশ/নগদ নম্বর চাইলে বলবে "পেমেন্টের জন্য আমাদের একজন প্রতিনিধি খুব শীঘ্রই যোগাযোগ করছেন।" এবং শেষে [ALERT_ADMIN] লিখবে।

৭. মেমোরি আপডেট:
কথোপকথন থেকে কাস্টমারের যেকোনো নতুন আগ্রহ (কাজের ধরন, শিক্ষাগত যোগ্যতা, জেলা) বা নতুন তথ্য পেলে উত্তরের শেষে লিখবে:
[PROFILE_UPDATE: {"interest": "কাস্টমারের আগ্রহ", "docs_provided": true/false, "note": "সংক্ষিপ্ত তথ্য"}]
`;

    if (!chatHistories.has(userPhone)) {
        chatHistories.set(userPhone, []);
    }
    const history = chatHistories.get(userPhone);

    let currentContent;
    if (base64Image) {
        currentContent = [
            { type: "text", text: userMessage || "বিজ্ঞপ্তিটি দেখে নিশ্চিত হয়ে ১-২ লাইনে বলো এটা অনলাইনে আবেদন হবে, নাকি ডাকযোগে, নাকি সরাসরি অফিসে যেতে হবে?" },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
        ];
    } else {
        currentContent = userMessage;
    }

    history.push({ role: "user", content: currentContent });
    if (history.length > 8) history.shift();

    const messagesToSend = [
        { role: "system", content: systemPrompt },
        ...history
    ];

    if (API_KEYS.length === 0) return "API Key পাওয়া যায়নি। Render চেক করুন।";

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
                        temperature: 0.1
                    })
                });

                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                let reply = data.choices?.[0]?.message?.content?.trim();

                if (reply) {
                    const profileMatch = reply.match(/\[PROFILE_UPDATE:\s*({.*?})\]/s);
                    if (profileMatch) {
                        try {
                            const updateObj = JSON.parse(profileMatch[1]);
                            saveDynamicMemory(userPhone, updateObj, hasMedia);
                        } catch (e) {}
                        reply = reply.replace(/\[PROFILE_UPDATE:\s*({.*?})\]/s, '').trim();
                    } else if (hasMedia) {
                        saveDynamicMemory(userPhone, {}, true);
                    }

                    history.push({ role: "assistant", content: reply });
                    if (reply.includes(CHANNEL_LINK)) {
                        channelSentUsers.add(userPhone);
                    }
                    return reply;
                }
            } catch (err) {}
        }
    }
    return "সংযোগের সমস্যা হচ্ছে ভাই, একটু পর মেসেজ দিন।";
}

// ==================== হোয়াটসঅ্যাপ কানেকশন ও ইভেন্ট ====================
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

    sock.ev.on('call', async (calls) => {
        for (const call of calls) {
            if (call.status === 'offer') {
                const callerJid = call.from;
                if (isChatFiltered(callerJid)) continue;

                try {
                    await sock.sendPresenceUpdate('composing', callerJid);
                    await delay(1500);
                } catch (e) {}
                const sentMsg = await sock.sendMessage(callerJid, {
                    text: "দয়া করে কল না দিয়ে আপনার বিষয়টি মেসেজে লিখে জানান ভাই, আমরা মেসেজেই সাহায্য করব।"
                });
                if (sentMsg?.key?.id) botSentMessageIds.add(sentMsg.key.id);
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (!m || !m.messages) return;

        for (const msg of m.messages) {
            const jid = msg.key?.remoteJid;
            const msgId = msg.key?.id;
            if (!jid) continue;

            if (jid.endsWith('@newsletter') || jid.startsWith('120363')) {
                discoveredChannels.set(jid, jid);
                continue;
            }
            if (jid.endsWith('@g.us') || jid === 'status@broadcast') continue;

            if (botSentMessageIds.has(msgId)) {
                botSentMessageIds.delete(msgId);
                continue;
            }

            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.documentMessage?.caption || "";

            // #Stop ও #Start কমান্ড
            if (msg.key.fromMe) {
                const cleanCmd = text.trim().toLowerCase();

                if (cleanCmd === "#stop") {
                    updateChatFilter(jid, 'stop');
                    pausedUsers.set(jid, Infinity);
                    const sent = await sock.sendMessage(jid, { text: "🛑 এই চ্যাটে এআই বট বন্ধ করা হলো। পুনরায় চালু করতে #Start লিখুন।" });
                    if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
                    return;
                } 
                
                if (cleanCmd === "#start") {
                    updateChatFilter(jid, 'start');
                    pausedUsers.delete(jid);
                    const sent = await sock.sendMessage(jid, { text: "✅ এই চ্যাটে এআই বট পুনরায় চালু করা হলো।" });
                    if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
                    return;
                }

                pausedUsers.set(jid, Date.now() + 30 * 60 * 1000);
                continue;
            }

            if (isChatFiltered(jid)) continue;

            if (pausedUsers.has(jid)) {
                if (Date.now() < pausedUsers.get(jid)) continue;
                pausedUsers.delete(jid);
            }

            let base64Image = null;
            let hasMedia = false;

            if (msg.message?.imageMessage) {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    base64Image = buffer.toString('base64');
                    hasMedia = true;
                } catch (e) {}
            }

            if (msg.message?.documentMessage && msg.message.documentMessage.mimetype === 'application/pdf') {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    const pdfData = await pdfParse(buffer);
                    text = `[পিডিএফ সার্কুলার টেক্সট]:\n${pdfData.text.slice(0, 2000)}\n\nকাস্টমার: ${text || "আবেদনের নিয়ম জানাও।"}`;
                    hasMedia = true;
                } catch (e) {}
            }

            if (!text.trim() && !base64Image) continue;

            try {
                await sock.sendPresenceUpdate('composing', jid);
            } catch (e) {}

            // এআই উত্তর তৈরি (সার্চ ও ভেরিফিকেশন সহ)
            const aiResponse = await getAIReply(jid, text, base64Image, hasMedia);

            await delay(2200);

            if (aiResponse.includes("[ALERT_ADMIN]")) {
                const cleanReply = aiResponse.replace("[ALERT_ADMIN]", "").trim();
                const sent1 = await sock.sendMessage(jid, { text: cleanReply });
                if (sent1?.key?.id) botSentMessageIds.add(sent1.key.id);

                if (ADMIN_NUMBER && ADMIN_NUMBER.includes("@s.whatsapp.net")) {
                    await sock.sendMessage(ADMIN_NUMBER, {
                        text: `⚠️ [পেমেন্ট অ্যালার্ট] কাস্টমার: ${jid.split('@')[0]}\nপেমেন্ট করতে চাচ্ছে। চ্যাটে নজর দিন!`
                    });
                }
                pausedUsers.set(jid, Date.now() + 24 * 60 * 60 * 1000);
                continue;
            }

            const sent = await sock.sendMessage(jid, { text: aiResponse });
            if (sent?.key?.id) botSentMessageIds.add(sent.key.id);

            try {
                await sock.sendPresenceUpdate('paused', jid);
            } catch (e) {}
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) app.locals.qr = qr;

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === DisconnectReason.loggedOut) {
                console.log('সেশন লগআউট হয়ে গেছে! পুরনো ফাইল ডিলিট করা হচ্ছে...');
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

// 🔄 আটকে থাকা সেশন এক ক্লিকে মুছে ফ্রেশ QR কোড আনার রাউট
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
