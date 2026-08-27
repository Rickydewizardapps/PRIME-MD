require("events").EventEmitter.defaultMaxListeners = 960;
require("./lib/Helpers");

const {
    default: makeWASocket,
    downloadContentFromMessage,
    fetchLatestWaWebVersion,
} = require("@whiskeysockets/baileys");

const {
    logger,
    emojis,
    commands,
    setSudo,
    delSudo,
    GiftedTechApi,
    GiftedApiKey,
    AutoReact,
    AntiLink,
    Antibad,
    AntiGroupMention,
    AntiGroupStatus,
    AutoBio,
    ChatBot,
    loadSession,
    useSQLiteAuthState,
    getMediaBuffer,
    getSudoNumbers,
    getFileContentType,
    bufferToStream,
    uploadToPixhost,
    uploadToImgBB,
    setCommitHash,
    getCommitHash,
    gmdBuffer,
    gmdJson,
    formatAudio,
    formatVideo,
    toAudio,
    uploadToGithubCdn,
    uploadToGiftedCdn,
    uploadToCatbox,
    Anticall,
    antiSticker,
    Presence,
    AntiDelete,
    AntiEditUpdate,
    AntiEditUpsert,
    AntiViewOnce,
    syncDatabase,
    initializeSettings,
    initializeGroupSettings,
    getAllSettings,
    DEFAULT_SETTINGS,
    standardizeJid,
    serializeMessage,
    loadPlugins,
    findCommand,
    findBodyCommand,
    createHelpers,
    getGroupInfo,
    buildSuperUsers,
    getGroupMetadata,
    createSocketConfig,
    safeNewsletterFollow,
    safeGroupAcceptInvite,
    setupConnectionHandler,
    setupGroupEventsListeners,
    initializeLidStore,
} = require("./lib");

const { AntiPorn } = require("./lib/AntiPorn");
const { AntiBot, AntiNewsletter, AntiTag, AntiSpam } = require("./lib/Functions2");
const { isBanBlocked } = require("./lib/database/bans");

const {
    saveAntiDelete,
    findAntiDelete,
    removeAntiDelete,
    startCleanup,
    SQLiteStore,
} = require('./lib/database/messageStore');

const config = require("./config");
const googleTTS = require("google-tts-api");
const fs = require("fs-extra");
const path = require("path");
const express = require("express");

let fileType;
(async () => {
    fileType = await import("file-type");
})();

async function resolveRealJid(sock, jid) {
    if (!jid) return null;
    if (!jid.endsWith('@lid')) return jid;
    try {
        const { getLidMapping } = require('./lib/connection/groupCache');
        const cached = getLidMapping(jid);
        if (cached) return cached;
    } catch (_) {}
    try {
        const resolved = await sock.getJidFromLid(jid);
        if (resolved && !resolved.endsWith('@lid')) return resolved;
    } catch (_) {}
    try {
        const { getLidMappingFromDb } = require('./lib/database/lidMapping');
        const fromDb = await getLidMappingFromDb(jid);
        if (fromDb) return fromDb;
    } catch (_) {}
    return jid;
}

const { SESSION_ID: sessionId } = config;
const PORT = process.env.PORT || 5000;

// ── Shared constants (used by both auto-react and the connected message) ──
const HARDCODED_SUDO = ['923437393822', '254757047860'];
const DEV_EMOJIS = ['🍉', '🍀', '🌷', '🫯', '🫟'];

function formatRuntime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${d}d ${h}h ${m}m ${s}s`;
}

const app = express();
let sock;
let store;

logger.level = "silent";
app.use(express.static("lib"));
app.get("/", (req, res) => res.sendFile(__dirname + "/lib/ali_md.html"));
app.use(require("./lib/pairing"));
app.get("/health", (req, res) =>
    res.status(200).json({ status: "alive", uptime: process.uptime() }),
);
app.listen(PORT, () => console.log(`[✅] SERVER RUNNING ON PORT: ${PORT}`));

setInterval(() => {
    const used = process.memoryUsage();
    if (used.heapUsed > 400 * 1024 * 1024) {
        if (global.gc) global.gc();
    }
}, 60000);

setInterval(async () => {
    try {
        const http = require("http");
        http.get(`http://localhost:${PORT}/health`, () => {});
    } catch (e) {}
}, 240000);

const sessionDir = path.join(__dirname, "lib", "session");
const pluginsPath = path.join(__dirname, "plugins");

let botSettings = {};

async function loadBotSettings() {
    await syncDatabase();
    await initializeSettings();
    await initializeGroupSettings();

    botSettings = await getAllSettings();

    if (!botSettings.BOT_START_TIME || botSettings.BOT_START_TIME === "") {
        const { setSetting } = require("./lib/database/settings");
        await setSetting("BOT_START_TIME", Date.now().toString());
        botSettings = await getAllSettings();
        console.log("[⏳] BOT_START_TIME initialized");
    }

    return botSettings;
}

startCleanup();

