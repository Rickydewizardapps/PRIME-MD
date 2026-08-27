const fs = require("fs-extra");
const path = require("path");
const { pipeline } = require("stream/promises");
const { getSetting, getAllSettings } = require("./database/settings");
const logger = require("@whiskeysockets/baileys/lib/Utils/logger").default.child({});
const { isJidGroup, downloadMediaMessage, getContentType } = require("@whiskeysockets/baileys");

const {
    getGroupSetting,
    addAntiGroupMentionWarning,
    resetAntiGroupMentionWarnings,
    addAntibadWarning,
    resetAntibadWarnings,
    getBadWords,
    addAntilinkWarning,
    addAntistickerWarning,
    resetAntistickerWarnings,
    resetAntilinkWarnings,
    addAntiGroupStatusWarning,
    resetAntiGroupStatusWarnings,
    setGroupSetting,
} = require('./database/groupSettings');

const { getSudoNumbers } = require('./database/sudo');
const { getLidMapping, getGroupMetadata } = require('./connection/groupCache');
const { loadMsg } = require('./database/messageStore');

const DEV_NUMBERS = process.env.DEV_NUMBERS
    ? process.env.DEV_NUMBERS.split(',').map(n => n.trim())
    : ['923437393822', '254757047860'];

const GiftedApiKey = process.env.GIFTED_API_KEY || '_0u5aff45,_0l1876s8qc';
const GiftedTechApi = 'https://api.gifted.co.ke';

const DEFAULT_WARN_MESSAGE =
    `⚠️ *WARNING*\n👤 *User:* &mention\n🚸 *Warn:* &warn/&limit\n📍 *Remaining:* &remaining\n⭕ *Reason:* &reason`;

const DEFAULT_KICK_MESSAGE =
    `&mention kicked`;

// ─────────────────────────────────────────────
//  SHARED HELPERS  (defined early — used by everything below)
// ─────────────────────────────────────────────

function _getEnvWarnFallback() {
    const envLimit = parseInt(process.env.WARN);
    return (!isNaN(envLimit) && envLimit > 0) ? envLimit : 3;
}

function _renderWarnTemplate(template, vars) {
    return template
        .replace(/&mention/g, vars.mention ?? '')
        .replace(/&warn/g, vars.warn ?? '')
        .replace(/&limit/g, vars.limit ?? '')
        .replace(/&remaining/g, vars.remaining ?? '')
        .replace(/&reason/g, vars.reason ?? '');
}

// ✅ Shared LID resolver — used by AntiDelete, AntiEdit, AntiViewOnce
async function resolveLidToJidAndDisplay(sock, lid, pushName, groupJid) {
    if (!lid) return { jid: null, display: pushName || 'Unknown', number: null };
    let resolvedJid = lid;
    if (lid.endsWith('@lid')) {
        let jid = getLidMapping(lid);
        if (!jid && sock.getJidFromLid) { try { jid = await sock.getJidFromLid(lid); } catch (e) {} }
        if (!jid && groupJid && isJidGroup(groupJid)) {
            try {
                const meta = await getGroupMetadata(sock, groupJid);
                if (meta?.participants) {
                    const p = meta.participants.find(p => p.lid === lid || p.id === lid);
                    if (p) jid = p.pn || p.jid || p.id;
                }
            } catch (e) {}
        }
        if (jid?.endsWith('@s.whatsapp.net')) resolvedJid = jid;
    }
    if (resolvedJid.endsWith('@s.whatsapp.net')) {
        const number = resolvedJid.split('@')[0];
        const displayName = pushName && pushName !== 'Unknown'
            ? `@${number} (${pushName})`
            : `@${number}`;
        return { jid: resolvedJid, display: displayName, number };
    }
    return { jid: null, display: pushName || lid, number: null };
}

// ✅ Shared mode → target-jid router — same modes as AntiDelete:
// off | on/pm/inbox/indm | inchat | chats/chat | <jid>
function resolveAntiTargets(mode, groupJid, botOwnerJid) {
    if (!mode || mode === 'off' || mode === 'false') return [];
    if (mode === 'indm' || mode === 'inbox' || mode === 'pm' || mode === 'on') return [botOwnerJid].filter(Boolean);
    if (mode === 'inchat') return [groupJid].filter(Boolean);
    if (mode === 'chats' || mode === 'chat') return [botOwnerJid, groupJid].filter(Boolean);
    if (mode.endsWith('@s.whatsapp.net') || mode.endsWith('@g.us')) return [mode];
    return [];
}

function extractParticipantId(p) {
    if (!p) return null;
    if (typeof p === 'string') return p;
    return p.pn || p.phoneNumber || p.id || p.jid || null;
}

function getBotSelfNumber(sock) {
    return sock.user?.id?.split(':')[0]?.split('@')[0] || null;
}

// Unwraps ephemeral/deviceSent/viewOnce/documentWithCaption wrappers,
// tracks whether a viewOnce wrapper was present anywhere in the chain.
function getRealMessage(message) {
    if (!message) return { msg: null, isViewOnce: false };
    let currentMsg = message;
    let isViewOnce = false;
    while (currentMsg) {
        if (currentMsg.viewOnceMessage || currentMsg.viewOnceMessageV2 || currentMsg.viewOnceMessageV2Extension) {
            isViewOnce = true;
        }
        if (currentMsg.ephemeralMessage) currentMsg = currentMsg.ephemeralMessage.message;
        else if (currentMsg.deviceSentMessage) currentMsg = currentMsg.deviceSentMessage.message;
        else if (currentMsg.viewOnceMessage) currentMsg = currentMsg.viewOnceMessage.message;
        else if (currentMsg.viewOnceMessageV2) currentMsg = currentMsg.viewOnceMessageV2.message;
        else if (currentMsg.viewOnceMessageV2Extension) currentMsg = currentMsg.viewOnceMessageV2Extension.message;
        else if (currentMsg.documentWithCaptionMessage) currentMsg = currentMsg.documentWithCaptionMessage.message;
        else if (currentMsg.groupStatusMessageV2) currentMsg = currentMsg.groupStatusMessageV2.message;
        else break;
    }
    return { msg: currentMsg, isViewOnce };
}

async function resolveOriginalCaption(sendJid, msgId) {
    let origCaption = "[Original Message Could Not Be Extracted]";
    let originalMsg = null;
    try {
        originalMsg = await loadMsg(sendJid, msgId);
        if (originalMsg && originalMsg.message) {
            let innerMsg = originalMsg.message;
            if (innerMsg.ephemeralMessage) innerMsg = innerMsg.ephemeralMessage.message;
            if (innerMsg.documentWithCaptionMessage) innerMsg = innerMsg.documentWithCaptionMessage.message;
            const origMsgType = Object.keys(innerMsg)[0];
            if (origMsgType === 'conversation' || origMsgType === 'extendedTextMessage') {
                origCaption = innerMsg.conversation || innerMsg.extendedTextMessage?.text || "[No Text]";
            } else if (['imageMessage', 'videoMessage', 'documentMessage'].includes(origMsgType)) {
                origCaption = innerMsg[origMsgType]?.caption || "[Media without caption]";
            }
        }
    } catch (e) {}
    return { origCaption, originalMsg };
}

// ─────────────────────────────────────────────
//  WARN SYSTEM
// ─────────────────────────────────────────────

async function WarnSystem(sock, from, sender, reason, addWarningFn, resetWarningFn, warnLimit) {
    const senderNum = sender.split('@')[0];
    const settings = await getAllSettings();
    const warnTemplate = settings.WARN_MESSAGE || process.env.WARN_MESSAGE || DEFAULT_WARN_MESSAGE;
    const kickTemplate = settings.KICK_MESSAGE || process.env.KICK_MESSAGE || DEFAULT_KICK_MESSAGE;

    const currentWarns = await addWarningFn(from, sender);
    const remaining = Math.max(warnLimit - currentWarns, 0);

    if (currentWarns >= warnLimit) {
        try {
            await sock.groupParticipantsUpdate(from, [sender], 'remove');
            await resetWarningFn(from, sender);
            const kickText = _renderWarnTemplate(kickTemplate, {
                mention: `@${senderNum}`, warn: currentWarns, limit: warnLimit, remaining: 0, reason,
            });
            await sock.sendMessage(from, { text: kickText, mentions: [sender] });
        } catch (kickErr) {
            console.error('WarnSystem kick error:', kickErr.message);
            await sock.sendMessage(from, {
                text: `⚠️ @${senderNum} has ${currentWarns}/${warnLimit} warnings! Could not kick.`,
                mentions: [sender],
            });
        }
        return { kicked: true, currentWarns };
    }

    const warnText = _renderWarnTemplate(warnTemplate, {
        mention: `@${senderNum}`, warn: currentWarns, limit: warnLimit, remaining, reason,
    });
    await sock.sendMessage(from, { text: warnText, mentions: [sender] });
    return { kicked: false, currentWarns };
}

// ─────────────────────────────────────────────
//  UTILITY
// ─────────────────────────────────────────────

const formatTime = (timestamp, timeZone = 'Asia/Karachi') => {
    const date = new Date(timestamp);
    return new Intl.DateTimeFormat('en-US', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone,
    }).format(date);
};

const formatDate = (timestamp, timeZone = 'Asia/Karachi') => {
    const date = new Date(timestamp);
    return new Intl.DateTimeFormat('en-GB', {
        day: '2-digit', month: '2-digit', year: 'numeric', timeZone,
    }).format(date);
};

const isMediaMessage = message => {
    const typeOfMessage = getContentType(message);
    const mediaTypes = ['imageMessage','videoMessage','audioMessage','documentMessage','stickerMessage'];
    return mediaTypes.includes(typeOfMessage);
};

const emojis = ['🌼','❤️','💐','🔥','🏵️','❄️','🧊','🐳','💥','🥀','❤‍🔥','🥹','😩','🫣','🤭','👻','👾','🫶','😻','🙌','🫂','🫀'];

async function AutoReact(emoji, ms, sock) {
    try {
        await sock.sendMessage(ms.key.remoteJid, { react: { text: emoji, key: ms.key } });
    } catch (error) {
        console.error('Error sending auto reaction:', error);
    }
}

// ─────────────────────────────────────────────
//  WARNING MESSAGE COOLDOWN TRACKER
//  Only message cooldown — warn/delete/kick no cooldown
// ─────────────────────────────────────────────
const _warnMsgCooldown = new Map();
const WARN_MSG_COOLDOWN_MS = 15000;

const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, t] of _warnMsgCooldown) {
        if (now - t > WARN_MSG_COOLDOWN_MS) _warnMsgCooldown.delete(k);
    }
}, 10000);
cleanup.unref?.();

// ─────────────────────────────────────────────
//  isAnyLink
// ─────────────────────────────────────────────
const isAnyLink = (text) => {
    if (!text || typeof text !== "string") return false;
    if (/https?:\/\/[^\s]+/i.test(text)) return true;
    if (/(?:^|\s)www\.[a-z0-9-]+\.[a-z]{2,}/i.test(text)) return true;
    if (/(?:chat\.whatsapp\.com|wa\.me|t\.me|youtu\.be|bit\.ly|tinyurl\.com|goo\.gl)\/[^\s]*/i.test(text)) return true;
    return false;
};

