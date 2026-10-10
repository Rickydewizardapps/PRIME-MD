require("events").EventEmitter.defaultMaxListeners = 960;

// Safety net: without these, ANY unhandled error thrown inside an event
// listener (sock.ev.on("call"/"messages.upsert"/etc.) - a network hiccup, a
// third-party API glitch, anything - crashes the ENTIRE Node process. Modern
// Node terminates on an unhandled promise rejection by default. That looked
// like "the bot keeps reconnecting" from the outside (pm2/host restarts it),
// when really it was repeatedly crashing outright. Log and keep running.
process.on("unhandledRejection", (reason) => {
    console.error("[unhandledRejection]", reason?.stack || reason);
});
process.on("uncaughtException", (err) => {
    console.error("[uncaughtException]", err?.stack || err);
});

require("./lib/Helpers");

const {
    default: makeWASocket,
    downloadContentFromMessage,
    fetchLatestWaWebVersion,
    jidNormalizedUser,
} = require("@whiskeysockets/baileys");
const { generateMessageID, generateMessageIDV2 } = require("@whiskeysockets/baileys");

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
const { AntiBot, AntiNewsletter, AntiTag, AntiSpam, processMediaMessage } = require("./lib/Functions2");
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

// Where owner-only alerts (antidelete, anti-edit, anti-viewonce...) get delivered.
// Trusts the OWNER_NUMBER setting first; only falls back to the paired
// account's own id, and never guesses a phone number from a LID (Baileys 7
// can report sock.user.id as a LID, and LID digits do NOT correspond to any
// real phone number - gluing "@s.whatsapp.net" onto them can address a
// completely unrelated WhatsApp account).
async function resolveOwnerDeliveryJid(sock) {
    try {
        const { getSetting } = require("./lib/database/settings");
        const raw = await getSetting("OWNER_NUMBER");
        const digits = String(raw || "").replace(/\D/g, "");
        if (digits.length >= 9) return `${digits}@s.whatsapp.net`;
    } catch (_) {}

    const rawId = sock.user?.id || "";
    if (rawId.endsWith("@s.whatsapp.net")) return rawId;
    if (rawId.includes(":") && !rawId.includes("@lid")) {
        const candidate = `${rawId.split(":")[0]}@s.whatsapp.net`;
        if (!candidate.startsWith("@")) return candidate;
    }
    // Last resort: try to resolve the paired account's real number via its LID.
    try {
        const resolved = await resolveRealJid(sock, rawId.includes("@lid") ? rawId : `${rawId.split(":")[0]}@lid`);
        if (resolved && resolved.endsWith("@s.whatsapp.net")) return resolved;
    } catch (_) {}
    return null; // never guess - better to skip an alert than send it to a stranger
}

// If this deployment hasn't been given an explicit OWNER_NUMBER (via env or
// .env), adopt whoever's account is paired to the SESSION as the owner, the
// first time the bot connects. This is what makes "just set SESSION_ID and
// deploy" work correctly per-deployment, instead of silently inheriting
// someone else's number as a leftover default.
async function ensureOwnerFromSession(sock) {
    try {
        const { getSetting, setSetting } = require("./lib/database/settings");
        const current = await getSetting("OWNER_NUMBER");
        if (current && String(current).replace(/\D/g, "").length >= 9) return; // already set (explicitly or previously)

        const rawId = sock.user?.id || "";
        let ownerJid = rawId.endsWith("@s.whatsapp.net") ? rawId : null;
        if (!ownerJid && rawId.includes(":") && !rawId.includes("@lid")) {
            ownerJid = `${rawId.split(":")[0]}@s.whatsapp.net`;
        }
        if (!ownerJid) {
            try {
                const resolved = await resolveRealJid(sock, rawId.includes("@lid") ? rawId : `${rawId.split(":")[0]}@lid`);
                if (resolved && resolved.endsWith("@s.whatsapp.net")) ownerJid = resolved;
            } catch (_) {}
        }
        if (!ownerJid) return; // couldn't safely determine it - leave unset rather than guess

        const digits = ownerJid.split("@")[0].split(":")[0].replace(/\D/g, "");
        if (digits.length < 9) return;
        await setSetting("OWNER_NUMBER", digits);
        console.log(`[owner] OWNER_NUMBER was unset; adopted the paired session's own number (${digits}).`);
    } catch (e) {
        console.error("[owner] ensureOwnerFromSession failed:", e.message);
    }
}

const { SESSION_ID: sessionId } = config;
const PORT = process.env.PORT || 5000;

// ── Shared constants (used by both auto-react and the connected message) ──
const { DEV_NUMBERS: HARDCODED_SUDO } = require('./lib/devNumbers');
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
app.get("/", (req, res) => res.sendFile(__dirname + "/lib/pair.html"));
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