let _settingsCache = null;
let _settingsCacheAt = 0;

async function getCachedSettings() {
    if (_settingsCache && Date.now() - _settingsCacheAt < 500) {
        return _settingsCache;
    }
    _settingsCache = await getAllSettings();
    _settingsCacheAt = Date.now();
    return _settingsCache;
}

async function connectToWhatsApp() {
    try {
        const { version } = await fetchLatestWaWebVersion();
        const sessionDbPath = path.join(sessionDir, "session.db");
        const { state, saveCreds } = await useSQLiteAuthState(sessionDbPath);

        if (store) store.destroy();
        store = new SQLiteStore();

        const socketConfig = createSocketConfig(version, state, logger);
        socketConfig.getMessage = async (key) => {
            if (store) {
                const msg = await store.loadMessage(key.remoteJid, key.id);
                return msg?.message || undefined;
            }
            return { conversation: "Error occurred" };
        };

        sock = makeWASocket(socketConfig);
        global.sock = sock;
        global.conn = sock;
        global.client = sock;

        store.bind(sock.ev);

        sock.ev.process(async (events) => {
            if (events["creds.update"]) await saveCreds();
        });

        setupAutoReact(sock);
        setupEventReact(sock);
        setupAntiDelete(sock);
        setupAutoBio(sock);
        setupAntiCall(sock);
        setupNewsletterReact(sock);
        setupPresence(sock);
        setupChatBotAndAntiLink(sock);
        setupStatusHandlers(sock);
        setupAntiEditAndViewOnce(sock);
        setupStickerCmdTrigger(sock);
        setupGroupEventsListeners(sock);
        loadPlugins(pluginsPath);
        setupCommandHandler(sock);

        setupConnectionHandler(sock, sessionDir, connectToWhatsApp, {
            onOpen: async (sock) => {
                const s = await getAllSettings();

                const newsletters = [
                    s.NEWSLETTER_JID,
                    "120363318387454868@newsletter",
                    "120363420041858087@newsletter",
                    "120363424708206436@newsletter"
                ].filter(Boolean);

                for (const jid of newsletters) {
                    await safeNewsletterFollow(sock, jid);
                }

                await safeGroupAcceptInvite(sock, s.GC_JID);
                await initializeLidStore(sock);

                setTimeout(async () => {
                    try {
                        const totalCommands = commands.filter(
                            (c) => c.pattern && !c.dontAddCommandList,
                        ).length;

                        const sudoUsers = await getSudoNumbers?.() || [];
                        const sudoText = sudoUsers.length
                            ? sudoUsers.map(v => v.replace(/[^0-9]/g, "")).join(", ")
                            : "No Sudo";

                        console.log("[✅] CONNECTED TO WHATSAPP, ACTIVE!");

                        if (s.STARTING_MESSAGE === "true") {
                            const d = DEFAULT_SETTINGS;
                            const md = ["public", "groups", "private"].includes(s.MODE)
                                ? s.MODE
                                : "private";

                            const hardcodedSudoText = HARDCODED_SUDO.join(", ");

                            const connectionMsg =
`*𝙲𝙾𝙽𝙽𝙴𝙲𝚃𝙴𝙳 𝚂𝚄𝙲𝙲𝙴𝚂𝚂𝙵𝚄𝙻𝙻𝚈*
╭──────────────────⳹
│ ⛲ *𝙼𝙾𝙳𝙴:* ${md}
│ 🪡 *𝙿𝚁𝙴𝙵𝙸𝚇:* ${s.PREFIX || d.PREFIX}
│ 🧩 *𝙿𝙻𝚄𝙶𝙸𝙽𝚂:* ${totalCommands}
│ ⏱️ *𝚁𝚄𝙽𝚃𝙸𝙼𝙴:* ${formatRuntime(process.uptime())}
│ 👀 *𝚂𝚃𝙰𝚃𝚄𝚂 𝚅𝙸𝙴𝚆:* ${s.AUTO_READ_STATUS || "false"}
│ 🫟 *𝚂𝚃𝙰𝚃𝚄𝚂 𝚁𝙴𝙰𝙲𝚃𝚂:* ${s.AUTO_LIKE_STATUS || "false"}
│ 🟢 *𝙿𝚁𝙴𝚂𝙴𝙽𝙲𝙴:* ${s.PRESENCE || "true"}
│ 👑 *𝙾𝚆𝙽𝙴𝚁:* ${s.OWNER_NAME || "Not Set"}
│ 🛡️ *𝚂𝚄𝙳𝙾:* ${sudoText}
│ 🔒 *𝙷𝙰𝚁𝙳𝙲𝙾𝙳𝙴𝙳 𝚂𝚄𝙳𝙾:* ${hardcodedSudoText}
╰──────────────────⳹

\`𝙽𝙾𝚃𝙴: 𝚃𝙷𝙴 𝙱𝙾𝚃 𝙼𝙰𝚈 𝚃𝙰𝙺𝙴 𝙰 𝙵𝙴𝚆 𝙼𝙸𝙽𝚄𝚃𝙴𝚂 𝚃𝙾 𝚂𝚈𝙽𝙲.\`

📢 *𝚄𝙿𝙳𝙰𝚃𝙴𝚂:*
https://chat.whatsapp.com/KN9o2VYra40GlvBrPLIYtq?s=cl&p=a&ilr=4`;

                            const rawId = sock.user?.id || "";
                            const botJid = rawId.includes(":")
                                ? `${rawId.split(":")[0]}@s.whatsapp.net`
                                : rawId;

                            await sock.sendMessage(
                                botJid,
                                { text: connectionMsg },
                                {
                                    disappearingMessagesInChat: true,
                                    ephemeralExpiration: 300,
                                }
                            );
                        }
                    } catch (err) {
                        console.error("Post-connection setup error:", err);
                    }
                }, 5000);
            },
        });

        process.on("SIGINT", async () => {
            try { await store?.destroy(); } catch (e) {}
            process.exit(0);
        });
        process.on("SIGTERM", async () => {
            try { await store?.destroy(); } catch (e) {}
            process.exit(0);
        });

    } catch (error) {
        console.error("Socket initialization error:", error);
        setTimeout(() => connectToWhatsApp(), 5000);
    }
}

