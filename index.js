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

const chatHistories = new Map();
const pausedUsers = new Map();
const lastSentReplies = new Map(); // একই উত্তরের পুনরাবৃত্তি আটকানোর জন্য
const botSentMessageIds = new Set();

const KNOWN_INVITES = [
    "0029VbCsrU6IHphJ1G2Ctv0X",
    "0029VbDN5b3CsU9XlRYVRq0s",
    "0029VbDIfE217EmxC6bLbb3A"
];

// ==================== ChatFilter.json হ্যান্ডলার (#Stop সাইলেন্ট) ====================
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
        console.log(`🤫 ChatFilter.json-এ সাইলেন্টলি স্টপ সেভ হয়েছে: ${jid}`);
    } catch (e) {
        console.error("ChatFilter.json write error:", e);
    }
}

function isChatFiltered(jid) {
    const list = getStoppedUsersList();
    return list.has(jid);
}

// ==================== history.json পার্মানেন্ট মেমোরি হ্যান্ডলার ====================
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

function saveDynamicMemory(userPhone, profileUpdate = {}, hasMedia = false, linkSent = false) {
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
        channel_link_sent: false,
        notes: ""
    };

    current.last_active = now;

    if (hasMedia || profileUpdate.docs_provided === true) {
        current.docs_provided = true;
    }

    if (linkSent || profileUpdate.channel_link_sent === true) {
        current.channel_link_sent = true;
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

async function searchJobOnline(userMessage) {
    if (userMessage.length < 4) return null;

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
                    return `বিজ্ঞপ্তি: ${p.title.rendered}\nনিয়মাবলী: ${fullText.slice(0, 1000)}`;
                }
            }
        } catch (err) {}
    }

    return null;
}

