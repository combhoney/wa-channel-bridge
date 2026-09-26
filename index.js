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
        console.log(`📁 ChatFilter.json আপডেট হয়েছে: ${jid} -> ${action}`);
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

// ==================== সার্কুলার স্ক্র্যাপার ====================
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

// ==================== এআই লজিক ও প্রম্পট ====================
async function getAIReply(userPhone, userMessage, base64Image = null, hasMedia = false) {
    let jobsData = "";
    if (fs.existsSync('./jobs.json')) {
        try {
            const jobs = JSON.parse(fs.readFileSync('./jobs.json', 'utf-8'));
            jobsData = jobs.slice(0, 20).map(j => `- ${j.title} (${j.date})`).join("\n");
        } catch (e) {}
    }

    const hasChannelLinkAlready = channelSentUsers.has(userPhone);
    const userMemory = getCustomerMemory(userPhone);

    let memoryContext = "";
    if (userMemory) {
        memoryContext = `
[কাস্টমারের পূর্বের প্রোফাইল ও তথ্য]:
- পছন্দ বা আগ্রহ: ${userMemory.interests?.length > 0 ? userMemory.interests.join(", ") : "জানা নেই"}
- প্রয়োজনীয় কাগজপত্র পূর্বে জমা দেওয়া আছে কি না: ${userMemory.docs_provided ? "হ্যাঁ, জমা দেওয়া আছে (নতুন করে চাইবে না)" : "না"}
- পূর্বের অন্যান্য নোট: ${userMemory.notes || "নাই"}
`;
    }

    const systemPrompt = `
তুমি একজন আন্তরিক, বন্ধুসুলভ চাকরির অনলাইন আবেদন সহকারী। তোমার ভাষা হবে অত্যন্ত সহজ-সরল, মার্জিত, প্রাসঙ্গিক এবং ১ থেকে ২ লাইনের সংক্ষিপ্ত কিন্তু সম্পূর্ণ।

${memoryContext}

নির্দেশনা ও নিয়মাবলী:
১. সহজ ও প্রাসঙ্গিক ডেলিভারি: কোনো কাঠখোট্টা বা রোবটের মতো বইয়ের ভাষা ব্যবহার করবে না। কাস্টমার ঠিক যে বিষয়ে প্রশ্ন করেছে, অপ্রাসঙ্গিক কথা না বাড়িয়ে মিষ্টি ও সহজ ভাষায় উত্তর দাও।
২. বাংলিশ বোঝা: কাস্টমার বাংলিশে লিখলে তা বুঝে বাংলায় স্বাভাবিক ও প্রাঞ্জল উত্তর দেবে।
৩. কাগজপত্র হ্যান্ডলিং: কাস্টমার যদি পূর্বে কাগজপত্র জমা দিয়ে থাকে (${userMemory?.docs_provided ? "হ্যাঁ দিয়েছে" : "না দেয় নাই"}), তবে তার কাছে আর নতুন করে কাগজপত্র চাইবে না। শুধু বলবে কোন পদের জন্য আবেদন করতে চায়।
৪. সার্কুলার যাচাই:
   - সরাসরি অফিসে যাওয়ার হলে: "এটা তো অনলাইনে আবেদন করা যাবে না ভাই, সরাসরি তাদের অফিসে গিয়ে ইন্টারভিউ দিতে হবে/কাগজপত্র জমা দিতে হবে।"
   - ডাকযোগে পাঠানোর হলে: "এটা অনলাইনে আবেদন করা যাবে না ভাই, ডাক বিভাগের মাধ্যমে পাঠাতে হবে।"
   - অনলাইনে আবেদনযোগ্য হলে: "হ্যাঁ, এটা আমরা অনলাইনে আবেদন করে দিতে পারব।"
৫. সার্ভিস চার্জ: সরকারি চাকরির অনলাইন আবেদন ফি ৫০ টাকা এবং বেসরকারি চাকরির জন্য ১০০ টাকা।
৬. কাঙ্ক্ষিত চাকরি না থাকলে: "দুঃখিত ভাই, এই নিয়োগটি বর্তমানে আমাদের তালিকায় নাই।"
${!hasChannelLinkAlready ? `৭. কথা শেষ হলে বা চাকরি না থাকলে একবার চ্যানেলে যুক্ত হতে বলবে: "${CHANNEL_LINK}"` : `৭. চ্যানেলের লিংক পূর্বে দেওয়া হয়ে গেছে, তাই নতুন করে লিংক দিবে না।`}
৮. পেমেন্ট আলোচনা: বিকাশ/নগদ নম্বর চাইলে বলবে "পেমেন্টের জন্য আমাদের একজন প্রতিনিধি খুব শীঘ্রই আপনার সাথে যোগাযোগ করছেন।" এবং শেষে [ALERT_ADMIN] লিখবে।

৯. মেমোরি আপডেট:
কথোপকথন থেকে কাস্টমারের যেকোনো নতুন আগ্রহ (যেকোনো কাজের ধরন, শিক্ষাগত যোগ্যতা, জেলা ইত্যাদি) বা কাগজপত্র সম্পর্কিত নতুন তথ্য পেলে উত্তরের শেষে লিখবে:
[PROFILE_UPDATE: {"interest": "কাস্টমারের আগ্রহ", "docs_provided": true/false, "note": "সংক্ষিপ্ত তথ্য"}]

চলতি সার্কুলার:
${jobsData}
`;

    if (!chatHistories.has(userPhone)) {
        chatHistories.set(userPhone, []);
    }
    const history = chatHistories.get(userPhone);

    let currentContent;
    if (base64Image) {
        currentContent = [
            { type: "text", text: userMessage || "সার্কুলারটি দেখে ১-২ লাইনে সহজ করে বলো এটা অনলাইনে আবেদন করা যাবে নাকি সরাসরি অফিসে/ডাকযোগে যেতে হবে?" },
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
                        temperature: 0.2
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

    // কল আসলে অটো মেসেজ
    sock.ev.on('call', async (calls) => {
        for (const call of calls) {
            if (call.status === 'offer') {
                const callerJid = call.from;

                // যদি ChatFilter এ বন্ধ করা থাকে, তবে কোনো অটো মেসেজও যাবে না
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

    // মেসেজ রিসিভ হ্যান্ডলার
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

            // 🛑 #Stop এবং #Start কমান্ড হ্যান্ডলিং (আপনার পাঠানো মেসেজ থেকে)
            if (msg.key.fromMe) {
                const cleanCmd = text.trim().toLowerCase();

                if (cleanCmd === "#stop") {
                    updateChatFilter(jid, 'stop');
                    pausedUsers.set(jid, Infinity); // পার্মানেন্ট পজ
                    const sent = await sock.sendMessage(jid, { text: "🛑 এই চ্যাটে এআই বট বন্ধ করা হলো। পুনরায় চালু করতে #Start লিখুন।" });
                    if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
                    return;
                } 
                
                if (cleanCmd === "#start") {
                    updateChatFilter(jid, 'start');
                    pausedUsers.delete(jid); // পজ বাতিল
                    const sent = await sock.sendMessage(jid, { text: "✅ এই চ্যাটে এআই বট পুনরায় চালু করা হলো।" });
                    if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
                    return;
                }

                // আপনি নিজে কোনো সাধারণ কথা লিখলে সাময়িক ৩০ মিনিটের বিরতি
                pausedUsers.set(jid, Date.now() + 30 * 60 * 1000);
                continue;
            }

            // 🚫 ChatFilter.json চেক: যদি এই ইউজার বন্ধ তালিকায় থাকে, তবে বট আজীবন চুপ থাকবে!
            if (isChatFiltered(jid)) {
                continue;
            }

            // সাধারণ সাময়িক পজ চেক
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

            // কাস্টমারের চ্যাটে "typing..." দেখানো
            try {
                await sock.sendPresenceUpdate('composing', jid);
            } catch (e) {}

            // এআই উত্তর তৈরি
            const aiResponse = await getAIReply(jid, text, base64Image, hasMedia);

            // মানুষের মতো বিরতি (Delay)
            await delay(2200);

            // পেমেন্ট সংক্রান্ত অ্যালার্ট
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