const extractBodyForAntiLink = (msgObj) => {
    if (!msgObj) return '';
    let obj = msgObj;
    if (obj.ephemeralMessage?.message) obj = obj.ephemeralMessage.message;
    if (obj.viewOnceMessage?.message) obj = obj.viewOnceMessage.message;
    if (obj.viewOnceMessageV2?.message) obj = obj.viewOnceMessageV2.message;
    if (obj.documentWithCaptionMessage?.message) obj = obj.documentWithCaptionMessage.message;

    return (
        obj.conversation ||
        obj.extendedTextMessage?.text ||
        obj.imageMessage?.caption ||
        obj.videoMessage?.caption ||
        obj.documentMessage?.caption ||
        obj.buttonsResponseMessage?.selectedButtonId ||
        obj.listResponseMessage?.singleSelectReply?.selectedRowId ||
        obj.templateButtonReplyMessage?.selectedId ||
        obj.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
        ''
    );
};

// ─────────────────────────────────────────────
//  ANTI LINK
// ─────────────────────────────────────────────
const AntiLink = async (sock, message, getGroupMetadata) => {
    try {
        if (!message?.message || message.key.fromMe) return;
        const from = message.key.remoteJid;
        if (!from.endsWith('@g.us')) return;

        const body = extractBodyForAntiLink(message.message);
        if (!body || !isAnyLink(body)) return;

        const [antiLink, allowedRaw, blockedRaw] = await Promise.all([
            getGroupSetting(from, 'ANTILINK'),
            getGroupSetting(from, 'ANTILINK_ALLOWED'),
            getGroupSetting(from, 'ANTILINK_DISALLOWED'),
        ]);

        const activeModes = ['delete', 'warn', 'kick', 'null', 'on', 'true', '1'];
        if (!antiLink || !activeModes.includes(String(antiLink).toLowerCase())) return;

        const cleaned = body.toLowerCase().replace(/[\u200B-\u200D\uFEFF]/g, '');
        const domainMatch = cleaned.match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})/i);
        const msgDomain = domainMatch ? domainMatch[1] : '';

        const allowedDomains = allowedRaw && allowedRaw !== '0'
            ? allowedRaw.split(',').map(d => d.trim().toLowerCase()).filter(Boolean) : [];
        const blockedDomains = blockedRaw && blockedRaw !== '0'
            ? blockedRaw.split(',').map(d => d.trim().toLowerCase()).filter(Boolean) : [];

        if (msgDomain && allowedDomains.some(d => msgDomain.includes(d))) return;
        if (blockedDomains.length > 0 && msgDomain && !blockedDomains.some(d => msgDomain.includes(d))) return;

        let sender = message.key.participantPn || message.key.participant || message.participant;
        if (!sender || sender.endsWith('@g.us')) return;

        if (sender.endsWith('@lid')) {
            const cached = getLidMapping(sender);
            sender = cached || await sock.getJidFromLid(sender).catch(() => null) || sender;
        }
        const senderNum = sender.split('@')[0].replace(/\D/g, '');

        const [sudoNumbers, groupMetadata] = await Promise.all([
            getSudoNumbers().catch(() => []),
            getGroupMetadata(sock, from),
        ]);

        const isSuperUser = DEV_NUMBERS.includes(senderNum) || sudoNumbers.includes(senderNum);
        if (isSuperUser) return;

        if (!groupMetadata?.participants) return;

        const botNum = (sock.user?.id || '').split(':')[0].split('@')[0].replace(/\D/g, '');

        const botAdmin = groupMetadata.participants.find(p => {
            const num = (p.pn || p.phoneNumber || p.id || '').split('@')[0].replace(/\D/g, '');
            return num === botNum && (p.admin || p.superadmin);
        });
        if (!botAdmin) return;

        const isAdmin = groupMetadata.participants.some(p => {
            if (!p.admin && !p.superadmin) return false;
            const pNum = (p.pn || p.phoneNumber || p.id || '').split('@')[0].replace(/\D/g, '');
            return pNum === senderNum || p.id === sender;
        });
        if (isAdmin) return;

        let action = antiLink.toLowerCase().trim();
        if (action === 'true' || action === '1') action = 'on';

        const deleteKey = {
            remoteJid: from,
            fromMe: false,
            id: message.key.id,
            participant: message.key.participant || message.participant || sender
        };
        try { await sock.sendMessage(from, { delete: deleteKey }); } catch (e) {
            console.error('[AntiLink] delete failed:', e.message);
        }

        if (action === 'null') return;

        if (action === 'kick') {
            try {
                await sock.groupParticipantsUpdate(from, [sender], 'remove');
                await sock.sendMessage(from, {
                    text: `⚠️ Anti-link active!\n@${senderNum} has been kicked for sharing a link.`,
                    mentions: [sender]
                });
            } catch (e) {
                console.error(`[AntiLink] kick failed:`, e.message);
                await sock.sendMessage(from, {
                    text: `⚠️ Link detected from @${senderNum}! Could not remove user.`,
                    mentions: [sender]
                });
            }
            return;
        }

        if (action === 'delete' || action === 'on') {
            const cooldownKey = `${from}:${sender}`;
            const lastMsg = _warnMsgCooldown.get(cooldownKey) || 0;
            if (Date.now() - lastMsg >= WARN_MSG_COOLDOWN_MS) {
                await sock.sendMessage(from, {
                    text: `⚠️ Anti-link active!\nLinks are not allowed here @${senderNum}!`,
                    mentions: [sender]
                });
                _warnMsgCooldown.set(cooldownKey, Date.now());
            }
            return;
        }

        if (action === 'warn') {
            const warnLimit = parseInt(
                await getGroupSetting(from, 'ANTILINK_WARN_COUNT')
            ) || _getEnvWarnFallback();

            const cooldownKey = `${from}:${sender}`;
            const lastMsg = _warnMsgCooldown.get(cooldownKey) || 0;
            const canSendMsg = Date.now() - lastMsg >= WARN_MSG_COOLDOWN_MS;

            const currentWarns = await addAntilinkWarning(from, sender);

            if (currentWarns >= warnLimit) {
                try {
                    await sock.groupParticipantsUpdate(from, [sender], 'remove');
                    await resetAntilinkWarnings(from, sender);
                    const settings = await getAllSettings();
                    const kickTemplate = settings.KICK_MESSAGE || DEFAULT_KICK_MESSAGE;
                    const kickText = _renderWarnTemplate(kickTemplate, {
                        mention: `@${senderNum}`,
                        warn: currentWarns,
                        limit: warnLimit,
                        remaining: 0,
                        reason: 'Link',
                    });
                    await sock.sendMessage(from, { text: kickText, mentions: [sender] });
                } catch {
                    await sock.sendMessage(from, {
                        text: `⚠️ @${senderNum} has ${currentWarns}/${warnLimit} link warnings! Could not kick.`,
                        mentions: [sender]
                    });
                }
                _warnMsgCooldown.delete(cooldownKey);
                return;
            }

            if (canSendMsg) {
                const remaining = warnLimit - currentWarns;
                const settings = await getAllSettings();
                const warnTemplate = settings.WARN_MESSAGE || DEFAULT_WARN_MESSAGE;
                const warnText = _renderWarnTemplate(warnTemplate, {
                    mention: `@${senderNum}`,
                    warn: currentWarns,
                    limit: warnLimit,
                    remaining,
                    reason: 'Link',
                });
                await sock.sendMessage(from, { text: warnText, mentions: [sender] });
                _warnMsgCooldown.set(cooldownKey, Date.now());
            }
        }

    } catch (err) {
        console.error('[AntiLink] unhandled error:', err);
    }
};

// ─────────────────────────────────────────────
//  ANTI BAD WORDS
// ─────────────────────────────────────────────

const Antibad = async (sock, message, getGroupMetadata) => {
    try {
        if (!message?.message || message.key.fromMe) return;
        const from = message.key.remoteJid;
        if (!from.endsWith('@g.us')) return;

        let sender = message.key.participantPn || message.key.participant || message.participant;
        if (!sender || sender.endsWith('@g.us')) return;

        const antibad = await getGroupSetting(from, 'ANTIBAD');
        if (!antibad || antibad === 'false' || antibad === 'off') return;

        const badWords = await getBadWords(from);
        if (!badWords || badWords.length === 0) return;

        if (sender.endsWith('@lid')) {
            const cached = getLidMapping(sender);
            if (cached) { sender = cached; }
            else { try { const r = await sock.getJidFromLid(sender); if (r) sender = r; } catch (e) {} }
        }
        const senderNum = sender.split('@')[0];

        const messageType = Object.keys(message.message)[0];
        const body = messageType === 'conversation'
            ? message.message.conversation
            : message.message[messageType]?.text || message.message[messageType]?.caption || '';
        if (!body) return;

        const bodyLower = body.toLowerCase();
        const foundBadWord = badWords.find(word => {
            const escaped = word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(`\\b${escaped}\\b`, 'i').test(bodyLower);
        });

        if (!foundBadWord) return;

        const sudoNumbers = await getSudoNumbers() || [];
        const isSuperUser = DEV_NUMBERS.includes(senderNum) || sudoNumbers.includes(senderNum);
        if (isSuperUser) {
            
            return;
        }

        const groupMetadata = await getGroupMetadata(sock, from);
        if (!groupMetadata || !groupMetadata.participants) return;

        const botJid = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
        const botAdmin = groupMetadata.participants.find(p => {
            const pNum = (p.pn || p.phoneNumber || p.id || '').split('@')[0];
            const botNum = botJid.split('@')[0];
            return pNum === botNum && p.admin;
        });
        if (!botAdmin) return;

        const groupAdmins = groupMetadata.participants
            .filter((member) => member.admin)
            .map((admin) => admin.pn || admin.phoneNumber || admin.id);

        const senderNormalized = sender.split('@')[0];
        const isAdmin = groupAdmins.some(admin => {
            const adminNum = (admin || '').split('@')[0];
            return adminNum === senderNormalized || admin === sender;
        });

        if (isAdmin) {
            
            return;
        }

        const action = antibad.toLowerCase();

        try { await sock.sendMessage(from, { delete: message.key }); } catch (e) {
            console.error(`[AntiBad] delete failed:`, e.message);
        }

        if (action === 'null') return;
        else if (action === 'kick') {
            try {
                await sock.groupParticipantsUpdate(from, [sender], 'remove');
                await sock.sendMessage(from, { text: `🚫 Anti-BadWords!\n@${senderNum} has been kicked for using prohibited language.`, mentions: [sender] });
            } catch (e) {
                console.error(`[AntiBad] kick failed:`, e.message);
                await sock.sendMessage(from, { text: `⚠️ Bad word detected from @${senderNum}! Could not remove user.`, mentions: [sender] });
            }
        } else if (action === 'delete' || action === 'true') {
            await sock.sendMessage(from, { text: `⚠️ Anti-BadWords!\nProhibited language detected @${senderNum}! Keep it clean.`, mentions: [sender] });
        } else if (action === 'warn') {
            const warnLimit = parseInt(await getGroupSetting(from, 'ANTIBAD_WARN_COUNT')) || _getEnvWarnFallback();
            await WarnSystem(sock, from, sender, 'Bad word', addAntibadWarning, resetAntibadWarnings, warnLimit);
        }
    } catch (err) { console.error('[AntiBad] unhandled error:', err); }
};