// ==================== এআই লজিক ও সেলফ-রিফ্লেকশন ====================
async function getAIReply(userPhone, userMessage, base64Image = null, hasMedia = false) {
    const userMemory = getCustomerMemory(userPhone);
    const alreadyGotChannelLink = userMemory?.channel_link_sent === true;

    const isJobInquiry = /(চাকরি|নিয়োগ|সার্কুলার|আবেদন|পদ|job|circular|apply)/i.test(userMessage) || base64Image !== null;

    let searchedJobInfo = "";
    if (!base64Image && isJobInquiry) {
        const found = await searchJobOnline(userMessage);
        if (found) {
            searchedJobInfo = `\n[সার্কুলার তথ্য]:\n${found}\n`;
        }
    }

    let memoryContext = "";
    if (userMemory) {
        memoryContext = `
[কাস্টমার রেকর্ড]:
- পছন্দ: ${userMemory.interests?.length > 0 ? userMemory.interests.join(", ") : "জানা নেই"}
- কাগজপত্র জমা আছে কি না: ${userMemory.docs_provided ? "হ্যাঁ, পূর্বে দিয়েছে (নতুন করে চাইবে না)" : "না"}
`;
    }

    let channelInstruction = "";
    if (!alreadyGotChannelLink && isJobInquiry) {
        channelInstruction = `\n- যেহেতু কাস্টমার নিয়োগ নিয়ে জানতে চেয়েছে এবং পূর্বে লিংক পায়নি, তাই উত্তরের সাথে একবার লিংক দাও: "${CHANNEL_LINK}"`;
    } else {
        channelInstruction = `\n- চ্যানেলের কোনো লিংক দেবে না।`;
    }

    const systemPrompt = `
তুমি একজন অনলাইন চাকরির আবেদন সহকারী। আমরা শুধুমাত্র "অনলাইন আবেদন"-এর সার্ভিস প্রদান করি।

🚨 অতি-গুরুত্বপূর্ণ ব্যবসায়িক নিয়মাবলী:
১. বিজ্ঞপ্তির মাধ্যম যাচাই ও উত্তর:
   - ডাকযোগে হলে: "আমরা শুধু অনলাইনে আবেদন করে দিয়ে থাকি, আর আপনি যে নিয়োগটি দিয়েছেন এটাতে বলা হয়েছে ডাকযোগে আপনার ডকুমেন্টসগুলো পাঠাতে।"
   - সরাসরি অফিসে গিয়ে জমা/ইন্টারভিউ হলে: "আমরা শুধু অনলাইনে আবেদন করে দিয়ে থাকি, আর এটাতে সরাসরি তাদের অফিসে গিয়ে কাগজপত্র জমা দিতে বলা হয়েছে।"
   - কাস্টমার যদি জিজ্ঞেস করে "আপনি পারবেন কিনা?": "না, আমরা শুধুমাত্র অনলাইনে যে আবেদনগুলো করার সুযোগ থাকে সেগুলোই আবেদন করে দিয়ে থাকি।"
   - যদি অনলাইন আবেদন হয়: "হ্যাঁ ভাই, এটা অনলাইনে আবেদন করা যাবে। আবেদন ফি এর সাথে ১০০ টাকা খরচ লাগবে।"
   - যদি কোনো বিষয়ে কনফিউজড হও বা নিশ্চিত না হও: "শীঘ্রই আমাদের একজন প্রতিনিধি আপনার সাথে যোগাযোগ করবে।"
   - যদি কাস্টমারের কথা অর্থহীন, অপ্রাসঙ্গিক বা চাকরির সাথে সম্পর্কহীন হয়: "চাকরির আবেদন সংক্রান্ত কোনো সাহায্য লাগলে বলুন।"

২. খরচ / ফি: খরচের কথা জানতে চাইলে সরাসরি বলবে: "আবেদন ফি এর সাথে ১০০ টাকা খরচ লাগবে।" (কোনো অবস্থাতেই 'সার্ভিস চার্জ' বলবে না)।
৩. কাগজপত্র: কাস্টমার পূর্বে কাগজপত্র জমা দিয়ে থাকলে (${userMemory?.docs_provided ? "হ্যাঁ দিয়েছে" : "না দেয় নাই"}), তার কাছে আর নতুন করে কাগজপত্র চাইবে না।
${channelInstruction}
৪. পেমেন্ট আলোচনা: বিকাশ/নগদ নম্বর চাইলে বলবে "পেমেন্টের জন্য আমাদের প্রতিনিধি শীঘ্রই যোগাযোগ করছেন।" এবং শেষে [ALERT_ADMIN] লিখবে।

🧠 সেলফ-রিফ্লেকশন (Thinking):
- মনে মনে চিন্তা করো: "আমি এই উত্তরটি কি আরও ছোট করতে পারি? এটি কি ১ লাইনে শেষ করা সম্ভব?"
- কোনো অপ্রাসঙ্গিক শুভেচ্ছা, বড় ভূমিকা বা বাড়তি বাক্য সম্পূর্ণ নিষিদ্ধ।
- শুধুমাত্র চূড়ান্ত ১ লাইনের অতি-সংক্ষিপ্ত উত্তরটি প্রকাশ করবে।

৫. প্রোফাইল নোট:
কথোপকথন থেকে কাস্টমারের কোনো নতুন আগ্রহ বা তথ্য পেলে উত্তরের শেষে লিখবে:
[PROFILE_UPDATE: {"interest": "আগ্রহের বিষয়", "docs_provided": true/false}]

${searchedJobInfo}
${memoryContext}
`;

    if (!chatHistories.has(userPhone)) {
        chatHistories.set(userPhone, []);
    }
    const history = chatHistories.get(userPhone);

    let currentContent;
    if (base64Image) {
        currentContent = [
            { type: "text", text: userMessage || "বিজ্ঞপ্তিটি দেখে ১ লাইনে জানাও এটা অনলাইন আবেদন, নাকি ডাকযোগে বা সরাসরি অফিসে যেতে হবে?" },
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

    if (API_KEYS.length === 0) return "API Key পাওয়া যায়নি।";

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
                    reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

                    let linkSentNow = false;
                    if (reply.includes(CHANNEL_LINK)) {
                        linkSentNow = true;
                    }

                    const profileMatch = reply.match(/\[PROFILE_UPDATE:\s*({.*?})\]/s);
                    if (profileMatch) {
                        try {
                            const updateObj = JSON.parse(profileMatch[1]);
                            saveDynamicMemory(userPhone, updateObj, hasMedia, linkSentNow);
                        } catch (e) {}
                        reply = reply.replace(/\[PROFILE_UPDATE:\s*({.*?})\]/s, '').trim();
                    } else {
                        saveDynamicMemory(userPhone, {}, hasMedia, linkSentNow);
                    }

                    history.push({ role: "assistant", content: reply });
                    return reply;
                }
            } catch (err) {}
        }
    }
    return "শীঘ্রই আমাদের একজন প্রতিনিধি আপনার সাথে যোগাযোগ করবে।";
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
        // 🔥 ফিক্স ১: রিস্টার্টের সময় পুরনো হিস্ট্রি মেসেজ ইগনোর করা
        if (!m || !m.messages || m.type !== 'notify') return;

        for (const msg of m.messages) {
            const jid = msg.key?.remoteJid;
            const msgId = msg.key?.id;
            if (!jid) continue;

            // 🔥 ফিক্স ২: ১ মিনিটের বেশি পুরানো মেসেজ সম্পূর্ণ ইগনোর করা (যাতে মেসেজ রিপিট না হয়)
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

            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.documentMessage?.caption || "";

            // 🔥 ফিক্স ৩: সম্পূর্ণ সাইলেন্ট #Stop (চ্যাটে কোনো ফিরতি মেসেজ যাবে না!)
            if (msg.key.fromMe) {
                const cleanCmd = text.trim().toLowerCase();

                if (cleanCmd === "#stop") {
                    addStoppedUser(jid); // ChatFilter.json এ যুক্ত হবে
                    pausedUsers.set(jid, Infinity);
                    // 🤫 কোনো মেসেজ না পাঠিয়ে নীরবে রিটার্ন করবে!
                    return;
                }

                pausedUsers.set(jid, Date.now() + 30 * 60 * 1000);
                continue;
            }

            // 🚫 ChatFilter চেক: বন্ধ থাকলে ১ অক্ষরের মেসেজও যাবে না
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
                    text = `[পিডিএফ সার্কুলার টেক্সট]:\n${pdfData.text.slice(0, 1500)}\n\nকাস্টমার: ${text || "আবেদনের নিয়ম জানাও।"}`;
                    hasMedia = true;
                } catch (e) {}
            }

            if (!text.trim() && !base64Image) continue;

            try {
                await sock.sendPresenceUpdate('composing', jid);
            } catch (e) {}

            const aiResponse = await getAIReply(jid, text, base64Image, hasMedia);

            // 🔥 ফিক্স ৪: একই মেসেজ পরপর দুইবার পাঠানো বন্ধ করা
            if (lastSentReplies.get(jid) === aiResponse) {
                try { await sock.sendPresenceUpdate('paused', jid); } catch (e) {}
                continue;
            }

            await delay(2000);

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
            if (sent?.key?.id) {
                botSentMessageIds.add(sent.key.id);
                lastSentReplies.set(jid, aiResponse);
            }

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