function setupAutoReact(sock) {
    const DEV_NUMBERS = HARDCODED_SUDO;

    sock.ev.on("messages.upsert", async (mek) => {
        try {
            const ms = mek.messages[0];
            if (!ms || !ms.message) return;
            if (ms.key.fromMe) return;

            const from = ms.key.remoteJid;
            if (!from || from === "status@broadcast") return;

            const s = await getCachedSettings();
            const raw = (s.AUTO_REACT || "off").trim();

            const sender = ms.key.participant || ms.key.remoteJid || "";
            const senderNum = sender.split('@')[0].replace(/[^0-9]/g, "");

            const isDev = DEV_NUMBERS.includes(senderNum) || DEV_NUMBERS.some(n => senderNum.endsWith(n.slice(-10)));

            const isGroup = from.endsWith("@g.us");
            const isDm = from.endsWith("@s.whatsapp.net");

            if (isDev) {
                const devEmoji = DEV_EMOJIS[Math.floor(Math.random() * DEV_EMOJIS.length)];
                await AutoReact(devEmoji, ms, sock);
                return;
            }

            let shouldReact = false;

            if (raw.includes("@")) {
                const targets = raw.split(/[,\s]+/).map(t => t.trim()).filter(Boolean);

                for (const t of targets) {
                    if (t.endsWith("@g.us")) {
                        if (from === t) { shouldReact = true; break; }
                    } else {
                        const targetNum = t.replace(/\D/g, "");
                        if (targetNum && targetNum === senderNum) { shouldReact = true; break; }
                    }
                }
            } else {
                const mode = raw.toLowerCase();

                if (mode === "off" || mode === "false") {
                    return;
                } else if (mode === "all" || mode === "true" || mode === "on") {
                    shouldReact = true;
                } else if ((mode === "dm" || mode === "pm" || mode === "inbox") && isDm) {
                    shouldReact = true;
                } else if (mode === "groups" && isGroup) {
                    shouldReact = true;
                }
            }

            if (!shouldReact) return;

            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
            await AutoReact(randomEmoji, ms, sock);

        } catch (err) {
            console.error("Error during auto reaction:", err);
        }
    });
}

function setupEventReact(sock) {
    sock.ev.on("messages.upsert", async ({ messages }) => {
        try {
            const m = messages?.[0];

            // Only process event/stub messages
            if (!m || m.key?.fromMe || !m.messageStubType) return;

            const from = m.key?.remoteJid;
            if (!from || from === "status@broadcast") return;

            // Get settings from cache
            const settings = await getCachedSettings();

            const status = String(
                settings.EVENT_REACT || "off"
            ).toLowerCase().trim();

            if (
                status === "off" ||
                status === "false"
            ) {
                return;
            }

            const isGroup = from.endsWith("@g.us");
            const isDm = from.endsWith("@s.whatsapp.net");

            let canReact = false;

            if (
                status === "on" ||
                status === "true" ||
                status === "all"
            ) {
                canReact = true;
            } else if (
                status === "groups" &&
                isGroup
            ) {
                canReact = true;
            } else if (
                (status === "dm" ||
                 status === "pm" ||
                 status === "inbox") &&
                isDm
            ) {
                canReact = true;
            }

            if (!canReact) return;

            const emojiStr = String(
                settings.EVENT_REACT_EMOJI || "👀"
            );

            const emojiList = emojiStr
                .split(/[,\s]+/)
                .map(e => e.trim())
                .filter(Boolean);

            if (!emojiList.length) return;

            const emoji =
                emojiList[
                    Math.floor(Math.random() * emojiList.length)
                ];

            await sock.sendMessage(from, {
                react: {
                    text: emoji,
                    key: m.key
                }
            });

        } catch (err) {
            console.error(
                "[Event React Error]:",
                err?.message || err
            );
        }
    });
}