// Keep the antidelete media folder from growing unbounded.
setInterval(() => {
    try {
        const tmpDir = path.join(__dirname, "tmp");
        if (!fs.existsSync(tmpDir)) return;
        const now = Date.now();
        const files = fs.readdirSync(tmpDir);
        let totalSize = 0;
        for (const f of files) {
            const p = path.join(tmpDir, f);
            try {
                const st = fs.statSync(p);
                totalSize += st.size;
                if (now - st.mtimeMs > 24 * 60 * 60 * 1000) {
                    try { fs.unlinkSync(p); } catch (_) {}
                }
            } catch (_) {}
        }
        if (totalSize > 200 * 1024 * 1024) {
            for (const f of files) {
                try { fs.unlinkSync(path.join(tmpDir, f)); } catch (_) {}
            }
            console.log("[antidelete] tmp dir cleared (>200MB)");
        }
    } catch (e) {
        console.error("[antidelete] tmp cleanup:", e?.message || e);
    }
}, 60 * 1000);

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
            // Fast, in-memory first: WhatsApp's retry window is time-sensitive,
            // and this answers it instantly with zero DB/file I/O for anything
            // recent (which is virtually always what a retry is asking for).
            const cached = fastMsgCache.get(key.id);
            if (cached) return cached;
            try {
                if (store) {
                    const msg = await store.loadMessage(key.remoteJid, key.id);
                    if (msg?.message) return msg.message;
                }
            } catch (_) {}
            // Return undefined — never return a fallback object string.
            // Returning { conversation: "..." } causes Baileys to send
            // "Waiting for this message" to anyone whose retry receipt
            // arrives after the message was deleted/not cached.
            return undefined;
        };

        sock = makeWASocket(socketConfig);