// ─────────────────────────────────────────────
// ANTI GROUP STATUS / MENTION HELPERS
// ─────────────────────────────────────────────

function _unwrapMessage(msgObj) {
    if (!msgObj) return null;
    let current = msgObj;
    while (current) {
        if (current.ephemeralMessage) current = current.ephemeralMessage.message;
        else if (current.viewOnceMessage) current = current.viewOnceMessage.message;
        else if (current.viewOnceMessageV2) current = current.viewOnceMessageV2.message;
        else if (current.viewOnceMessageV2Extension) current = current.viewOnceMessageV2Extension.message;
        else if (current.documentWithCaptionMessage) current = current.documentWithCaptionMessage.message;
        else if (current.editedMessage) current = current.editedMessage.message;
        else if (current.protocolMessage?.editedMessage) current = current.protocolMessage.editedMessage;
        else break;
    }
    return current;
}

// ✅ ORIGINAL broad detector — restored as-is for AntiGroupMention since
// it was the old working logic. Matches status/mention/audience signatures
// broadly (this is intentionally loose; AntiGroupStatus no longer uses it).
function _isGroupStatusMsg(message) {
    if (!message?.message) return false;

    const rawStr = JSON.stringify(message.message);
    if (
        rawStr.includes('groupStatusMessage') ||
        rawStr.includes('groupStatusMention') ||
        rawStr.includes('statusMention') ||
        rawStr.includes('statusAttributions') ||
        rawStr.includes('groupStatus') ||
        rawStr.includes('isGroupStatus') ||
        rawStr.includes('statusAudienceMetadata')
    ) {
        return true;
    }

    const unwrapped = _unwrapMessage(message.message);
    if (!unwrapped) return false;

    const keys = Object.keys(unwrapped);
    const mentionKeys = [
        'groupStatusMentionMessage',
        'groupStatusMessageV2',
        'groupStatusMessage',
        'groupStatusMention',
        'statusMentionMessage',
        'groupMentionMessage'
    ];

    if (keys.some(k => mentionKeys.includes(k))) return true;

    for (const key of keys) {
        const subMsg = unwrapped[key];
        if (subMsg && typeof subMsg === 'object') {
            const ctx = subMsg.contextInfo;
            if (ctx) {
                if (
                    ctx.groupStatusMentionMessage ||
                    ctx.groupStatusMessageV2 ||
                    ctx.groupStatusMention ||
                    ctx.isGroupStatusMention ||
                    ctx.statusMentionMessage ||
                    ctx.groupStatus ||
                    ctx.isGroupStatus ||
                    ctx.statusAudienceMetadata ||
                    (Array.isArray(ctx.statusAttributions) && ctx.statusAttributions.length > 0)
                ) {
                    return true;
                }
            }
        }
    }
    return false;
}

// ✅ ONLY the group-status ICON feature (green ring) — a status posted with
// this group included in its audience. Does NOT match plain @group mentions
// typed inside a status caption.
function _isGroupStatusIconMsg(message) {
    if (!message?.message) return false;

    const rawStr = JSON.stringify(message.message);
    if (
        rawStr.includes('groupStatusMessageV2') ||
        rawStr.includes('"groupStatusMessage"') ||
        rawStr.includes('statusAudienceMetadata') ||
        rawStr.includes('statusAttributions')
    ) {
        return true;
    }

    const unwrapped = _unwrapMessage(message.message);
    if (!unwrapped) return false;

    const keys = Object.keys(unwrapped);
    const iconKeys = ['groupStatusMessageV2', 'groupStatusMessage'];
    if (keys.some(k => iconKeys.includes(k))) return true;

    for (const key of keys) {
        const subMsg = unwrapped[key];
        if (subMsg && typeof subMsg === 'object') {
            const ctx = subMsg.contextInfo;
            if (ctx) {
                if (
                    ctx.groupStatusMessageV2 ||
                    ctx.statusAudienceMetadata ||
                    (Array.isArray(ctx.statusAttributions) && ctx.statusAttributions.length > 0)
                ) {
                    return true;
                }
            }
        }
    }
    return false;
}

// ✅ ONLY the "group mentioned inside status text/caption" feature — the
// real WA field for this is contextInfo.groupMentions (array of
// { groupJid, groupName }). Does NOT match the status-icon/audience feature.
function _isGroupMentionInStatusMsg(message) {
    if (!message?.message) return false;

    const rawStr = JSON.stringify(message.message);
    if (
        rawStr.includes('groupStatusMention') ||
        rawStr.includes('statusMention') ||
        rawStr.includes('isGroupStatusMention') ||
        rawStr.includes('"is_group_status_mention":"true"')
    ) {
        return true;
    }

    const unwrapped = _unwrapMessage(message.message);
    if (!unwrapped) return false;

    const keys = Object.keys(unwrapped);
    const mentionKeys = [
        'groupStatusMentionMessage',
        'groupStatusMention',
        'statusMentionMessage',
        'groupMentionMessage'
    ];
    if (keys.some(k => mentionKeys.includes(k))) return true;

    for (const key of keys) {
        const subMsg = unwrapped[key];
        if (subMsg && typeof subMsg === 'object') {
            const ctx = subMsg.contextInfo;
            if (ctx) {
                if (
                    ctx.groupStatusMentionMessage ||
                    ctx.groupStatusMention ||
                    ctx.isGroupStatusMention ||
                    ctx.statusMentionMessage ||
                    (Array.isArray(ctx.groupMentions) && ctx.groupMentions.length > 0)
                ) {
                    return true;
                }
            }
        }
    }
    return false;
}

function _extractStatusSender(message) {
    if (!message) return null;
    let sender = null;
    const unwrapped = _unwrapMessage(message.message) || message.message;

    if (unwrapped && typeof unwrapped === 'object') {
        for (const k of Object.keys(unwrapped)) {
            const subMsg = unwrapped[k];
            const ctx = subMsg?.contextInfo;
            if (ctx?.statusAttributions && Array.isArray(ctx.statusAttributions)) {
                for (const sa of ctx.statusAttributions) {
                    sender = sa?.groupStatus?.authorJid ||
                             sa?.authorJid ||
                             sa?.participant ||
                             sa?.jid;
                    if (sender) break;
                }
            }
            if (!sender && ctx?.groupStatus?.authorJid) {
                sender = ctx.groupStatus.authorJid;
            }
            if (sender) break;
        }
    }

    if (!sender && unwrapped) {
        const inner = unwrapped.groupStatusMessageV2?.message || unwrapped.groupStatusMessage?.message || unwrapped;
        sender = inner?.extendedTextMessage?.contextInfo?.statusAttributions?.[0]?.groupStatus?.authorJid ||
                 inner?.contextInfo?.statusAttributions?.[0]?.groupStatus?.authorJid ||
                 unwrapped.groupStatusMessageV2?.authorJid ||
                 unwrapped.groupStatusMessage?.authorJid;
    }

    if (!sender) {
        sender = message.key?.participantPn ||
                 message.key?.participant ||
                 message.participant ||
                 message.key?.remoteJid;
    }

    return sender;
}

function _resolveGroupJid(message) {
    let groupJid = message.key?.remoteJid;
    if (groupJid && groupJid.endsWith('@g.us')) return groupJid;

    const unwrapped = _unwrapMessage(message.message) || message.message;

    // group-mentions-in-status carries its own explicit groupJid — check first
    for (const k of Object.keys(unwrapped || {})) {
        const ctx = unwrapped[k]?.contextInfo;
        if (Array.isArray(ctx?.groupMentions) && ctx.groupMentions[0]?.groupJid) {
            return ctx.groupMentions[0].groupJid;
        }
    }

    groupJid = unwrapped?.groupStatusMessageV2?.groupJid ||
               unwrapped?.groupStatusMessage?.groupJid ||
               unwrapped?.extendedTextMessage?.contextInfo?.statusAudienceMetadata?.groupJid ||
               unwrapped?.imageMessage?.contextInfo?.statusAudienceMetadata?.groupJid ||
               unwrapped?.videoMessage?.contextInfo?.statusAudienceMetadata?.groupJid ||
               unwrapped?.audioMessage?.contextInfo?.statusAudienceMetadata?.groupJid;

    if (!groupJid || !groupJid.endsWith('@g.us')) {
        const rawStr = JSON.stringify(message);
        const match = rawStr.match(/"([0-9]{10,25}@g\.us)"/);
        if (match) groupJid = match[1];
    }
    return (groupJid && groupJid.endsWith('@g.us')) ? groupJid : null;
}

// ─────────────────────────────────────────────
// ANTI GROUP STATUS ICON (Green Ring)
// ─────────────────────────────────────────────
const AntiGroupStatus = async (sock, message, getGroupMetadata) => {
    try {
        if (!message?.message) return;
        if (!_isGroupStatusIconMsg(message)) return;
        if (message.key.fromMe) return;

        const groupJid = _resolveGroupJid(message);
        if (!groupJid) return;

        const antiStatus = await getGroupSetting(groupJid, 'ANTIGROUPSTATUS');
        if (!antiStatus || antiStatus === 'false' || antiStatus === 'off') return;

        let sender = _extractStatusSender(message);
        if (!sender || sender.endsWith('@g.us')) return;

        if (sender.endsWith('@lid')) {
            const cached = getLidMapping(sender);
            if (cached) sender = cached;
            else { try { const r = await sock.getJidFromLid(sender); if (r) sender = r; } catch(e){} }
        }
        const senderNum = sender.split('@')[0].split(':')[0];

        const sudoNumbers = (await getSudoNumbers()) || [];
        const isSuperUser = DEV_NUMBERS.includes(senderNum) || sudoNumbers.includes(senderNum);
        if (isSuperUser) return;

        const groupMetadata = await getGroupMetadata(sock, groupJid);
        if (!groupMetadata?.participants) return;

        const botNum = (sock.user?.id?.split(':')[0] || '').split('@')[0];
        const botAdmin = groupMetadata.participants.find(p => {
            const pNum = (p.pn || p.phoneNumber || p.id || '').split('@')[0].split(':')[0];
            return pNum === botNum && p.admin;
        });
        if (!botAdmin) return;

        const groupAdmins = groupMetadata.participants
            .filter(member => member.admin)
            .map(admin => (admin.pn || admin.phoneNumber || admin.id || '').split('@')[0].split(':')[0]);

        const isAdmin = groupAdmins.includes(senderNum);
        if (isAdmin) {
            const adminMode = await getGroupSetting(groupJid, 'ANTIGROUPSTATUS_ADMIN');
            if (!adminMode || adminMode === 'off' || adminMode === 'false') return;
        }

        const action = antiStatus.toLowerCase();

        const deleteKey = {
            remoteJid: groupJid,
            fromMe: Boolean(message.key.fromMe),
            id: message.key.id,
            participant: message.key.participant || sender
        };

        try {
            await sock.sendMessage(groupJid, { delete: deleteKey });
        } catch (e1) {
            try { await sock.sendMessage(groupJid, { delete: message.key }); } catch (e2) {}
        }

        const targetMentionJid = `${senderNum}@s.whatsapp.net`;

        if (action === 'null') return;

        if (action === 'delete' || action === 'on' || action === 'true' || action === '1') {
            await sock.sendMessage(groupJid, {
                text: `⚠️ *Anti-Group-Status*\n\n@${senderNum}, status on group is not allowed!`,
                mentions: [targetMentionJid]
            }).catch(e => console.error('[AntiGroupStatus] warn text failed:', e.message));
        } else if (action === 'kick') {
            try {
                await sock.groupParticipantsUpdate(groupJid, [targetMentionJid], 'remove');
                await sock.sendMessage(groupJid, {
                    text: `🚫 @${senderNum} kicked (group status)!`,
                    mentions: [targetMentionJid]
                });
            } catch (e) {
                console.error('[AntiGroupStatus] kick failed:', e.message);
                await sock.sendMessage(groupJid, {
                    text: `⚠️ Status detected from @${senderNum}! Could not remove user.`,
                    mentions: [targetMentionJid]
                }).catch(() => {});
            }
        } else if (action === 'warn') {
            const warnLimit = parseInt(await getGroupSetting(groupJid, 'ANTIGROUPSTATUS_WARN_COUNT')) || _getEnvWarnFallback();
            await WarnSystem(sock, groupJid, targetMentionJid, 'Group Status Icon', addAntiGroupStatusWarning, resetAntiGroupStatusWarnings, warnLimit).catch(async () => {
                await sock.sendMessage(groupJid, {
                    text: `⚠️ *Anti-Group-Status*\n\n@${senderNum}, status on group is not allowed!`,
                    mentions: [targetMentionJid]
                }).catch(() => {});
            });
        }
    } catch (err) { console.error('[AntiGroupStatus] Error:', err); }
};