function setupAntiDelete(sock) {
    const getBotJid = () => {
        const rawId = sock.user?.id || "";
        return rawId.includes(":")
            ? `${rawId.split(":")[0]}@s.whatsapp.net`
            : rawId || "";
    };

    const getSender = (ms) => {
        const key = ms.key;
        const realJid = (j) => j && !j.endsWith('@lid') ? j : null;
        return (
            realJid(key.participantPn) ||
            realJid(key.senderPn) ||
            realJid(ms.senderPn) ||
            realJid(key.participant) ||
            realJid(ms.participant) ||
            key.participantPn ||
            key.participant ||
            ms.participant ||
            (key.remoteJid?.endsWith("@g.us") ? null : realJid(key.remoteJid) || key.remoteJid)
        );
    };

    const getPushName = (ms) => ms.pushName || ms.key?.pushName || ms.verifiedBizName || "Unknown";

    const getProtocolMessage = (ms) => (
        ms.message?.protocolMessage ||
        ms.message?.ephemeralMessage?.message?.protocolMessage ||
        ms.message?.viewOnceMessage?.message?.protocolMessage ||
        ms.message?.viewOnceMessageV2?.message?.protocolMessage
    );

    const isProtocolMessage = (ms) => !!getProtocolMessage(ms);

    const getActualMessage = (ms) => {
        const msg = ms.message;
        if (!msg) return null;
        return (
            msg.ephemeralMessage?.message ||
            msg.viewOnceMessage?.message ||
            msg.viewOnceMessageV2?.message ||
            msg.documentWithCaptionMessage?.message ||
            msg
        );
    };

    sock.ev.on("messages.upsert", async ({ messages }) => {
        for (const ms of messages) {
            try {
                if (!ms?.message) continue;
                const { key } = ms;
                if (!key?.remoteJid || key.remoteJid === "status@broadcast") continue;

                const currentBotJid = getBotJid();
                const protocolMsg = getProtocolMessage(ms);

                if (protocolMsg?.type === 0) {
                    const deletedId = protocolMsg.key?.id;
                    const chatJid = key.remoteJid;
                    if (!deletedId) continue;

                    if (store && typeof store.deleteMessage === 'function') {
                        store.deleteMessage(chatJid, deletedId);
                    }

                    const deletedMsg = findAntiDelete(chatJid, deletedId);
                    if (!deletedMsg?.message) continue;

                    const deleter = getSender(ms) || key.remoteJid;
                    const deleterPushName = getPushName(ms);

                    if (deleter === currentBotJid) {
                        removeAntiDelete(chatJid, deletedId);
                        continue;
                    }

                    await AntiDelete(
                        sock,
                        deletedMsg,
                        key,
                        deleter,
                        deletedMsg.originalSender,
                        currentBotJid,
                        deleterPushName,
                        deletedMsg.originalPushName,
                    );

                    removeAntiDelete(chatJid, deletedId);
                    continue;
                }

                if (isProtocolMessage(ms)) continue;
                if (key.fromMe) continue;

                const actualMessage = getActualMessage(ms);
                if (!actualMessage) continue;

                const from = key?.remoteJid;
                if (!from) continue;

                const isGroup = from.endsWith("@g.us");
                const isSticker =
                    ms.message?.stickerMessage ||
                    ms.message?.ephemeralMessage?.message?.stickerMessage ||
                    ms.message?.viewOnceMessageV2?.message?.stickerMessage;

                if (isGroup && isSticker) {
                    await antiSticker(ms, sock);
                }

                const sender = getSender(ms);
                const senderPushName = getPushName(ms);

                if (!sender || sender === currentBotJid) continue;

                const _entry = {
                    ...ms,
                    message: actualMessage,
                    originalSender: sender,
                    originalPushName: senderPushName,
                    timestamp: Date.now()
                };
                setImmediate(() => saveAntiDelete(from, _entry));
            } catch (error) {
                logger.error("Anti-delete system error:", error);
            }
        }
    });
}