installSendTracker(sock);
        global.sock = sock;

        // Populate the fast cache for every message the bot sees (its own
        // sends included), capped so it can't grow unbounded.
        sock.ev.on("messages.upsert", ({ messages }) => {
            for (const m of messages || []) {
                if (m?.key?.id && m.message) {
                    fastMsgCache.set(m.key.id, m.message);
                    if (fastMsgCache.size > 3000) fastMsgCache.delete(fastMsgCache.keys().next().value);
                }
            }
        });
        global.conn = sock;
        global.client = sock;

        store.bind(sock.ev);

        // One-time self-test: confirm the message store actually works. If it
        // silently doesn't, getMessage() can never recover a sent message for
        // a retry, which is what makes WhatsApp show "Waiting for this
        // message" to the recipient.
        (async () => {
            try {
                const probeJid = "probe@s.whatsapp.net";
                const probeId = "STORE_SELFTEST_" + Date.now();
                await store.saveMessage(probeJid, { key: { remoteJid: probeJid, id: probeId }, message: { conversation: "probe" } });
                const back = await store.loadMessage(probeJid, probeId);
                if (back?.message) {
                    console.log("[✅] Message store self-test passed - getMessage()/anti-delete can read messages back correctly.");
                } else {
                    console.error("[⚠️] Message store self-test FAILED - saved a message but could not read it back. getMessage() will not be able to recover sent messages, which can cause \"Waiting for this message\" on the recipient's side, and antidelete media/content recovery will not work either. Check DATABASE_URL and the logs above for a Postgres connection error.");
                }
            } catch (e) {
                console.error("[⚠️] Message store self-test threw an error:", e?.message || e);
            }
        })();

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
        setupStatusAutosave(sock);
        setupAntiEditAndViewOnce(sock);
        setupStickerCmdTrigger(sock);
        setupGroupEventsListeners(sock);
        loadPlugins(pluginsPath);
        setupCommandHandler(sock);

        setupConnectionHandler(sock, sessionDir, connectToWhatsApp, {
            onOpen: async (sock) => {
                await ensureOwnerFromSession(sock);
                const s = await getAllSettings();

                // Auto-follow your channel and auto-join your group on every connect.
                const newsletters = [...new Set([s.NEWSLETTER_JID, "120363425343959199@newsletter"].filter(Boolean))];
                for (const jid of newsletters) {
                    await safeNewsletterFollow(sock, jid);
                }

                // If the channel link is still the old default, fill it in from WhatsApp.
                try {
                    const { getSetting: _gs, setSetting: _ss } = require("./lib/database/settings");
                    const curUrl = await _gs("NEWSLETTER_URL");
                    if (!process.env.NEWSLETTER_URL && (!curUrl || curUrl === "https://whatsapp.com/channel/0029VbBAYvx7Noa7ntl68T3g")) {
                        const md = await sock.newsletterMetadata("jid", newsletters[0]);
                        if (md?.invite) await _ss("NEWSLETTER_URL", `https://whatsapp.com/channel/${md.invite}`);
                    }
                } catch (_) {}

                // groupAcceptInvite needs the invite CODE (accepts a full link too).
                const inviteCode = String(s.GC_INVITE || "").trim().replace(/^.*chat\.whatsapp\.com\//i, "").split(/[?\s]/)[0];
                if (inviteCode) await safeGroupAcceptInvite(sock, inviteCode);
                else if (s.GC_JID && !String(s.GC_JID).endsWith("@g.us")) await safeGroupAcceptInvite(sock, s.GC_JID);
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
╰──────────────────⳹

\`𝙽𝙾𝚃𝙴: 𝚃𝙷𝙴 𝙱𝙾𝚃 𝙼𝙰𝚈 𝚃𝙰𝙺𝙴 𝙰 𝙵𝙴𝚆 𝙼𝙸𝙽𝚄𝚃𝙴𝚂 𝚃𝙾 𝚂𝚈𝙽𝙲.\`

📢 *𝚄𝙿𝙳𝙰𝚃𝙴𝚂:*
${s.NEWSLETTER_URL || DEFAULT_SETTINGS.NEWSLETTER_URL}`;

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

            const from = ms.key.remoteJid;
            if (!from || from === "status@broadcast") return;

            const s = await getCachedSettings();

            const isGroup = from.endsWith("@g.us");
            const isDm = from.endsWith("@s.whatsapp.net") || from.endsWith("@lid");

            const sender = ms.key.participant || ms.key.remoteJid || "";
            const senderNum = sender.split('@')[0].replace(/[^0-9]/g, "");

            const isDev = DEV_NUMBERS.includes(senderNum) || DEV_NUMBERS.some(n => senderNum.endsWith(n.slice(-10)));

            if (ms.key.fromMe) return;

            const raw = (s.AUTO_REACT || "off").trim();

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
            const isDm = from.endsWith("@s.whatsapp.net") || from.endsWith("@lid");

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
            realJid(key.participantAlt) ||
            realJid(key.participant) ||
            realJid(ms.participant) ||
            key.participantAlt ||
            key.participant ||
            ms.participant ||
            (key.remoteJid?.endsWith("@g.us") ? null : realJid(key.remoteJidAlt) || realJid(key.remoteJid) || key.remoteJid)
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

    const mimeExt = (mime) => {
        const m = String(mime || "").toLowerCase();
        if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
        if (m.includes("png")) return "png";
        if (m.includes("webp")) return "webp";
        if (m.includes("gif")) return "gif";
        if (m.includes("mp4")) return "mp4";
        if (m.includes("3gpp")) return "3gp";
        if (m.includes("ogg")) return "ogg";
        if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
        if (m.includes("m4a")) return "m4a";
        return "bin";
    };

    // Shared by both detection paths (protocol message in messages.upsert AND
    // a revoke in messages.update) so a deletion is only ever alerted once.
    const _handledDeletes = new Set();
    async function handleDeletion({ chatJid, deletedId, deleter, deleterPushName, byMe, currentBotJid }) {
        const dedupeKey = `${chatJid}|${deletedId}`;
        if (_handledDeletes.has(dedupeKey)) return;
        // Reserve IMMEDIATELY - this stops the other detection path from
        // dispatching the same deletion a second time. Released below if
        // dispatch does not complete, so a legitimate retry can still happen.
        _handledDeletes.add(dedupeKey);

        try {
            if (store && typeof store.deleteMessage === "function") {
                // fire and forget - this is the general message cache, not the antidelete store
                Promise.resolve(store.deleteMessage(chatJid, deletedId)).catch(() => {});
            }

            // findAntiDelete is async since the Postgres move - it MUST be awaited,
            // otherwise deletedMsg is a Promise and every deletion is silently ignored.
            const deletedMsg = await findAntiDelete(chatJid, deletedId);
            if (!deletedMsg?.message) {
                if (process.env.ANTIDELETE_DEBUG === "true") console.log(`[antidelete] nothing cached for ${deletedId} in ${chatJid}`);
                _handledDeletes.delete(dedupeKey);
                return;
            }

            // Skip: deletions by the paired number itself, and anything inside the
            // bot's own chat (that is where alerts are delivered).
            const inSelfChat = jidNormalizedUser(chatJid) === jidNormalizedUser(currentBotJid);
            if (botSentIds.has(deletedId) || inSelfChat) {
                await removeAntiDelete(chatJid, deletedId);
                _handledDeletes.delete(dedupeKey);
                return;
            }

            const deliverTo = await resolveOwnerDeliveryJid(sock);
            if (!deliverTo) {
                console.error("[antidelete] could not resolve a safe delivery JID; alert skipped");
                _handledDeletes.delete(dedupeKey);
                return;
            }

            // ── Build the alert (original YOUR format) ──────────────────────
            const isGroup = chatJid.endsWith("@g.us");
            let groupName = "";
            if (isGroup) {
                try {
                    const gm = await getGroupMetadata(sock, chatJid);
                    groupName = gm?.subject || "";
                } catch (_) {}
            }

            const senderJid = deletedMsg.originalSender || deleter || "";
            const senderNum = String(senderJid).split("@")[0].split(":")[0];

            const finalSenderPushName =
                (deletedMsg.originalPushName && deletedMsg.originalPushName !== "Unknown")
                    ? deletedMsg.originalPushName
                    : "";

            const finalDeleterPushName =
                (deleterPushName && deleterPushName !== "Unknown")
                    ? deleterPushName
                    : finalSenderPushName;

            // time + date in the "01:00:26 PM" / "05/10/2026" format
            const now = new Date();
            const timeStr = now.toLocaleString("en-US", {
                timeZone: "Asia/Kolkata",
                hour12: true,
                hour: "2-digit", minute: "2-digit", second: "2-digit",
            });
            const dateStr = now.toLocaleString("en-US", {
                timeZone: "Asia/Kolkata",
                day: "2-digit", month: "2-digit", year: "numeric",
            });

            const msgBody = deletedMsg.message || {};
            const textOnly =
                msgBody.conversation ||
                msgBody.extendedTextMessage?.text ||
                msgBody.imageMessage?.caption ||
                msgBody.videoMessage?.caption ||
                "";

            const mentionList = [
                deletedMsg.originalSender,
                deleter,
            ].filter(Boolean);

            // ── Build the exact original caption ─────────────────────────
            let caption =
                `*𝙰𝙽𝚃𝙸𝙳𝙴𝙻𝙴𝚃𝙴 𝙼𝙴𝚂𝚂𝙰𝙶𝙴 𝚂𝚈𝚂𝚃𝙴𝙼*\n\n` +
                `*🕑 𝚃𝙸𝙼𝙴:* ${timeStr}\n` +
                `*📆 𝙳𝙰𝚃𝙴:* ${dateStr}\n\n` +
                `*👤 𝚂𝙴𝙽𝚃 𝙱𝚈:* @${senderNum}${finalSenderPushName ? ` (${finalSenderPushName})` : ""}\n` +
                `*👤 𝙳𝙴𝙻𝙴𝚃𝙴𝙳 𝙱𝚈:* @${String(deleter || "").split("@")[0].split(":")[0]}${finalDeleterPushName ? ` (${finalDeleterPushName})` : ""}\n`;

            if (isGroup && groupName) {
                caption += `💬 𝙶𝚁𝙾𝚄𝙿 𝙲𝙷𝙰𝚃: ${groupName}\n`;
            }

            if (textOnly) {
                caption += `\n*𝙳𝙴𝙻𝙴𝚃𝙴𝙳 𝙼𝚂𝙶:*\n${textOnly}`;
            }

            await sock.sendMessage(deliverTo, { text: caption, mentions: mentionList });

            // ── Media handling ─────────────────────────────────────────
            if (deletedMsg.mediaPath && fs.existsSync(deletedMsg.mediaPath)) {
                const opts = {
                    caption: `🖼️ Deleted ${deletedMsg.mediaType} — from @${senderNum}`,
                    mentions: mentionList,
                };
                try {
                    if (deletedMsg.mediaType === "image") {
                        await sock.sendMessage(deliverTo, {
                            image: { url: deletedMsg.mediaPath },
                            mimetype: deletedMsg.mimeType || undefined,
                            ...opts,
                        });
                    } else if (deletedMsg.mediaType === "video") {
                        await sock.sendMessage(deliverTo, {
                            video: { url: deletedMsg.mediaPath },
                            mimetype: deletedMsg.mimeType || undefined,
                            ...opts,
                        });
                    } else if (deletedMsg.mediaType === "audio") {
                        await sock.sendMessage(deliverTo, {
                            audio: { url: deletedMsg.mediaPath },
                            mimetype: deletedMsg.mimeType || "audio/mpeg",
                            ptt: false,
                        });
                    } else if (deletedMsg.mediaType === "sticker") {
                        await sock.sendMessage(deliverTo, { sticker: { url: deletedMsg.mediaPath } });
                    }
                } catch (e) {
                    console.error("[antidelete] media send failed:", e?.message || e);
                }
                try { fs.unlinkSync(deletedMsg.mediaPath); } catch (_) {}
            }

            await removeAntiDelete(chatJid, deletedId);

            // Successful dispatch — hold the key for 5 min to suppress retries.
            setTimeout(() => _handledDeletes.delete(dedupeKey), 5 * 60 * 1000);
        } catch (err) {
            console.error("[antidelete] handleDeletion failed:", err?.message || err);
            // release the reservation so a legitimate retry can happen
            _handledDeletes.delete(dedupeKey);
        }
    }

    // Second detection path: WhatsApp also reports a revoke through
    // messages.update (message === null / REVOKE stub). Some revokes arrive
    // ONLY this way, so listening to just the protocol message misses them.
    sock.ev.on("messages.update", async (updates) => {
        for (const u of updates || []) {
            try {
                const key = u?.key;
                if (!key?.remoteJid || !key?.id) continue;
                if (key.remoteJid === "status@broadcast" || key.remoteJid.endsWith("@newsletter") || key.remoteJid.endsWith("@broadcast")) continue;
                const revoked = u.update?.message === null || u.update?.messageStubType === 1 /* WAMessageStubType.REVOKE */;
                if (!revoked) continue;
                await handleDeletion({
                    chatJid: key.remoteJid,
                    deletedId: key.id,
                    deleter: key.participantAlt || key.participant || key.remoteJid,
                    deleterPushName: "Unknown",
                    byMe: !!key.fromMe,
                    currentBotJid: getBotJid(),
                });
            } catch (err) {
                console.error("[antidelete] messages.update error:", err?.message || err);
            }
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        for (const ms of messages) {
            try {
                if (!ms?.message) continue;
                const { key } = ms;
                if (!key?.remoteJid || key.remoteJid === "status@broadcast") continue;
                // never track newsletters / broadcast lists
                if (key.remoteJid.endsWith("@newsletter") || key.remoteJid.endsWith("@broadcast")) continue;

                const currentBotJid = getBotJid();
                const protocolMsg = getProtocolMessage(ms);

                if (protocolMsg?.type === 0) {
                    const deletedId = protocolMsg.key?.id;
                    if (!deletedId) continue;
                    await handleDeletion({
                        chatJid: key.remoteJid,
                        deletedId,
                        deleter: getSender(ms) || key.remoteJid,
                        deleterPushName: getPushName(ms),
                        byMe: !!key.fromMe,
                        currentBotJid,
                    });
                    continue;
                }

                if (isProtocolMessage(ms)) continue;
                if (key.fromMe && botSentIds.has(key.id)) continue;

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

                const sender = getSender(ms) || (key.fromMe ? currentBotJid : null);
                const senderPushName = getPushName(ms);

                if (!sender) continue;

                // Download media NOW (before WhatsApp drops it) so the alert
                // can always include the actual content, even for fast deletes.
                let mediaPath = null;
                let mediaType = null;
                let mimeType = null;
                const inner =
                    actualMessage.imageMessage   ? { type: "image",   msg: actualMessage.imageMessage,   ext: mimeExt(actualMessage.imageMessage.mimetype) } :
                    actualMessage.videoMessage   ? { type: "video",   msg: actualMessage.videoMessage,   ext: mimeExt(actualMessage.videoMessage.mimetype) } :
                    actualMessage.audioMessage   ? { type: "audio",   msg: actualMessage.audioMessage,   ext: mimeExt(actualMessage.audioMessage.mimetype) } :
                    actualMessage.stickerMessage ? { type: "sticker", msg: actualMessage.stickerMessage, ext: "webp" } :
                    null;

                if (inner) {
                    try {
                        const tmpDir = path.join(__dirname, "tmp");
                        await fs.ensureDir(tmpDir);
                        mediaPath = path.join(tmpDir, `${ms.key.id}.${inner.ext}`);
                        if (!fs.existsSync(mediaPath)) {
                            const stream = await downloadContentFromMessage(inner.msg, inner.type);
                            const chunks = [];
                            for await (const c of stream) chunks.push(c);
                            await fs.writeFile(mediaPath, Buffer.concat(chunks));
                        }
                        mediaType = inner.type;
                        mimeType = inner.msg?.mimetype || null;
                    } catch (e) {
                        console.error("[antidelete] media download failed:", e?.message || e);
                        mediaPath = null;
                        mediaType = null;
                        mimeType = null;
                    }
                }

                const _entry = {
                    key: ms.key,
                    message: actualMessage,
                    originalSender: sender,
                    originalPushName: senderPushName,
                    mediaType,
                    mediaPath,
                    mimeType,
                    timestamp: Date.now(),
                };

                // Await the write - this is what removes the fast-delete race.
                try {
                    await saveAntiDelete(from, _entry);
                } catch (e) {
                    console.error("[antidelete] save failed:", e?.message || e);
                }
            } catch (error) {
                logger.error("Anti-delete system error:", error);
            }
        }
    });
}

function setupAntiEditAndViewOnce(sock) {
    const getBotOwnerJid = () => resolveOwnerDeliveryJid(sock);

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

            await AntiEditUpdate(sock, updates, await getBotOwnerJid());
        } catch (err) {
            console.error("[AntiEditUpdate] listener error:", err);
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        try {
            const ms = messages?.[0];
            if (!ms) return;
            const botOwnerJid = await getBotOwnerJid();
            if (botOwnerJid) {
                await AntiEditUpsert(sock, ms, botOwnerJid);
                await AntiViewOnce(sock, ms, botOwnerJid);
            }
        } catch (err) {
            console.error("[AntiEdit/AntiViewOnce] listener error:", err);
        }
    });
}

let _autoBioTimer = null;
function setupAutoBio(sock) {
    // One timer for the whole process (reconnects used to stack timers), and
    // the setting is checked every tick so toggling it takes effect without a restart.
    if (_autoBioTimer) clearInterval(_autoBioTimer);
    const tick = async () => {
        try {
            const s = await getCachedSettings();
            if (s.AUTO_BIO === "true") await AutoBio(sock);
        } catch (err) {
            console.error("AutoBio error:", err.message);
        }
    };
    setTimeout(tick, 5000);
    _autoBioTimer = setInterval(tick, 1000 * 60);
}

function setupAntiCall(sock) {
    sock.ev.on("call", async (json) => {
        try {
            await Anticall(json, sock);
        } catch (err) {
            console.error("[anticall] handler error:", err?.message || err);
        }
    });
}

let _newsletterCache = null;
let _newsletterCacheAt = 0;
const NEWSLETTER_TTL = 2 * 60 * 1000;

const NEWSLETTER_JIDS = ["120363425343959199@newsletter"];

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
                ms.key.participantAlt ||
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
            const isSuperUser = _isOwnerLike(ms, superUser, sender);

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

// Caches recent statuses by message id so that when the owner reacts to one
// later (a reaction only carries a key reference, not the actual content),
// we can still look up what was reacted to. Replying to a status DOES
// include the full quoted content already, so this cache is only needed
// for the reaction case. Auto-cleared after 24h (WhatsApp's own status
// lifetime) to avoid unbounded growth.
const recentStatusCache = new Map();
function cacheStatus(id, entry) {
    recentStatusCache.set(id, { ...entry, cachedAt: Date.now() });
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [key, val] of recentStatusCache) {
        if (val.cachedAt < cutoff) recentStatusCache.delete(key);
    }
}

// ids of reactions the bot itself sent (auto-like) -> must never trigger "save status"
const botReactionIds = new Set();
// ids of statuses already processed - skip duplicates and old backlog replays
const seenStatusIds = new Set();
// Fast in-memory message cache for getMessage() - see where it's populated below.
const fastMsgCache = new Map();

function setupStatusHandlers(sock) {
    const isTransient = (error) => {
        const code = error?.output?.statusCode || error?.code || "";
        const msg = String(error?.message || "");
        return code === 428 || ["Connection Closed", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "Connection Terminated", "Stream Errored"].some(t => msg.includes(t)) || ["ECONNRESET", "EPIPE"].includes(String(code));
    };

    async function handleStatus(mek) {
        if (!mek?.message || mek.key?.remoteJid !== "status@broadcast") return;

        if (mek.message?.ephemeralMessage) mek.message = mek.message.ephemeralMessage.message;
        // protocol/reaction messages on status@broadcast are not statuses
        if (mek.message?.protocolMessage || mek.message?.reactionMessage) return;

        // Don't re-process the same status twice, and don't react to a
        // backlog of OLD statuses replayed on reconnect/history-sync - with
        // no guard here, every reconnect would re-view/re-like everything
        // again, which both spams contacts and risks a rate-limit/ban.
        if (mek.key?.id) {
            if (seenStatusIds.has(mek.key.id)) return;
            seenStatusIds.add(mek.key.id);
            if (seenStatusIds.size > 2000) seenStatusIds.delete(seenStatusIds.values().next().value);
        }
        const statusTs = Number(mek.messageTimestamp?.low ?? mek.messageTimestamp ?? 0);
        if (statusTs && Date.now() / 1000 - statusTs > 120) {
            if (process.env.STATUS_DEBUG === "true") console.log(`[status-debug] skipping stale status id=${mek.key?.id} (${Math.round(Date.now() / 1000 - statusTs)}s old)`);
            return;
        }

        if (process.env.STATUS_DEBUG === "true") {
            console.log(`[status-debug] status update received from ${mek.key?.participant || mek.participant || "?"} (id=${mek.key?.id})`);
        }

        // Settings failing to load must NEVER be silently swallowed by the
        // isTransient() filter below (that's meant for socket/network noise,
        // not "the bot can't tell if a feature is even turned on").
        let s;
        try {
            s = await getCachedSettings();
        } catch (e) {
            console.error("[status] could not load settings - view/like skipped:", e?.message || e);
            return;
        }

        if (process.env.STATUS_DEBUG === "true") {
            console.log(`[status-debug] AUTO_READ_STATUS=${s.AUTO_READ_STATUS} AUTO_LIKE_STATUS=${s.AUTO_LIKE_STATUS}`);
        }

        // ── Resolve the poster ──────────────
        // key.participantPn is the phone-form JID Baileys 7 attaches to status
        // updates. Use it FIRST so WhatsApp maps the read receipt to the real
        // account. Fall back to participantAlt / participant, then resolve a
        // LID via the lid store if that's all we have.
        let participantJid =
            mek.key?.participantPn ||
            mek.key?.participantAlt ||
            mek.key?.participant ||
            mek.participant;
        if (!participantJid) return;

        if (String(participantJid).endsWith("@lid")) {
            try {
                const resolved = await resolveRealJid(sock, participantJid);
                if (resolved && !String(resolved).endsWith("@lid")) {
                    participantJid = resolved;
                }
            } catch (_) {}
        }

        if (mek.key?.id) cacheStatus(mek.key.id, { message: mek.message, participantJid });

        const selfJid = jidNormalizedUser(sock.user?.id || "");
        const selfLid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : null;

        // Key used for reactions / replies - keep EXACTLY as delivered.
        const keyForActions = { ...mek.key, remoteJid: "status@broadcast", fromMe: false };

        // Tell WhatsApp every identity form of the poster plus the bot itself.
        const statusJidList = [...new Set([
            mek.key?.participantPn,
            mek.key?.participantAlt,
            mek.key?.participant,
            participantJid,
            selfJid,
            selfLid,
        ].filter(Boolean).map((j) => String(j)))];

        // ── Auto view ──
        if (s.AUTO_READ_STATUS === "true") {
            try {
                await sock.readMessages([{
                    remoteJid: mek.key.remoteJid,
                    id: mek.key.id,
                    fromMe: mek.key.fromMe,          // ← preserved, not forced false
                    participant: participantJid,      // ← phone form (resolved)
                }]);
                if (process.env.STATUS_DEBUG === "true") {
                    console.log(`[status-debug] readMessages sent for ${mek.key?.id} participant=${participantJid}`);
                }
            }
            catch (e) { if (!isTransient(e)) console.error("[status] readMessages failed:", e?.message || e); }
        } else if (process.env.STATUS_DEBUG === "true") {
            console.log("[status-debug] skipped view - AUTO_READ_STATUS is not \"true\"");
        }

        // ── Auto like (independent of view) ──
        if (s.AUTO_LIKE_STATUS === "true" && !mek.key.fromMe) {
            try {
                // A small random delay before reacting looks less like an
                // obvious bot and reduces rate-limit/ban risk from instant,
                // mechanically-timed reactions.
                await new Promise((r) => setTimeout(r, 600 + Math.random() * 1400));
                const emojiList = String(s.STATUS_LIKE_EMOJIS || "💛,❤️,💜,🤍,💙")
                    .split(/[,\s]+/).map(e => e.trim()).filter(Boolean);
                const randomEmoji = emojiList[Math.floor(Math.random() * emojiList.length)] || "👍";
                const reactionId = (generateMessageIDV2 || generateMessageID)(sock.user?.id);
                botReactionIds.add(reactionId);
                setTimeout(() => botReactionIds.delete(reactionId), 10 * 60 * 1000);

                // React with the key EXACTLY as delivered (fromMe preserved,
                // participant = resolved phone form, remoteJid kept as-is).
                await sock.sendMessage(
                    mek.key.remoteJid,
                    {
                        react: {
                            text: randomEmoji,
                            key: {
                                remoteJid: mek.key.remoteJid,
                                id: mek.key.id,
                                fromMe: mek.key.fromMe,     // ← preserved, not false
                                participant: participantJid, // ← phone form
                            },
                        },
                    },
                    { messageId: reactionId, statusJidList: [participantJid] }
                );
                if (process.env.STATUS_DEBUG === "true") {
                    console.log(`[status-debug] like sent for ${mek.key?.id} emoji=${randomEmoji} participant=${participantJid}`);
                }
            } catch (e) { if (!isTransient(e)) console.error("[status] like/react failed:", e?.message || e); }
        } else if (process.env.STATUS_DEBUG === "true") {
            console.log(`[status-debug] skipped like - AUTO_LIKE_STATUS=${s.AUTO_LIKE_STATUS} fromMe=${!!mek.key.fromMe}`);
        }

        // ── Auto reply (independent) ──
        if (s.AUTO_REPLY_STATUS === "true" && !mek.key.fromMe) {
            try {
                const replyText = s.STATUS_REPLY_TEXT || DEFAULT_SETTINGS.STATUS_REPLY_TEXT;
                await sock.sendMessage(participantJid, { text: replyText }, { quoted: mek });
            } catch (e) { if (!isTransient(e)) console.error("[status] auto-reply failed:", e?.message || e); }
        }
    }

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type === "append") return;
        for (const mek of messages || []) {
            try { await handleStatus(mek); }
            catch (error) { if (!isTransient(error)) console.error("Error Processing Status Actions:", error); }
        }
    });
}