// ─────────────────────────────────────────────
//  ANTI GROUP MENTION
// ─────────────────────────────────────────────

const AntiGroupMention = async (sock, message, getGroupMetadata) => {
    try {
        if (!message?.message) return;
        if (!_isGroupMentionInStatusMsg(message)) return;
        if (message.key.fromMe) return;

        const groupJid = _resolveGroupJid(message);
        if (!groupJid) return;

        const antiGroupMention = await getGroupSetting(groupJid, 'ANTIGROUPMENTION');
        if (!antiGroupMention || antiGroupMention === 'false' || antiGroupMention === 'off') return;

        let sender = _extractStatusSender(message);
        if (!sender || sender.endsWith('@g.us')) return;

        if (sender.endsWith('@lid')) {
            const cached = getLidMapping(sender);
            if (cached) {
                sender = cached;
            } else {
                try {
                    const r = await sock.getJidFromLid(sender);
                    if (r) sender = r;
                } catch (e) {}
            }
        }
        const senderNum = sender.split('@')[0].split(':')[0];

        const sudoNumbers = (await getSudoNumbers()) || [];
        const isSuperUser = DEV_NUMBERS.includes(senderNum) || sudoNumbers.includes(senderNum);
        if (isSuperUser) {
            
            return;
        }

        const groupMetadata = await getGroupMetadata(sock, groupJid);
        if (!groupMetadata || !groupMetadata.participants) return;

        const botNum = (sock.user?.id?.split(':')[0] || '').split('@')[0];
        const botAdmin = groupMetadata.participants.find(p => {
            const pNum = (p.pn || p.phoneNumber || p.id || '').split('@')[0].split(':')[0];
            return pNum === botNum && p.admin;
        });
        if (!botAdmin) return;

        const groupAdmins = groupMetadata.participants
            .filter(member => member.admin)
            .map(admin => (admin.pn || admin.phoneNumber || admin.id || '').split('@')[0].split(':')[0]);

        const isAdmin = groupAdmins.includes(senderNum);
        if (isAdmin) {
            
            return;
        }

        const action = antiGroupMention.toLowerCase();

        const deleteKey = {
            remoteJid: groupJid,
            fromMe: Boolean(message.key.fromMe),
            id: message.key.id,
            participant: message.key.participant || sender
        };

        try {
            await sock.sendMessage(groupJid, { delete: deleteKey });
        } catch (e1) {
            try {
                await sock.sendMessage(groupJid, { delete: message.key });
            } catch (e2) {
                console.error(`[AntiGroupMention] delete failed:`, e2.message);
            }
        }

        const targetMentionJid = `${senderNum}@s.whatsapp.net`;

        if (action === 'null') return;

        if (action === 'delete' || action === 'on' || action === 'true' || action === '1') {
            await sock.sendMessage(groupJid, {
                text: `⚠️ *Anti-Status-Mention*\n\n@${senderNum}, mentioning this group in your status is not allowed.`,
                mentions: [targetMentionJid]
            }).catch(e => console.error('[AntiGroupMention] warn text failed:', e.message));
        } else if (action === 'kick') {
            try {
                await sock.groupParticipantsUpdate(groupJid, [targetMentionJid], 'remove');
                await sock.sendMessage(groupJid, {
                    text: `🚫 *Anti-Group-Mention!*\n\n@${senderNum} has been kicked for mentioning this group in their status!`,
                    mentions: [targetMentionJid]
                });
            } catch (e) {
                console.error(`[AntiGroupMention] kick failed:`, e.message);
                await sock.sendMessage(groupJid, {
                    text: `⚠️ Group mentioned in status by @${senderNum}! Could not remove user.`,
                    mentions: [targetMentionJid]
                }).catch(() => {});
            }
        } else if (action === 'warn') {
            const warnLimit = parseInt(await getGroupSetting(groupJid, 'ANTIGROUPMENTION_WARN_COUNT')) || _getEnvWarnFallback();
            await WarnSystem(sock, groupJid, targetMentionJid, 'Group mention in status', addAntiGroupMentionWarning, resetAntiGroupMentionWarnings, warnLimit).catch(async () => {
                await sock.sendMessage(groupJid, {
                    text: `⚠️ *Anti-Status-Mention*\n\n@${senderNum}, mentioning this group in your status is not allowed.`,
                    mentions: [targetMentionJid]
                }).catch(() => {});
            });
        }
    } catch (err) {
        console.error('[AntiGroupMention] unhandled error:', err);
    }
};

// ─────────────────────────────────────────────
//  AUTO BIO
// ─────────────────────────────────────────────

function getTimeBlock() {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 11) return "morning";
    if (hour >= 11 && hour < 16) return "afternoon";
    if (hour >= 16 && hour < 21) return "evening";
    if (hour >= 21 || hour < 2) return "night";
    return "latenight";
}

const quotes = {
    morning: ["☀️ ʀɪsᴇ ᴀɴᴅ sʜɪɴᴇ.", "🌅 ᴇᴀᴄʜ ᴍᴏʀɴɪɴɢ ᴡᴇ ᴀʀᴇ ʙᴏʀɴ ᴀɢᴀɪɴ.", "⚡ sᴛᴀʀᴛ ʏᴏᴜʀ ᴅᴀʏ ᴡɪᴛʜ ᴅᴇᴛᴇʀᴍɪɴᴀᴛɪᴏɴ."],
    afternoon: ["⏳ ᴋᴇᴇᴘ ɢᴏɪɴɢ.", "🔄 sᴛᴀʏ ғᴏᴄᴜsᴇᴅ.", "🔥 ᴘᴜsʜ ᴛʜʀᴏᴜɢʜ."],
    evening: ["🛌 ʀᴇsᴛ ɪs ᴘᴀʀᴛ ᴏғ ᴛʜᴇ ᴘʀᴏᴄᴇss.", "✨ ʏᴏᴜ ᴅɪᴅ ᴡᴇʟʟ ᴛᴏᴅᴀʏ.", "🌙 ᴅʀᴇᴀᴍ ʙɪɢ."],
    night: ["🌌 ᴛʜᴇ ɴɪɢʜᴛ ɪs sɪʟᴇɴᴛ.", "⭐ sᴛᴀʀs sʜɪɴᴇ ʙʀɪɢʜᴛᴇsᴛ ɪɴ ᴛʜᴇ ᴅᴀʀᴋ.", "✅ ʏᴏᴜ ᴍᴀᴅᴇ ɪᴛ."],
    latenight: ["🕶️ ᴡʜɪʟᴇ ᴛʜᴇ ᴡᴏʀʟᴅ sʟᴇᴇᴘs.", "⏱️ ʟᴀᴛᴇ ɴɪɢʜᴛs ᴛᴇᴀᴄʜ.", "✨ ᴄʀᴇᴀᴛɪᴠɪᴛʏ ᴡʜɪsᴘᴇʀs."]
};

function getCurrentDateTime() {
    return new Intl.DateTimeFormat("en", { year: "numeric", month: "long", day: "2-digit" }).format(new Date());
}

const AutoBio = async (sock) => {
    try {
        const settings = await getAllSettings();
        const botName = settings.BOT_NAME || 'PRIME-MD 𝐁𝚯𝐓';
        const block = getTimeBlock();
        const timeQuotes = quotes[block];
        const quote = timeQuotes[Math.floor(Math.random() * timeQuotes.length)];
        await sock.updateProfileStatus(`${botName} Online ||\n\n📅 ${getCurrentDateTime()}\n\n➤ ${quote}`);
    } catch (error) { console.error('AutoBio error:', error.message); }
};

// ─────────────────────────────────────────────
//  CHATBOT
// ─────────────────────────────────────────────

const availableApis = [
    `${GiftedTechApi}/api/ai/ai?apikey=${GiftedApiKey}&q=`,
    `${GiftedTechApi}/api/ai/mistral?apikey=${GiftedApiKey}&q=`,
    `${GiftedTechApi}/api/ai/meta-llama?apikey=${GiftedApiKey}&q=`
];