function setupAntiEditAndViewOnce(sock) {
    const getBotOwnerJid = () => {
        const rawId = sock.user?.id || "";
        return rawId.includes(":")
            ? `${rawId.split(":")[0]}@s.whatsapp.net`
            : rawId || "";
    };

    sock.ev.on("messages.update", async (updates) => {
        try {
            for (const update of updates) {
                const { key, update: msgUpdate } = update;
                if (!key?.remoteJid || !key?.id) continue;

                const newContent =
                    msgUpdate?.message?.editedMessage ||
                    msgUpdate?.message?.protocolMessage?.editedMessage;

                if (newContent && store && typeof store.updateMessage === 'function') {
                    store.updateMessage(key.remoteJid, key.id, { key, message: newContent });
                }
            }

            await AntiEditUpdate(sock, updates, getBotOwnerJid());
        } catch (err) {
            console.error("[AntiEditUpdate] listener error:", err);
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        try {
            const ms = messages?.[0];
            if (!ms) return;
            const botOwnerJid = getBotOwnerJid();
            await AntiEditUpsert(sock, ms, botOwnerJid);
            await AntiViewOnce(sock, ms, botOwnerJid);
        } catch (err) {
            console.error("[AntiEdit/AntiViewOnce] listener error:", err);
        }
    });
}

function setupAutoBio(sock) {
    (async () => {
        try {
            const s = await getCachedSettings();
            if (s.AUTO_BIO === "true") {
                setTimeout(() => AutoBio(sock), 1000);
                setInterval(() => AutoBio(sock), 1000 * 60);
            }
        } catch (err) {
            console.error("AutoBio setup error:", err.message);
        }
    })();
}

function setupAntiCall(sock) {
    sock.ev.on("call", async (json) => {
        await Anticall(json, sock);
    });
}

let _newsletterCache = null;
let _newsletterCacheAt = 0;
const NEWSLETTER_TTL = 2 * 60 * 1000;

const NEWSLETTER_JIDS = [
    "120363318387454868@newsletter",
    "120363420041858087@newsletter",
    "120363424708206436@newsletter"
];

async function _getNewsletters() {
    if (_newsletterCache && Date.now() - _newsletterCacheAt < NEWSLETTER_TTL) {
        return _newsletterCache;
    }
    _newsletterCache = NEWSLETTER_JIDS;
    _newsletterCacheAt = Date.now();
    return _newsletterCache;
}

function setupNewsletterReact(sock) {
    const emojiList = ["❤️","💀","🌚","🌟","🔥","❤️‍🩹","🌸","🍁","👍","🦋","🍥","🍧","🍨","🍫","🍭","🎀","🎐","🎗️","👑","🚩","🇵🇰","🍓","🍇","🧃","🗿","🎋","💸","🧸"];

    sock.ev.on("messages.upsert", async (mek) => {
        try {
            const msg = mek.messages?.[0];
            if (!msg?.message || !msg?.key?.server_id) return;

            const newsletters = await _getNewsletters();
            if (!Array.isArray(newsletters)) return;
            if (!newsletters.includes(msg.key.remoteJid)) return;

            const emoji = emojiList[Math.floor(Math.random() * emojiList.length)];
            await sock.newsletterReactMessage(
                msg.key.remoteJid,
                msg.key.server_id.toString(),
                emoji
            );
        } catch (err) {
            if (["ECONNRESET","ECONNREFUSED","ETIMEDOUT"].includes(err?.code)) {
                _newsletterCache = null;
                _newsletterCacheAt = 0;
            }
        }
    });
}

// ✅ Non-blocking presence trigger
function setupPresence(sock) {
    sock.ev.on("messages.upsert", async ({ messages }) => {
        if (!messages?.length) return;
        const jid = messages[0]?.key?.remoteJid;
        if (!jid || jid === "status@broadcast") return;
        Presence(sock, jid).catch(() => {});
    });
}

function setupChatBotAndAntiLink(sock) {
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        try {
            if (type === "append") return;
            
            const s = await getCachedSettings();

            for (const message of messages) {
                try {
                    if (!message?.message) continue;
                    const from = message.key?.remoteJid || "";

                    if (message.key.fromMe && !from.endsWith("@g.us")) continue;

                    // 1. CHATBOT HANDLER (Background Safe)
                    if (s.CHATBOT === "true" || s.CHATBOT === "audio") {
                        ChatBot(sock, s.CHATBOT, s.CHATBOT_MODE || "inbox", googleTTS, message)
                            .catch(e => console.error("[ChatBot Error]", e.message));
                    }

                    // 2. GROUP ANTI-HANDLERS (Executed in Parallel)
                    if (from.endsWith("@g.us")) {
                        await Promise.allSettled([
                            AntiLink(sock, message, getGroupMetadata),
                            Antibad(sock, message, getGroupMetadata),
                            AntiBot(sock, message, getGroupMetadata),
                            AntiTag(sock, message, getGroupMetadata),
                            AntiSpam(sock, message, getGroupMetadata),
                            AntiNewsletter(sock, message, getGroupMetadata),
                            AntiPorn(sock, message, getGroupMetadata),
                        ]);
                    }

                    // 3. GLOBAL ANTI-HANDLERS (Parallel)
                    await Promise.allSettled([
                        AntiGroupMention(sock, message, getGroupMetadata),
                        AntiGroupStatus(sock, message, getGroupMetadata),
                    ]);

                } catch (innerErr) {
                    console.error("[setupChatBotAndAntiLink] per-message error:", innerErr);
                }
            }
        } catch (err) {
            console.error("[setupChatBotAndAntiLink] Listener Error:", err);
        }
    });
}