// Personal status saver — only on emoji reaction.
// Sends the status privately to the person who reacted (their DM with the bot).
// Does NOT send into groups or conversations. Works for any user.
function setupStatusAutosave(sock) {
    sock.ev.on("messages.upsert", async (mek) => {
        for (const ms of mek.messages || []) {
            try { await handleStatusSave(ms); }
            catch (e) { console.error("[status-autosave] failed:", e?.message || e); }
        }
    });

    async function handleStatusSave(ms) {
        {
            if (!ms || !ms.message) return;

            // Only trigger on emoji reactions to statuses
            const reaction = ms.message.reactionMessage;
            if (!reaction || reaction.key?.remoteJid !== "status@broadcast") return;

            // Ignore the bot's own auto-like reactions (this is what used to
            // "save" every status you merely viewed).
            if (ms.key?.id && botReactionIds.has(ms.key.id)) return;

            // Must have a real emoji (ignore empty / removal)
            const emoji = (reaction.text || "").trim();
            if (!emoji) return;

            // Resolve original status from cache
            const cached = recentStatusCache.get(reaction.key.id);
            if (!cached) return; // expired or never seen by the bot

            const statusMessage = cached.message;
            const statusOwnerJid = cached.participantJid;

            // Who reacted? The paired number's own reactions are fromMe, so
            // they resolve to the paired account itself (its own chat).
            const selfJid = jidNormalizedUser(sock.user?.id || "");
            const reactorJid = ms.key?.fromMe
                ? selfJid
                : jidNormalizedUser(ms.key.participant || ms.participant || "");
            if (!reactorJid || reactorJid === "status@broadcast") return;

            // Only the paired number / owner can trigger a save, and the saved
            // status ALWAYS goes to the owner's DM (bot inbox) - never into the
            // chat of whoever reacted.
            const ownerDigits = String((await getCachedSettings()).OWNER_NUMBER || "").replace(/\D/g, "");
            const reactorDigits = reactorJid.split("@")[0].split(":")[0].replace(/\D/g, "");
            if (!ms.key?.fromMe && !(ownerDigits && reactorDigits === ownerDigits)) return;
            const saveTo = (await resolveOwnerDeliveryJid(sock)) || selfJid;

            const label = statusOwnerJid
                ? `@${String(statusOwnerJid).split("@")[0]}`
                : "unknown";
            const caption = `📌 *Saved status* (from ${label})\nReacted with: ${emoji}`;

            const media = await processMediaMessage({
                key: reaction.key,
                message: statusMessage,
            });

            if (media) {
                const sendOptions = {
                    caption: `${caption}${media.caption ? `\n\n${media.caption}` : ""}`,
                };
                if (media.type === "image") {
                    await sock.sendMessage(saveTo, {
                        image: { url: media.path },
                        ...sendOptions,
                    });
                } else if (media.type === "video") {
                    await sock.sendMessage(saveTo, {
                        video: { url: media.path },
                        ...sendOptions,
                    });
                } else if (media.type === "audio") {
                    await sock.sendMessage(saveTo, {
                        audio: { url: media.path },
                        mimetype: media.mimetype,
                        ptt: media.ptt,
                    });
                } else if (media.type === "sticker") {
                    await sock.sendMessage(saveTo, {
                        sticker: { url: media.path },
                    });
                } else if (media.type === "document") {
                    await sock.sendMessage(saveTo, {
                        document: { url: media.path },
                        mimetype: media.mimetype,
                        fileName: media.fileName,
                        ...sendOptions,
                    });
                }
                fs.unlink(media.path, () => {});
            } else {
                const text =
                    statusMessage.extendedTextMessage?.text ||
                    statusMessage.conversation ||
                    "";
                if (text) {
                    await sock.sendMessage(saveTo, {
                        text: `${caption}\n\n${text}`,
                    });
                }
            }
        }
    }
}