const identityPatterns = [
    /who\s*(made|created|built)\s*you/i,/who\s*is\s*your\s*(creator|developer|maker|owner|father|parent)/i,
    /what('?s| is)\s*your\s*name\??/i,/who\s*are\s*you\??/i,/who\s*a?you\??/i,/who\s*au\??/i,
    /what('?s| is)\s*ur\s*name\??/i,/who\s*u\??/i,/are\s*you\s*gifted/i,/are\s*u\s*gifted/i,
];

function isIdentityQuestion(query) {
    return identityPatterns.some(p => typeof query === 'string' && p.test(query));
}

async function getAIResponse(query) {
    if (isIdentityQuestion(query)) return 'I am an Interactive Ai Assistant Chat Bot, created by Ali tech!';
    try {
        const apiUrl = availableApis[Math.floor(Math.random() * availableApis.length)];
        const response = await fetch(apiUrl + encodeURIComponent(query));
        try {
            const data = await response.json();
            let r = data.result || data.response || data.message || (data.data && (data.data.text || data.data.message)) || JSON.stringify(data);
            return typeof r === 'object' ? JSON.stringify(r) : r;
        } catch { return await response.text(); }
    } catch (error) { return "Sorry, I couldn't get a response right now"; }
}

const processedMessages = new Set();
const userCooldown = new Map();
setInterval(() => {
    const cutoff = Date.now() - 60000;
    for (const [key, time] of userCooldown) { if (time < cutoff) userCooldown.delete(key); }
}, 60000);

function processForTTS(text) {
    if (!text || typeof text !== 'string') return '';
    return text.replace(/[\[\]\(\)\{\}]/g, ' ').replace(/\s+/g, ' ').substring(0, 190);
}

async function ChatBot(sock, chatBot, chatBotMode, googleTTS, msg) {
    try {
        if (chatBot !== "true" && chatBot !== "audio") return;
        if (!msg?.message || msg.key?.fromMe) return;

        const jid = msg.key.remoteJid;
        if (!jid || jid === "status@broadcast" || jid.endsWith("@broadcast")) return;

        const isGroup = jid.endsWith("@g.us");

        if (chatBotMode === "groups" && !isGroup) return;
        if (chatBotMode === "inbox" && isGroup) return;

        const msgId = msg.key.id;
        if (processedMessages.has(msgId)) return;
        processedMessages.add(msgId);
        setTimeout(() => processedMessages.delete(msgId), 60000);

        const sender = msg.key.participant || jid;
        const cooldownKey = `${jid}:${sender}`;
        const now = Date.now();

        if (userCooldown.has(cooldownKey) && now - userCooldown.get(cooldownKey) < 3000) return;
        userCooldown.set(cooldownKey, now);

        const m = msg.message;

        let text =
            m.conversation ||
            m.extendedTextMessage?.text ||
            m.imageMessage?.caption ||
            m.videoMessage?.caption ||
            "";

        if (!text || typeof text !== "string") return;

        text = text.trim();

        if (text.length < 2) return;
        if (text.startsWith(".") || text.startsWith("!")) return;

        if (isGroup) {
            const mentioned =
                m.extendedTextMessage?.contextInfo?.mentionedJid || [];

            const myJid = sock.user.id.split(":")[0] + "@s.whatsapp.net";

            const isMentioned = mentioned.includes(myJid);

            if (!isMentioned) return;

            text = text.replace(/@\d+/g, "").trim();

            if (!text) return;
        }

        let aiResponse;

        try {
            aiResponse = await getAIResponse(text);
        } catch (e) {
            console.error("AI Error:", e);
            return;
        }

        if (!aiResponse || !String(aiResponse).trim()) return;

        if (chatBot === "true") {
            await sock.sendMessage(
                jid,
                { text: String(aiResponse) },
                { quoted: msg }
            );
        }

        if (chatBot === "audio") {
            const ttsText = processForTTS(String(aiResponse));
            if (!ttsText) return;

            const audioUrl = googleTTS.getAudioUrl(ttsText, {
                lang: "en",
                slow: false,
                host: "https://translate.google.com",
            });

            await sock.sendMessage(
                jid,
                {
                    audio: { url: audioUrl },
                    mimetype: "audio/mpeg",
                    ptt: true,
                },
                { quoted: msg }
            );
        }

    } catch (err) {
        console.error("ChatBot:", err);
    }
}

// ─────────────────────────────────────────────
//  PRESENCE
// ─────────────────────────────────────────────

const presenceTimers = new Map();

const Presence = async (sock, jid) => {
    try {
        if (!jid) return;
        const presenceType = ((await getSetting("PRESENCE")) ?? "offline").toLowerCase().trim();

        if (presenceTimers.has(jid)) {
            clearTimeout(presenceTimers.get(jid));
            presenceTimers.delete(jid);
        }

        if (!presenceType || presenceType === "offline") {
            await sock.sendPresenceUpdate("unavailable", jid).catch(() => {});
            return;
        }

        if (presenceType === "online") {
            await sock.sendPresenceUpdate("available", jid).catch(() => {});
            return;
        }

        if (presenceType === "typing") {
            await sock.sendPresenceUpdate("composing", jid).catch(() => {});
            const t = setTimeout(async () => {
                await sock.sendPresenceUpdate("paused", jid).catch(() => {});
                presenceTimers.delete(jid);
            }, 8000);
            presenceTimers.set(jid, t);
            return;
        }

        if (presenceType === "recording") {
            await sock.sendPresenceUpdate("recording", jid).catch(() => {});
            const t = setTimeout(async () => {
                await sock.sendPresenceUpdate("paused", jid).catch(() => {});
                presenceTimers.delete(jid);
            }, 8000);
            presenceTimers.set(jid, t);
            return;
        }
    } catch {}
};

// ─────────────────────────────────────────────
//  ANTI CALL
// ─────────────────────────────────────────────

const Anticall = async (json, sock) => {
    const settings = await getAllSettings();
    const antiCall = settings.ANTICALL || "false";
    const antiCallMsg =
        settings.ANTICALL_MSG ||
        "Calls are not allowed. This bot automatically rejects calls.";

    for (const id of json) {
        if (id.status !== "offer") continue;

        let jid = id.from;

        if (jid.endsWith("@lid")) {
            try {
                const converted = await sock.getJidFromLid(jid);
                if (converted) jid = converted;
            } catch {}
        }

        if (antiCall === "true" || antiCall === "decline") {
            await sock.sendMessage(jid, {
                text: antiCallMsg,
                mentions: [jid],
            });

            await sock.rejectCall(id.id, jid);

        } else if (antiCall === "block") {
            await sock.sendMessage(jid, {
                text: `${antiCallMsg}\nYou are Being Blocked!`,
                mentions: [jid],
            });

            await sock.rejectCall(id.id, jid);
            await sock.updateBlockStatus(jid, "block");
        }
    }
};

// ─────────────────────────────────────────────
//  MEDIA DOWNLOAD HELPER
//  ✅ FIX: 'stream' argument added — required by @whiskeysockets/baileys
// ─────────────────────────────────────────────

const processMediaMessage = async (deletedMessage) => {
    let mediaType, mediaInfo;
    const mediaTypes = {
        imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio',
        stickerMessage: 'sticker', documentMessage: 'document'
    };
    for (const [key, type] of Object.entries(mediaTypes)) {
        if (deletedMessage.message?.[key]) { mediaType = type; mediaInfo = deletedMessage.message[key]; break; }
    }
    if (!mediaType || !mediaInfo) {
        
        return null;
    }
    try {
        console.log(`[processMediaMessage] downloading ${mediaType}...`);
        const mediaStream = await downloadMediaMessage(deletedMessage, 'stream', { logger });
        const extensions = {
            image: 'jpg', video: 'mp4',
            audio: mediaInfo.mimetype?.includes('mpeg') ? 'mp3' : 'ogg',
            sticker: 'webp',
            document: mediaInfo.fileName?.split('.').pop() || 'bin'
        };
        const tempPath = path.join(__dirname, `./temp/temp_${Date.now()}.${extensions[mediaType]}`);
        await fs.ensureDir(path.dirname(tempPath));
        await pipeline(mediaStream, fs.createWriteStream(tempPath));
        
        return {
            path: tempPath, type: mediaType,
            caption: mediaInfo.caption || '', mimetype: mediaInfo.mimetype,
            fileName: mediaInfo.fileName || `${mediaType}_${Date.now()}.${extensions[mediaType]}`,
            ptt: mediaInfo.ptt
        };
    } catch (error) {
        console.error('[processMediaMessage] failed:', error.message);
        return null;
    }
};

// Same as processMediaMessage but works on an already-unwrapped viewOnce
// media object (image/video/audio) instead of a top-level message.
const processViewOnceMedia = async (originalKey, mediaType, mediaContent) => {
    const mediaTypeMap = { imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio' };
    const type = mediaTypeMap[mediaType];
    if (!type) return null;

    try {
        const syntheticMsg = { key: originalKey, message: { [mediaType]: mediaContent } };
        const mediaStream = await downloadMediaMessage(syntheticMsg, 'stream', { logger });
        const extensions = {
            image: 'jpg', video: 'mp4',
            audio: mediaContent.mimetype?.includes('mpeg') ? 'mp3' : 'ogg',
        };
        const tempPath = path.join(__dirname, `./temp/vv2_${Date.now()}.${extensions[type]}`);
        await fs.ensureDir(path.dirname(tempPath));
        await pipeline(mediaStream, fs.createWriteStream(tempPath));
        return {
            path: tempPath, type,
            caption: mediaContent.caption || '', mimetype: mediaContent.mimetype,
            ptt: mediaContent.ptt,
        };
    } catch (error) {
        console.error('[processViewOnceMedia] failed:', error.message);
        return null;
    }
};

// ─────────────────────────────────────────────
//  ANTI DELETE
// ─────────────────────────────────────────────
const AntiDelete = async (sock, deletedMsg, key, deleter, sender, botOwnerJid, deleterPushName, senderPushName) => {
    const settings = await getAllSettings();
    const antiDelete = settings.ANTIDELETE || 'off';
    const timeZone = settings.TIME_ZONE || 'Asia/Karachi';
    const currentTime = formatTime(Date.now(), timeZone);
    const currentDate = formatDate(Date.now(), timeZone);

    const senderInfo = await resolveLidToJidAndDisplay(sock, sender, senderPushName, key.remoteJid);
    const deleterInfo = await resolveLidToJidAndDisplay(sock, deleter, deleterPushName, key.remoteJid);
    const mentions = [senderInfo.jid, deleterInfo.jid].filter(Boolean);

    let chatInfo;
    if (isJidGroup(key.remoteJid)) {
        try { const g = await getGroupMetadata(sock, key.remoteJid); chatInfo = `💬 𝙶𝚁𝙾𝚄𝙿 𝙲𝙷𝙰𝚃: ${g?.subject || 'Unknown'}`; }
        catch { chatInfo = `💬 𝙶𝚁𝙾𝚄𝙿 𝙲𝙷𝙰𝚃`; }
    } else { chatInfo = `💬 𝙳𝙼 𝙲𝙷𝙰𝚃: ${deleterInfo.display}`; }

    const buildTextAlert = () =>
        `*𝙰𝙽𝚃𝙸𝙳𝙴𝙻𝙴𝚃𝙴 𝙼𝙴𝚂𝚂𝙰𝙶𝙴 𝚂𝚈𝚂𝚃𝙴𝙼*\n\n` +
        `*🕑 𝚃𝙸𝙼𝙴:* ${currentTime}\n` +
        `*📆 𝙳𝙰𝚃𝙴:* ${currentDate}\n\n` +
        `*👤 𝚂𝙴𝙽𝚃 𝙱𝚈:* ${senderInfo.display}\n` +
        `*👤 𝙳𝙴𝙻𝙴𝚃𝙴𝙳 𝙱𝚈:* ${deleterInfo.display}\n` +
        `${chatInfo}`;

    const sendToTarget = async (targetJid) => {
        if (!targetJid) return;
        try {
            if (deletedMsg.message?.conversation || deletedMsg.message?.extendedTextMessage?.text) {
                const text = deletedMsg.message.conversation || deletedMsg.message.extendedTextMessage.text;
                await sock.sendMessage(targetJid, {
                    text: `${buildTextAlert()}\n\n*𝙳𝙴𝙻𝙴𝚃𝙴𝙳 𝙼𝚂𝙶:*\n${text}`,
                    mentions
                });
            } else {
                const media = await processMediaMessage(deletedMsg);
                if (media) {
                    const alertText = media.caption
                        ? `${buildTextAlert()}\n\n*𝙲𝙰𝙿𝚃𝙸𝙾𝙽:*\n${media.caption}`
                        : buildTextAlert();
                    if (media.type === 'sticker' || media.type === 'audio') {
                        await sock.sendMessage(targetJid, { text: alertText, mentions });
                        await sock.sendMessage(targetJid, {
                            [media.type]: { url: media.path },
                            ...(media.type === 'audio' ? { ptt: media.ptt, mimetype: media.mimetype } : {})
                        });
                    } else {
                        await sock.sendMessage(targetJid, {
                            [media.type]: { url: media.path },
                            caption: alertText,
                            mentions,
                            ...(media.type === 'document' ? { mimetype: media.mimetype, fileName: media.fileName } : {})
                        });
                    }
                    setTimeout(() => fs.unlink(media.path).catch(() => {}), 30000);
                } else {
                    await sock.sendMessage(targetJid, {
                        text: `${buildTextAlert()}\n\n_(Media could not be recovered)_`,
                        mentions
                    });
                }
            }
        } catch (error) {
            console.error('[AntiDelete] sendToTarget failed:', error.message);
        }
    };

    const targets = resolveAntiTargets(antiDelete, key.remoteJid, botOwnerJid);
    await Promise.all(targets.map(sendToTarget));
};

// ─────────────────────────────────────────────
//  ANTI EDIT
//  Setting: ANTI_EDIT — same modes as AntiDelete
//  (off | on/pm/inbox/indm | inchat | chats/chat | <jid>)
// ─────────────────────────────────────────────

// Call from sock.ev.on('messages.update', ...) — catches native protocolMessage edits
const AntiEditUpdate = async (sock, updates, botOwnerJid) => {
    try {
        const settings = await getAllSettings();
        const mode = settings.ANTI_EDIT || 'off';
        if (mode === 'off' || mode === 'false') return;

        const botNum = getBotSelfNumber(sock);

        for (const update of updates) {
            const { key, update: msgUpdate } = update;
            if (!key || !msgUpdate) continue;
            if (key.fromMe) continue;

            const editorId = extractParticipantId(key.participant || key.participantPn || key.remoteJid);
            if (botNum && editorId?.includes(botNum)) continue;
            if (msgUpdate.messageStubType) continue;

            const isEdit = msgUpdate.message?.editedMessage || msgUpdate.message?.protocolMessage?.editedMessage;
            if (!isEdit) continue;

            const groupJid = key.remoteJid;
            const { origCaption } = await resolveOriginalCaption(groupJid, key.id);
            const editorInfo = await resolveLidToJidAndDisplay(sock, editorId, msgUpdate.pushName, groupJid);
            const mentions = [editorInfo.jid].filter(Boolean);

            let chatInfo;
            if (isJidGroup(groupJid)) {
                try { const g = await getGroupMetadata(sock, groupJid); chatInfo = `💬 𝙶𝚁𝙾𝚄𝙿 𝙲𝙷𝙰𝚃: ${g?.subject || 'Unknown'}`; }
                catch { chatInfo = `💬 𝙶𝚁𝙾𝚄𝙿 𝙲𝙷𝙰𝚃`; }
            } else { chatInfo = `💬 𝙳𝙼 𝙲𝙷𝙰𝚃`; }

            const alertText =
                `*𝙰𝙽𝚃𝙸𝙴𝙳𝙸𝚃 𝙼𝙴𝚂𝚂𝙰𝙶𝙴 𝚂𝚈𝚂𝚃𝙴𝙼*\n\n` +
                `*👤 𝙴𝙳𝙸𝚃𝙴𝙳 𝙱𝚈:* ${editorInfo.display}\n` +
                `${chatInfo}\n\n` +
                `*𝙾𝚁𝙸𝙶𝙸𝙽𝙰𝙻 𝙼𝚂𝙶:*\n${origCaption}`;

            const targets = resolveAntiTargets(mode, groupJid, botOwnerJid);
            await Promise.all(targets.map(t => sock.sendMessage(t, { text: alertText, mentions }).catch(() => {})));
        }
    } catch (err) {
        console.error('[AntiEditUpdate] Error:', err);
    }
};

// Call from sock.ev.on('messages.upsert', ...) — catches secretEncryptedMessage-style edits
const AntiEditUpsert = async (sock, message, botOwnerJid) => {
    try {
        if (!message?.message || message.key.fromMe) return;

        const settings = await getAllSettings();
        const mode = settings.ANTI_EDIT || 'off';
        if (mode === 'off' || mode === 'false') return;

        const botNum = getBotSelfNumber(sock);
        const participantId = extractParticipantId(message.key.participant) || message.key.remoteJid;
        if (botNum && participantId?.includes(botNum)) return;

        let msgObj = message.message;
        if (msgObj?.ephemeralMessage) msgObj = msgObj.ephemeralMessage.message;
        else if (msgObj?.viewOnceMessage) msgObj = msgObj.viewOnceMessage.message;
        else if (msgObj?.viewOnceMessageV2) msgObj = msgObj.viewOnceMessageV2.message;
        else if (msgObj?.documentWithCaptionMessage) msgObj = msgObj.documentWithCaptionMessage.message;

        if (!msgObj?.secretEncryptedMessage) return;

        const secretPayload = msgObj.secretEncryptedMessage;
        const targetKey = secretPayload.targetMessageKey;
        const isEdit = secretPayload.secretEncType === 'MESSAGE_EDIT' || secretPayload.secretEncType === 1 || targetKey;
        if (!isEdit || !targetKey?.id) return;

        const groupJid = message.key.remoteJid;
        const { origCaption, originalMsg } = await resolveOriginalCaption(groupJid, targetKey.id);
        const editorInfo = await resolveLidToJidAndDisplay(sock, participantId, message.pushName, groupJid);
        const mentions = [editorInfo.jid].filter(Boolean);

        let chatInfo;
        if (isJidGroup(groupJid)) {
            try { const g = await getGroupMetadata(sock, groupJid); chatInfo = `💬 𝙶𝚁𝙾𝚄𝙿 𝙲𝙷𝙰𝚃: ${g?.subject || 'Unknown'}`; }
            catch { chatInfo = `💬 𝙶𝚁𝙾𝚄𝙿 𝙲𝙷𝙰𝚃`; }
        } else { chatInfo = `💬 𝙳𝙼 𝙲𝙷𝙰𝚃`; }

        const alertText =
            `*𝙰𝙽𝚃𝙸𝙴𝙳𝙸𝚃 𝙼𝙴𝚂𝚂𝙰𝙶𝙴 𝚂𝚈𝚂𝚃𝙴𝙼*\n\n` +
            `*👤 𝙴𝙳𝙸𝚃𝙴𝙳 𝙱𝚈:* ${editorInfo.display}\n` +
            `${chatInfo}\n\n` +
            `*𝙾𝚁𝙸𝙶𝙸𝙽𝙰𝙻 𝙼𝚂𝙶:*\n${origCaption}`;

        const targets = resolveAntiTargets(mode, groupJid, botOwnerJid);
        await Promise.all(targets.map(t =>
            sock.sendMessage(t, { text: alertText, mentions }, originalMsg ? { quoted: originalMsg } : {}).catch(() => {})
        ));
    } catch (err) {
        console.error('[AntiEditUpsert] Error:', err);
    }
};

// ─────────────────────────────────────────────
//  ANTI VIEWONCE
//  Setting: ANTI_VIEWONCE — same modes as AntiDelete
//  (off | on/pm/inbox/indm | inchat | chats/chat | <jid>)
// ─────────────────────────────────────────────

const AntiViewOnce = async (sock, message, botOwnerJid) => {
    try {
        if (!message) return;

        const botNum = getBotSelfNumber(sock);
        const participantId = extractParticipantId(message.key?.participant) || message.key?.remoteJid;

        if (message.key?.fromMe) return;
        if (botNum && participantId?.includes(botNum)) return;

        if (!message.message) {
         //   console.log(`[AntiViewOnce][RAWDUMP] Empty message.message from ${participantId} — likely session/decrypt failure`, JSON.stringify(message.key));
            return;
        }

        const settings = await getAllSettings();
        const mode = settings.ANTI_VIEWONCE || 'off';
        if (mode === 'off' || mode === 'false') return;

        const groupJid = message.key?.remoteJid || 'unknown';
        const rawMessage = message.message;

        let { msg: realMsg, isViewOnce: hasViewOnceWrapper } = getRealMessage(rawMessage);
        if (!realMsg) return;

        let viewOnceContent, mediaType;
        if (realMsg.imageMessage?.viewOnce || realMsg.videoMessage?.viewOnce || realMsg.audioMessage?.viewOnce) {
            mediaType = Object.keys(realMsg).find((key) => key.endsWith("Message") && ["image", "video", "audio"].some((t) => key.includes(t)));
            viewOnceContent = { [mediaType]: realMsg[mediaType] };
            hasViewOnceWrapper = true;
        } else if (hasViewOnceWrapper) {
            viewOnceContent = realMsg;
            mediaType = Object.keys(viewOnceContent).find((key) => key.endsWith("Message") && ["image", "video", "audio"].some((t) => key.includes(t)));
        }

        if (!mediaType || !viewOnceContent) return;

        const senderInfo = await resolveLidToJidAndDisplay(sock, participantId, message.pushName, groupJid);
        const botName = settings.BOT_NAME || 'GIFTED MD';
        const mediaContent = { ...viewOnceContent[mediaType], viewOnce: false };

        const media = await processViewOnceMedia(message.key, mediaType, mediaContent);
        if (!media) {
            console.error('[AntiViewOnce] media download failed');
            return;
        }

        const originalCaption = mediaContent.caption || '';
        const caption =
            `👁️ *ANTI-VIEWONCE REVEALED*\n\n` +
            `📤 *From:* ${senderInfo.display}\n` +
            `${originalCaption ? `📝 *Caption:* ${originalCaption}\n` : ""}`;

        const mentions = [senderInfo.jid].filter(Boolean);

        const sendToTarget = async (targetJid) => {
            if (!targetJid) return;
            try {
                if (media.type === 'audio') {
                    await sock.sendMessage(targetJid, { text: caption, mentions });
                    await sock.sendMessage(targetJid, { audio: { url: media.path }, mimetype: media.mimetype || 'audio/mp4', ptt: true });
                } else {
                    await sock.sendMessage(targetJid, { [media.type]: { url: media.path }, caption, mimetype: media.mimetype, mentions });
                }
            } catch (e) {
                console.error('[AntiViewOnce] sendToTarget failed:', e.message);
            }
        };

        const targets = resolveAntiTargets(mode, groupJid, botOwnerJid);
        await Promise.all(targets.map(sendToTarget));

        setTimeout(() => fs.unlink(media.path).catch(() => {}), 30000);
    } catch (err) {
        console.error('[AntiViewOnce] Error:', err);
    }
};

// ─────────────────────────────────────────────
//  ANTI STICKER
// ─────────────────────────────────────────────

async function antiSticker(mek, sock) {
    try {
        if (!mek?.message || mek.key.fromMe) return;
        const from = mek.key.remoteJid;
        if (!from.endsWith("@g.us")) return;

        const rawSetting = await getGroupSetting(from, "ANTISTICKER");
        const mode = rawSetting === true || rawSetting === 1 ? "delete"
            : typeof rawSetting === "string" ? rawSetting.toLowerCase() : null;
        if (!mode || mode === "false" || mode === "off") return;

        const msg = mek.message?.stickerMessage
            || mek.message?.ephemeralMessage?.message?.stickerMessage
            || mek.message?.viewOnceMessageV2?.message?.stickerMessage;
        if (!msg) return;

        let sender = mek.key.participant || mek.key.participantPn || mek.participant;
        if (!sender) return;

        if (sender.endsWith("@lid")) {
            const cached = getLidMapping(sender);
            if (cached) { sender = cached; }
            else { try { const r = await sock.getJidFromLid(sender); if (r) sender = r; } catch (e) {} }
        }
        const senderNum = sender.split("@")[0];

        
        const sudoNumbers = await getSudoNumbers() || [];
        const isSuperUser = DEV_NUMBERS.includes(senderNum) || sudoNumbers.includes(senderNum);
        if (isSuperUser) {
            
            return;
        }

        const groupMetadata = await getGroupMetadata(sock, from);
        if (!groupMetadata || !groupMetadata.participants) return;

        const botJid = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
        const botAdmin = groupMetadata.participants.find(p => {
            const pNum = (p.pn || p.phoneNumber || p.id || '').split('@')[0];
            const botNum = botJid.split('@')[0];
            return pNum === botNum && p.admin;
        });
        if (!botAdmin) return;

        const groupAdmins = groupMetadata.participants
            .filter((member) => member.admin)
            .map((admin) => admin.pn || admin.phoneNumber || admin.id);

        const senderNormalized = sender.split('@')[0];
        const isAdmin = groupAdmins.some(admin => {
            const adminNum = (admin || '').split('@')[0];
            return adminNum === senderNormalized || admin === sender;
        });

        if (isAdmin) {
            
            return;
        }

        try { await sock.sendMessage(from, { delete: mek.key }); } catch (e) {
            console.error(`[AntiSticker] delete failed:`, e.message);
        }
        if (mode === "null") return;

        if (mode === "delete") {
            await sock.sendMessage(from, { text: `🚫 *Anti-Sticker*\nStickers are not allowed @${senderNum}!`, mentions: [sender] });
        } else if (mode === "warn") {
            const warnLimit = parseInt(await getGroupSetting(from, "ANTISTICKER_WARN_COUNT")) || _getEnvWarnFallback();
            await WarnSystem(sock, from, sender, 'Sticker', addAntistickerWarning, resetAntistickerWarnings, warnLimit);
        } else if (mode === "kick") {
            try {
                await sock.groupParticipantsUpdate(from, [sender], "remove");
                await sock.sendMessage(from, { text: `🚫 @${senderNum} kicked for sending sticker!`, mentions: [sender] });
            } catch (e) {
                console.error(`[AntiSticker] kick failed:`, e.message);
                await sock.sendMessage(from, { text: `⚠️ Could not kick @${senderNum}!`, mentions: [sender] });
            }
        }
    } catch (err) { console.error("[AntiSticker] unhandled error:", err); }
}

// ─────────────────────────────────────────────
// ANTI NEWSLETTER / CHANNEL
// ─────────────────────────────────────────────
const AntiNewsletter = async (sock, message, getGroupMetadata) => {
    try {
        if (!message?.message || message.key.fromMe) return;
        const from = message.key.remoteJid;
        if (!from?.endsWith("@g.us")) return;

        const modeRaw = await getGroupSetting(from, "ANTINEWSLETTER");
        if (!modeRaw || modeRaw === "off" || modeRaw === "false") return;

        // ---- UPGRADED DETECT NEWSLETTER ----
        const msg = message.message;
        
        // Safely unwrap viewOnce / ephemeral wrappers
        const unwrapped = msg.ephemeralMessage?.message || 
                          msg.viewOnceMessage?.message || 
                          msg.viewOnceMessageV2?.message || 
                          msg;

        // Extract contextInfo reliably across all message types (text, image, video, sticker, etc.)
        let ctx = null;
        for (const key of Object.keys(unwrapped)) {
            if (unwrapped[key]?.contextInfo) {
                ctx = unwrapped[key].contextInfo;
                break;
            }
        }
        if (!ctx) ctx = msg.extendedTextMessage?.contextInfo || {};

        let isNewsletter = false;

        // 1. Direct Newsletter / Channel Forward Check
        if (
            ctx.forwardedNewsletterMessageInfo || 
            ctx.forwardedNewsletterJid ||
            ctx.forwardedNewsletterMessageInfo?.newsletterJid?.endsWith("@newsletter")
        ) {
            isNewsletter = true;
        }

        // 2. Channel Links inside External Ad Reply (e.g. WhatsApp Channel Invites)
        if (ctx.externalAdReply?.sourceUrl?.includes("whatsapp.com/channel")) {
            isNewsletter = true;
        }

        // 3. Raw Text Link Check (whatsapp.com/channel/...)
        const bodyText = unwrapped.conversation || 
                         unwrapped.extendedTextMessage?.text || 
                         unwrapped.imageMessage?.caption || 
                         unwrapped.videoMessage?.caption || "";

        if (bodyText.toLowerCase().includes("whatsapp.com/channel/")) {
            isNewsletter = true;
        }

        // 4. Native Baileys Newsletter Message Type
        if (unwrapped.newsletterMessage || unwrapped.newsletterAdminInviteMessage) {
            isNewsletter = true;
        }

        if (!isNewsletter) return;

        // ---- SENDER & PERMISSION CHECKS ----
        let sender = message.key.participantPn || message.key.participant || message.participant;
        if (!sender) return;

        if (sender.endsWith("@lid")) {
            const cached = typeof getLidMapping === "function" ? getLidMapping(sender) : null;
            if (cached) sender = cached;
            else { 
                try { 
                    const r = await sock.getJidFromLid(sender); 
                    if (r) sender = r; 
                } catch {} 
            }
        }

        const senderNum = sender.split("@")[0].replace(/\D/g, "");
        const sudoNumbers = await getSudoNumbers().catch(() => []);
        
        // Skip Devs & Sudo users
        if ((typeof DEV_NUMBERS !== "undefined" && DEV_NUMBERS.includes(senderNum)) || sudoNumbers.includes(senderNum)) {
            return;
        }

        const meta = await getGroupMetadata(sock, from);
        if (!meta?.participants) return;

        // Check if our Bot is Admin
        const botNum = (sock.user?.id || "").split(":")[0].replace(/\D/g, "");
        const isBotAdmin = meta.participants.some(p => {
            const n = (p.pn || p.id || "").split("@")[0].replace(/\D/g, "");
            return n === botNum && p.admin;
        });
        if (!isBotAdmin) return;

        // Skip Group Admins
        const isAdmin = meta.participants.some(p => {
            if (!p.admin) return false;
            const n = (p.pn || p.id || "").split("@")[0].replace(/\D/g, "");
            return n === senderNum;
        });
        if (isAdmin) return;

        // ---- ACTIONS ----
        const mode = modeRaw.toLowerCase();
        
        // Delete offending message
        try { await sock.sendMessage(from, { delete: message.key }); } catch {}

        if (mode === "null") return;

        if (mode === "delete" || mode === "on") {
            await sock.sendMessage(from, { 
                text: `⚠️ *@${senderNum}* WhatsApp Channel/Newsletter shares are not allowed here!`, 
                mentions: [sender] 
            });
            return;
        }

        if (mode === "kick") {
            try {
                await sock.groupParticipantsUpdate(from, [sender], "remove");
                await sock.sendMessage(from, { 
                    text: `🚫 *@${senderNum}* kicked (Newsletter/Channel sharing detected).`, 
                    mentions: [sender] 
                });
            } catch (err) {
                console.error("[AntiNewsletter Kick Error]", err.message);
            }
            return;
        }

        if (mode === "warn") {
            const limit = parseInt(await getGroupSetting(from, "ANTINEWSLETTER_WARN_COUNT")) || 3;
            if (typeof WarnSystem === "function") {
                await WarnSystem(sock, from, sender, "Newsletter Share", addAntilinkWarning, resetAntilinkWarnings, limit);
            }
        }

    } catch (e) { 
        console.error("[AntiNewsletter Error]", e.message); 
    }
};


// ─────────────────────────────────────────────
// ANTI BOT
// ─────────────────────────────────────────────
// Rate limiting track karne ke liye group scope se bahar rakhein
const userActivityMap = new Map();

const AntiBot = async (sock, message, getGroupMetadata) => {
    try {
        if (!message?.message || message.key.fromMe) return;
        const from = message.key.remoteJid;
        if (!from?.endsWith("@g.us")) return;

        const modeRaw = await getGroupSetting(from, "ANTIBOT");
        if (!modeRaw || modeRaw === "off" || modeRaw === "false") return;

        // ---- 1. ADVANCED BOT DETECTION ----
        const isBotMsg = isBotMessageAdvanced(message);
        if (!isBotMsg) return;

        // ---- 2. SENDER & PERMISSIONS CHECK ----
        let sender = message.key.participantPn || message.key.participant || message.participant;
        if (!sender) return;

        if (sender.endsWith("@lid")) {
            const cached = typeof getLidMapping === "function" ? getLidMapping(sender) : null;
            if (cached) sender = cached;
            else { 
                try { 
                    const r = await sock.getJidFromLid(sender); 
                    if (r) sender = r; 
                } catch {} 
            }
        }

        const senderNum = sender.split("@")[0].replace(/\D/g, "");
        const sudoNumbers = await getSudoNumbers().catch(() => []);
        
        // Skip Devs / Sudo users
        if ((typeof DEV_NUMBERS !== "undefined" && DEV_NUMBERS.includes(senderNum)) || sudoNumbers.includes(senderNum)) {
            return;
        }

        const meta = await getGroupMetadata(sock, from);
        if (!meta?.participants) return;

        // Check if our bot is admin
        const botNum = (sock.user?.id || "").split(":")[0].replace(/\D/g, "");
        const isBotAdmin = meta.participants.some(p => {
            const n = (p.pn || p.id || "").split("@")[0].replace(/\D/g, "");
            return n === botNum && p.admin;
        });
        if (!isBotAdmin) return;

        // Skip Group Admins
        const isSenderAdmin = meta.participants.some(p => {
            if (!p.admin) return false;
            const n = (p.pn || p.id || "").split("@")[0].replace(/\D/g, "");
            return n === senderNum;
        });
        if (isSenderAdmin) return;

        // ---- 3. TAKE ACTION ----
        const mode = modeRaw.toLowerCase();

        // Always delete the bot message
        try { await sock.sendMessage(from, { delete: message.key }); } catch {}

        if (mode === "null") return;

        if (mode === "delete" || mode === "on") {
            await sock.sendMessage(from, {
                text: `🤖 *AntiBot System*\nOther bot detected and message deleted!\nUser: @${senderNum}`,
                mentions: [sender]
            });
            return;
        }

        if (mode === "kick") {
            try {
                await sock.groupParticipantsUpdate(from, [sender], "remove");
                await sock.sendMessage(from, { 
                    text: `🚫 *@${senderNum}* removed from group (Other bot detected).`, 
                    mentions: [sender] 
                });
            } catch (err) {
                console.error("[AntiBot Kick Error]", err.message);
            }
            return;
        }

        if (mode === "warn") {
            const limit = parseInt(await getGroupSetting(from, "ANTIBOT_WARN_COUNT")) || 3;
            if (typeof WarnSystem === "function") {
                await WarnSystem(sock, from, sender, "Other Bot Detected", addAntilinkWarning, resetAntilinkWarnings, limit);
            }
        }

    } catch (e) { 
        console.error("[AntiBot Error]", e.message); 
    }
};

// Helper function
const isBotMessageAdvanced = (message) => {
    const msgObj = message.message;
    const key = message.key;
    const id = key.id || "";

    // Baileys / WebJS / Venom automated message ID patterns
    const isBaileysId = id.startsWith("BAE5") || (id.startsWith("BAE") && id.length === 16);
    const isWebJSId = id.startsWith("3EB0") && (id.length === 12 || id.length === 20);
    
    // Check internal message flags
    const rawString = JSON.stringify(msgObj);
    const hasBotFlag = rawString.includes('"isBot":true') || rawString.includes('"botMessage":true');

    return isBaileysId || isWebJSId || hasBotFlag;
};


// ─────────────────────────────────────────────
// ANTI TAG / ANTI MENTION ALL
// ─────────────────────────────────────────────
const AntiTag = async (sock, message, getGroupMetadata) => {
    try {
        if (!message?.message || message.key.fromMe) return;
        const from = message.key.remoteJid;
        if (!from?.endsWith("@g.us")) return;

        const modeRaw = await getGroupSetting(from, "ANTITAG");
        if (!modeRaw || modeRaw === "off" || modeRaw === "false") return;

        // ---- SAFELY UNWRAP MESSAGE ----
        const msg = message.message;
        const unwrapped = msg.ephemeralMessage?.message || 
                          msg.viewOnceMessage?.message || 
                          msg.viewOnceMessageV2?.message || 
                          msg;

        // Extract Text and Context Info
        const text = unwrapped.conversation || 
                     unwrapped.extendedTextMessage?.text || 
                     unwrapped.imageMessage?.caption || 
                     unwrapped.videoMessage?.caption || "";

        // Extract contextInfo reliably
        let ctx = null;
        for (const key of Object.keys(unwrapped)) {
            if (unwrapped[key]?.contextInfo) {
                ctx = unwrapped[key].contextInfo;
                break;
            }
        }
        if (!ctx) ctx = msg.extendedTextMessage?.contextInfo || {};

        const mentions = ctx.mentionedJid || [];
        const isGroupMention = Boolean(ctx.isGroupMention);

        let isTagSpam = false;

        // 1. WhatsApp Native Tag All Flag Check (Accurate boolean check)
        if (isGroupMention) {
            isTagSpam = true;
        }

        // 2. Text Pattern Matching (@all, @everyone, @members, @group) with Word Boundaries
        if (text && /@\b(all|everyone|members|group)\b/i.test(text)) {
            isTagSpam = true;
        }

        // 3. HideTag / Mass Mention Detection (5 ya us se zyada tags)
        if (mentions && mentions.length >= 5) {
            isTagSpam = true;
        }

        if (!isTagSpam) return;

        // ---- ADMIN CHECK ----
        let sender = message.key.participantPn || message.key.participant || message.participant;
        if (!sender) return;

        if (sender.endsWith("@lid")) {
            const cached = typeof getLidMapping === "function" ? getLidMapping(sender) : null;
            if (cached) sender = cached;
            else { 
                try { 
                    const r = await sock.getJidFromLid(sender); 
                    if (r) sender = r; 
                } catch {} 
            }
        }

        const senderNum = sender.split("@")[0].replace(/\D/g, "");
        const sudoNumbers = await getSudoNumbers().catch(() => []);
        
        // Skip Owners / Devs
        if ((typeof DEV_NUMBERS !== "undefined" && DEV_NUMBERS.includes(senderNum)) || sudoNumbers.includes(senderNum)) {
            return;
        }

        const meta = await getGroupMetadata(sock, from);
        if (!meta?.participants) return;

        // Check if our Bot is Admin
        const botNum = (sock.user?.id || "").split(":")[0].replace(/\D/g, "");
        const isBotAdmin = meta.participants.some(p => {
            const n = (p.pn || p.id || "").split("@")[0].replace(/\D/g, "");
            return n === botNum && p.admin;
        });
        if (!isBotAdmin) return;

        // Skip Group Admins (Allow admins to tag everyone)
        const isAdmin = meta.participants.some(p => {
            if (!p.admin) return false;
            const n = (p.pn || p.id || "").split("@")[0].replace(/\D/g, "");
            return n === senderNum;
        });
        if (isAdmin) return;

        // ---- ACTION ----
        const mode = modeRaw.toLowerCase();
        
        // Delete offending message
        try { await sock.sendMessage(from, { delete: message.key }); } catch {}

        if (mode === "null") return;

        if (mode === "delete" || mode === "on") {
            await sock.sendMessage(from, {
                text: `🚫 *AntiTag:* TagAll/HideTag not allowed!\n@${senderNum} please don't tag everyone.`,
                mentions: [sender]
            });
            return;
        }

        if (mode === "kick") {
            try {
                await sock.groupParticipantsUpdate(from, [sender], "remove");
                await sock.sendMessage(from, { 
                    text: `🚫 @${senderNum} kicked (tagall spam)`, 
                    mentions: [sender] 
                });
            } catch (err) {
                console.error("[AntiTag Kick Error]", err.message);
            }
            return;
        }

        if (mode === "warn") {
            const limit = parseInt(await getGroupSetting(from, "ANTITAG_WARN_COUNT")) || 3;
            if (typeof WarnSystem === "function") {
                await WarnSystem(sock, from, sender, "TagAll/HideTag", addAntilinkWarning, resetAntilinkWarnings, limit);
            }
        }

    } catch (e) { 
        console.error("[AntiTag Error]", e.message); 
    }
};

// ─────────────────────────────────────────────
//  ANTI SPAM / ANTI FLOOD
// ─────────────────────────────────────────────
const _floodTracker = new Map(); // key: `${from}:${sender}` -> [timestamps]

setInterval(() => {
    const cutoff = Date.now() - 60000;
    for (const [key, arr] of _floodTracker) {
        const filtered = arr.filter(t => t > cutoff);
        if (filtered.length === 0) _floodTracker.delete(key);
        else _floodTracker.set(key, filtered);
    }
}, 30000);

const AntiSpam = async (sock, message, getGroupMetadata) => {
    try {
        if (!message?.message || message.key.fromMe) return;
        const from = message.key.remoteJid;
        if (!from?.endsWith("@g.us")) return;

        const modeRaw = await getGroupSetting(from, "ANTIFLOOD");
        if (!modeRaw || modeRaw === "off" || modeRaw === "false") return;

        let sender = message.key.participantPn || message.key.participant || message.participant;
        if (!sender) return;

        if (sender.endsWith("@lid")) {
            const cached = getLidMapping(sender);
            if (cached) sender = cached;
            else { try { const r = await sock.getJidFromLid(sender); if (r) sender = r; } catch {} }
        }
        const senderNum = sender.split("@")[0].replace(/\D/g, "");

        const sudoNumbers = await getSudoNumbers().catch(() => []);
        if (DEV_NUMBERS.includes(senderNum) || sudoNumbers.includes(senderNum)) return;

        const meta = await getGroupMetadata(sock, from);
        if (!meta?.participants) return;

        const botNum = (sock.user?.id || "").split(":")[0].replace(/\D/g, "");
        const isBotAdmin = meta.participants.some(p => {
            const n = (p.pn || p.id || "").split("@")[0].replace(/\D/g, "");
            return n === botNum && p.admin;
        });
        if (!isBotAdmin) return;

        const isAdmin = meta.participants.some(p => {
            if (!p.admin) return false;
            const n = (p.pn || p.id || "").split("@")[0].replace(/\D/g, "");
            return n === senderNum;
        });
        if (isAdmin) {
            const adminMode = await getGroupSetting(from, "ANTIFLOOD_ADMIN");
            if (!adminMode || adminMode === "off" || adminMode === "false") return;
        }

        const limit = parseInt(await getGroupSetting(from, "ANTIFLOOD_LIMIT")) || 5;
        const windowMs = (parseInt(await getGroupSetting(from, "ANTIFLOOD_WINDOW")) || 5) * 1000;

        const key = `${from}:${sender}`;
        const now = Date.now();
        const timestamps = (_floodTracker.get(key) || []).filter(t => now - t < windowMs);
        timestamps.push(now);
        _floodTracker.set(key, timestamps);

        if (timestamps.length <= limit) return;

        const mode = modeRaw.toLowerCase();
        _floodTracker.delete(key);

        try { await sock.sendMessage(from, { delete: message.key }); } catch (e) {
            console.error("[AntiSpam] delete failed:", e.message);
        }

        if (mode === "null") return;

        if (mode === "delete" || mode === "on" || mode === "true" || mode === "1") {
            await sock.sendMessage(from, {
                text: `⚠️ *Anti-Flood*\n@${senderNum}, please don't spam the group!`,
                mentions: [sender]
            }).catch(() => {});
            return;
        }

        if (mode === "warn") {
            const warnLimit = parseInt(await getGroupSetting(from, "ANTIFLOOD_WARN_COUNT")) || _getEnvWarnFallback();
            await WarnSystem(sock, from, sender, "Flooding/Spam", addAntilinkWarning, resetAntilinkWarnings, warnLimit);
            return;
        }

        if (mode === "kick") {
            try {
                await sock.groupParticipantsUpdate(from, [sender], "remove");
                await sock.sendMessage(from, {
                    text: `🚫 @${senderNum} kicked for flooding the group!`,
                    mentions: [sender]
                });
            } catch (e) {
                console.error("[AntiSpam] kick failed:", e.message);
                await sock.sendMessage(from, {
                    text: `⚠️ Flood detected from @${senderNum}! Could not remove user.`,
                    mentions: [sender]
                }).catch(() => {});
            }
        }
    } catch (e) {
        console.error("[AntiSpam] Error:", e.message);
    }
};

// ─────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────

module.exports = {
    logger,
    emojis,
    AutoReact,
    GiftedTechApi,
    GiftedApiKey,
    AntiLink,
    Antibad,
    AntiGroupMention,
    AntiGroupStatus,
    AutoBio,
    AntiSpam,
    AntiBot,
    AntiNewsletter,
    ChatBot,
    AntiDelete,
    AntiTag,
    AntiEditUpdate,
    AntiEditUpsert,
    AntiViewOnce,
    Anticall,
    Presence,
    antiSticker,
    WarnSystem,
    resolveAntiTargets,
    resolveLidToJidAndDisplay,
};