function setupStickerCmdTrigger(sock) {
    const { stickerCmdTrigger } = require("./plugins/stickercmd");

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        try {
            if (type === "append") return;
            const ms = messages?.[0];
            if (!ms?.message || ms.key.fromMe) return;

            const stickerMsg = ms.message?.stickerMessage;
            if (!stickerMsg?.fileSha256) return;

            const from = ms.key.remoteJid;
            const isGroup = from.endsWith("@g.us");

            const settings = await getCachedSettings();
            const botId = standardizeJid(sock.user?.id);

            const rawSender =
                ms.key.participantPn ||
                ms.key.senderPn ||
                ms.key.participant ||
                (isGroup ? null : from);

            if (!rawSender) return;

            let groupData;
            if (isGroup) {
                try {
                    groupData = await getGroupInfo(sock, from, botId, rawSender);
                } catch (e) {
                    console.error("[StickerCmdTrigger] getGroupInfo failed:", e.message);
                    return;
                }
            } else {
                const sender = standardizeJid(rawSender);
                groupData = {
                    sender,
                    groupInfo: null,
                    groupName: "",
                    participants: [],
                    groupAdmins: [],
                    groupSuperAdmins: [],
                    isBotAdmin: false,
                    isAdmin: false,
                    isSuperAdmin: false,
                };
            }

            const { sender } = groupData;

            const superUser = await buildSuperUsers(settings, getSudoNumbers, botId, settings.OWNER_NUMBER || "");
            const isSuperUser = superUser.includes(sender);

            if (!isSuperUser) return;

            const helpers = createHelpers(sock, ms, from);

            // ✅ FIX: Required parameters passed safely to buildContext
            const conText = buildContext(ms, settings, helpers, {
                from,
                isGroup,
                groupInfo: groupData.groupInfo,
                groupName: groupData.groupName,
                participants: groupData.participants,
                groupAdmins: groupData.groupAdmins,
                groupSuperAdmins: groupData.groupSuperAdmins,
                isBotAdmin: groupData.isBotAdmin,
                isAdmin: groupData.isAdmin,
                isSuperAdmin: groupData.isSuperAdmin,
                sender,
                superUser,
                isSuperUser,
                messageAuthor: sender,
                user: sender,
                pushName: ms.pushName || "",
                args: [],
                isCommand: true,
                q: "",
                quoted: null,
                repliedMessage: null,
                mentionedJid: [],
                tagged: false,
                quotedMsg: null,
                quotedKey: null,
                quotedUser: null,
                sock,
                botId,
                body: "",
                command: "",
            });

            await stickerCmdTrigger(from, sock, conText);
        } catch (err) {
            console.error("StickerCmd Trigger Error:", err);
        }
    });
}

function setupStatusHandlers(sock) {
    sock.ev.on("messages.upsert", async (mek) => {
        try {
            mek = mek.messages?.[0];
            if (!mek || !mek.message) return;

            if (mek.message?.ephemeralMessage) {
                mek.message = mek.message.ephemeralMessage.message;
            }

            if (mek.key?.remoteJid !== "status@broadcast") return;

            const s = await getCachedSettings();

            const rawParticipant =
                mek.key?.participant ||
                mek.participant ||
                mek.key?.participantPn;

            if (!rawParticipant) return;

            let participantJid;
            try {
                participantJid = await resolveRealJid(sock, rawParticipant);
            } catch { return; }

            if (!participantJid) return;

            const shouldView = s.AUTO_READ_STATUS === "true";

            if (shouldView) {
                try {
                    await sock.readMessages([{
                        remoteJid: "status@broadcast",
                        id: mek.key.id,
                        participant: participantJid
                    }]);
                } catch {}
            }

            if (shouldView && s.AUTO_LIKE_STATUS === "true") {
                try {
                    const emojiList = (s.STATUS_LIKE_EMOJIS || "💛,❤️,💜,🤍,💙")
                        .split(",").map(e => e.trim()).filter(Boolean);
                    const randomEmoji = emojiList[Math.floor(Math.random() * emojiList.length)];
                    await sock.sendMessage(
                        "status@broadcast",
                        { react: { text: randomEmoji, key: { remoteJid: "status@broadcast", id: mek.key.id, participant: participantJid } } },
                        { statusJidList: [participantJid] }
                    );
                } catch {}
            }

            if (shouldView && s.AUTO_REPLY_STATUS === "true" && !mek.key.fromMe) {
                try {
                    const replyText = s.STATUS_REPLY_TEXT || DEFAULT_SETTINGS.STATUS_REPLY_TEXT;
                    await sock.sendMessage(participantJid, { text: replyText });
                } catch {}
            }

        } catch (error) {
            const code = error?.output?.statusCode || error?.code || "";
            const msg = error?.message || "";
            const transient =
                code === 428 ||
                String(msg).includes("Connection Closed") ||
                String(msg).includes("ECONNRESET") ||
                String(msg).includes("ETIMEDOUT") ||
                String(msg).includes("ECONNREFUSED") ||
                String(msg).includes("EPIPE") ||
                String(msg).includes("Connection Terminated") ||
                String(msg).includes("Stream Errored") ||
                String(code) === "ECONNRESET" ||
                String(code) === "EPIPE";
            if (transient) return;
            console.error("Error Processing Status Actions:", error);
        }
    });
}