// ✅ Safe rolling message deduplication
const processedMessages = new Set();
const BOT_START_TIME = Date.now();

const _jidNum = (j) => String(j || "").split("@")[0].split(":")[0].replace(/\D/g, "");
function _isOwnerLike(ms, superUser, sender) {
    if (ms?.key?.fromMe) return true;
    // sender as resolved, plus the raw phone-number forms WhatsApp may attach
    const candidates = [sender, ms?.key?.participantAlt, ms?.key?.participant];
    if (ms?.key?.remoteJid && !String(ms.key.remoteJid).endsWith("@g.us")) candidates.push(ms.key.remoteJid);
    const list = (superUser || []).map(_jidNum).filter(Boolean);
    // exact number match only (no partial/suffix matching)
    return candidates.some((c) => { const n = _jidNum(c); return !!n && list.includes(n); });
}

function setupCommandHandler(sock) {
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type === "append") return;
        for (const m of messages || []) {
            try { await handleCommandMessage(m); }
            catch (e) { console.error("[cmd] handler error:", e); }
        }
    });

    async function handleCommandMessage(ms) {
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
        const isSuperUser = _isOwnerLike(ms, superUser, sender);

        // Owner kill switch: when paused, ignore everything except your
        // exact number (not other sudo/superusers), matching .stop/.start
        // being restricted to 254757047860 only.
        if (settings.BOT_PAUSED === "true" && !isSuperUser) return;

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
    }
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

// Registered once, at process start - NOT inside connectToWhatsApp(), which
// runs again on every reconnect. Registering these there added a new SIGINT/
// SIGTERM listener on every single reconnect, which is a leak that compounds
// over a long-running, reconnect-heavy session.
process.on("SIGINT", async () => {
    try { await store?.destroy(); } catch (e) {}
    process.exit(0);
});
process.on("SIGTERM", async () => {
    try { await store?.destroy(); } catch (e) {}
    process.exit(0);
});

(async () => {
    await loadSession();
    await loadBotSettings();
    connectToWhatsApp();
})();