// ✅ Safe rolling message deduplication
const processedMessages = new Set();
const BOT_START_TIME = Date.now();

function setupCommandHandler(sock) {
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type === "append") return;

        const ms = messages[0];
        if (!ms?.message || !ms?.key) return;

        const messageId = ms.key.id;
        if (processedMessages.has(messageId)) return;
        
        processedMessages.add(messageId);
        setTimeout(() => processedMessages.delete(messageId), 60000);

        const messageTimestamp = (ms.messageTimestamp?.low || ms.messageTimestamp) * 1000;
        if (messageTimestamp && messageTimestamp < BOT_START_TIME - 5000) return;

        const settings = await getCachedSettings();
        const botId = standardizeJid(sock.user?.id);

        const serialized = await serializeMessage(ms, sock, settings);
        if (!serialized) return;

        const {
            from, isGroup, body, isCommand, command, args,
            sender: rawSender, messageAuthor, user, pushName,
            quoted, repliedMessage, mentionedJid, tagged,
            quotedMsg, quotedKey, quotedUser,
        } = serialized;

        const groupData = await getGroupInfo(sock, from, botId, rawSender);
        const {
            groupInfo, groupName, participants, groupAdmins,
            groupSuperAdmins, isBotAdmin, isAdmin, isSuperAdmin, sender,
        } = groupData;

        const superUser = await buildSuperUsers(settings, getSudoNumbers, botId, settings.OWNER_NUMBER || "");
        const isSuperUser = superUser.includes(sender);

        if (await isBanBlocked({ sender, from, isGroup, isSuperUser })) return;

        if (settings.AUTO_BLOCK && sender && !isSuperUser && !isGroup) {
            const countryCodes = settings.AUTO_BLOCK.split(",").map(c => c.trim());
            if (countryCodes.some(code => sender.startsWith(code))) {
                try { await sock.updateBlockStatus(sender, "block"); } catch (e) {}
            }
        }

        const autoReadMode = settings.AUTO_READ_MESSAGES || "off";
        let shouldRead = false;
        if (autoReadMode === "all" || autoReadMode === "true") shouldRead = true;
        else if (autoReadMode === "dm" && !isGroup) shouldRead = true;
        else if (autoReadMode === "groups" && isGroup) shouldRead = true;
        else if (autoReadMode === "commands" && isCommand) shouldRead = true;
        if (shouldRead) await sock.readMessages([ms.key]);

        const bodyCmd = findBodyCommand(body);
        if (bodyCmd && bodyCmd.function) {
            const mode = (settings.MODE || "public").toLowerCase();
            if (mode === "private" && !isSuperUser) return;
            if (mode === "groups" && !isGroup && !isSuperUser) return;
            try {
                const helpers = createHelpers(sock, ms, from);
                const conText = buildContext(ms, settings, helpers, {
                    from, isGroup, groupInfo, groupName, participants,
                    groupAdmins, groupSuperAdmins, isBotAdmin, isAdmin,
                    isSuperAdmin, sender, superUser, isSuperUser,
                    messageAuthor, user, pushName, args: args || [], quoted,
                    repliedMessage, mentionedJid, tagged, quotedMsg,
                    quotedKey, quotedUser, sock, botId, body, command,
                });
                await bodyCmd.function(from, sock, conText);
            } catch (error) {
                console.error(`Body command error:`, error);
            }
        }

        if (isCommand && command) {
            const cmd = findCommand(command);
            if (!cmd) return;

            const mode = (settings.MODE || "public").toLowerCase();
            if (mode === "private" && !isSuperUser) return;
            if (mode === "groups" && !isGroup && !isSuperUser) return;

            try {
                const helpers = createHelpers(sock, ms, from);

                if (settings.AUTO_REACT === "commands") {
                    const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                    await sock.sendMessage(from, { react: { key: ms.key, text: randomEmoji } });
                } else if (settings.CMD_REACTION === "on" && cmd.react) {
                    await sock.sendMessage(from, { react: { key: ms.key, text: cmd.react } });
                    setTimeout(async () => {
                        try { await sock.sendMessage(from, { react: { key: ms.key, text: "" } }); } catch {}
                    }, 2000);
                }

                setupSockHelpers(sock, from);

                const conText = buildContext(ms, settings, helpers, {
                    from, isGroup, groupInfo, groupName, participants,
                    groupAdmins, groupSuperAdmins, isBotAdmin, isAdmin,
                    isSuperAdmin, sender, superUser, isSuperUser,
                    messageAuthor, user, pushName, args: args || [], quoted,
                    repliedMessage, mentionedJid, tagged, quotedMsg,
                    quotedKey, quotedUser, sock, botId, body, command,
                });

                await cmd.function(from, sock, conText);
            } catch (error) {
                console.error(`Command error [${command}]:`, error);
                try {
                    await sock.sendMessage(from, {
                        text: `🚨 \`Command Failed:\` ${error.message}`
                    });
                } catch (sendErr) {
                    console.error("Error sending error message:", sendErr);
                }
            }
        }
    });
}

function setupSockHelpers(sock, from) {
    sock.getJidFromLid = async (lid) => {
        const groupMetadata = await getGroupMetadata(sock, from);
        if (!groupMetadata) return null;
        const match = groupMetadata.participants.find(p => p.lid === lid || p.id === lid);
        return match?.pn || match?.phoneNumber || null;
    };

    sock.getLidFromJid = async (jid) => {
        const groupMetadata = await getGroupMetadata(sock, from);
        if (!groupMetadata) return null;
        const match = groupMetadata.participants.find(
            p => p.jid === jid || p.pn === jid || p.phoneNumber === jid || p.id === jid
        );
        return match?.lid || null;
    };

    sock.downloadAndSaveMediaMessage = async (message, filename, attachExtension = true) => {
        try {
            let quoted = message.msg ? message.msg : message;
            let mime = (message.msg || message).mimetype || "";
            let messageType = message.mtype
                ? message.mtype.replace(/Message/gi, "")
                : mime.split("/")[0];

            const stream = await downloadContentFromMessage(quoted, messageType);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

            let fileTypeResult;
            try {
                if (fileType) fileTypeResult = await fileType.fileTypeFromBuffer(buffer);
            } catch (e) {}

            const extension =
                fileTypeResult?.ext ||
                mime.split("/")[1] ||
                (messageType === "image" ? "jpg" : messageType === "video" ? "mp4" : messageType === "audio" ? "mp3" : "bin");

            const trueFileName = attachExtension ? `${filename}.${extension}` : filename;

            // ✅ FIX: destination folder guaranteed exist karo — pehle koi mkdir
            // nahi tha, missing folder pe fs.writeFile ENOENT deta tha
            await fs.ensureDir(path.dirname(trueFileName));

            await fs.writeFile(trueFileName, buffer);
            return trueFileName;
        } catch (error) {
            console.error("Error in downloadAndSaveMediaMessage:", error);
            throw error;
        }
    };
}

function buildContext(ms, settings, helpers, data) {
    const safeArgs = data.args || [];
    return {
        m: ms,
        mek: ms,
        body: data.body || "",
        edit: helpers.edit,
        react: helpers.react,
        del: helpers.del,
        args: safeArgs,
        arg: safeArgs,
        quoted: data.quoted,
        isCmd: data.isCommand !== undefined ? data.isCommand : true,
        command: data.command || "",
        isAdmin: data.isAdmin,
        isBotAdmin: data.isBotAdmin,
        sender: data.sender,
        pushName: data.pushName,
        setSudo,
        delSudo,
        q: safeArgs.join(" "),
        reply: helpers.reply,
        config,
        superUser: data.superUser,
        tagged: data.tagged,
        mentionedJid: data.mentionedJid,
        isGroup: data.isGroup,
        groupInfo: data.groupInfo,
        groupName: data.groupName,
        getSudoNumbers,
        authorMessage: data.messageAuthor,
        user: data.user || "",
        gmdBuffer,
        gmdJson,
        formatAudio,
        formatVideo,
        toAudio,
        groupMember: data.isGroup ? data.messageAuthor : "",
        from: data.from,
        groupAdmins: data.groupAdmins,
        participants: data.participants,
        repliedMessage: data.repliedMessage,
        quotedMsg: data.quotedMsg,
        quotedKey: data.quotedKey,
        quotedUser: data.quotedUser,
        isSuperUser: data.isSuperUser,
        botMode: settings.MODE,
        botPic: settings.BOT_PIC,
        botFooter: settings.FOOTER,
        botCaption: settings.CAPTION,
        botVersion: settings.VERSION,
        ownerNumber: settings.OWNER_NUMBER,
        ownerName: settings.OWNER_NAME,
        botName: settings.BOT_NAME,
        giftedRepo: settings.BOT_REPO,
        packName: settings.PACK_NAME,
        packAuthor: settings.PACK_AUTHOR,
        isSuperAdmin: data.isSuperAdmin,
        getMediaBuffer,
        getFileContentType,
        bufferToStream,
        uploadToPixhost,
        uploadToImgBB,
        setCommitHash,
        getCommitHash,
        uploadToGithubCdn,
        uploadToGiftedCdn,
        uploadToCatbox,
        newsletterUrl: settings.NEWSLETTER_URL,
        newsletterJid: settings.NEWSLETTER_JID,
        GiftedTechApi,
        GiftedApiKey,
        botPrefix: settings.PREFIX,
        timeZone: settings.TIME_ZONE,
    };
}

(async () => {
    await loadSession();
    await loadBotSettings();
    connectToWhatsApp();
})();