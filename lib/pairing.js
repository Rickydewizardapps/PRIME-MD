const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const zlib = require('zlib');
const crypto = require('crypto');
const QRCode = require('qrcode');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
} = require('@whiskeysockets/baileys');

const router = express.Router();
const TEMP_ROOT = path.join(__dirname, 'pair_temp');
if (!fs.existsSync(TEMP_ROOT)) fs.mkdirSync(TEMP_ROOT, { recursive: true });

// pairId -> { status, qr, code, sessionId, error, sock, ttlTimer }
const sessions = new Map();

// ── Access gate ──────────────────────────────────────────
// Set PAIR_SECRET in your .env. Without it, this route is left
// open to anyone who finds the URL, which lets strangers hijack
// your bot by pairing their own WhatsApp account through it —
// or worse, spam pairing-code requests at other people's numbers
// (see rate limiter below). Strongly recommended on any public VPS.
const PAIR_SECRET = process.env.PAIR_SECRET || '';

if (!PAIR_SECRET) {
    console.warn(
        '[⚠️  PRIME-MD] PAIR_SECRET is not set. The /pair page and API are ' +
        'wide open to anyone who finds the URL. Set PAIR_SECRET in your .env ' +
        'before exposing this on a public VPS.'
    );
}

function requireSecret(req, res, next) {
    if (!PAIR_SECRET) return next();
    const provided = req.query.key || req.headers['x-pair-key'];
    if (provided !== PAIR_SECRET) {
        return res.status(403).json({ error: 'Invalid or missing access key.' });
    }
    next();
}

// ── Per-IP rate limit (no extra dependency) ──────────────
// Caps how many pairing attempts one IP can start in a window. This is the
// main defense against the phone-code method being used to spam random
// WhatsApp numbers with unsolicited pairing-code notifications.
// If you're behind nginx/Caddy, make sure `app.set('trust proxy', 1)` is set
// on your main Express app, or req.ip will just see the proxy's address.
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX = 5;                     // attempts per window per IP
const rateLog = new Map(); // ip -> [timestamps]

function rateLimited(req, res, next) {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    const hits = (rateLog.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (hits.length >= RATE_LIMIT_MAX) {
        return res.status(429).json({ error: 'Too many pairing attempts. Please wait a while and try again.' });
    }
    hits.push(now);
    rateLog.set(ip, hits);
    next();
}

// Caps total concurrent pairing sessions so a burst of requests can't spin
// up unlimited baileys sockets on the VPS at once.
const MAX_CONCURRENT_SESSIONS = 10;
const SESSION_TTL_MS = 3 * 60 * 1000; // force-cleanup abandoned sessions after 3 min

function cleanupSession(pairId, delay = 5000) {
    setTimeout(() => {
        const s = sessions.get(pairId);
        if (s) {
            clearTimeout(s.ttlTimer);
            try { s.sock?.end?.(); } catch (_) {}
            try { s.sock?.ws?.close?.(); } catch (_) {}
            sessions.delete(pairId);
        }
        const dir = path.join(TEMP_ROOT, pairId);
        fs.rm(dir, { recursive: true, force: true }, () => {});
    }, delay);
}

// Waits for creds.json to appear and stop changing size before reading it,
// instead of guessing with a fixed sleep. Bounded so it can never hang.
async function waitForStableCreds(credsPath, { maxWaitMs = 8000, quietMs = 700, pollMs = 200 } = {}) {
    const start = Date.now();
    let lastSize = -1;
    let stableSince = null;

    while (Date.now() - start < maxWaitMs) {
        try {
            const { size } = await fsp.stat(credsPath);
            if (size === lastSize) {
                if (!stableSince) stableSince = Date.now();
                if (Date.now() - stableSince >= quietMs) return true;
            } else {
                lastSize = size;
                stableSince = null;
            }
        } catch (_) {
            // file not written yet — keep waiting
        }
        await new Promise((r) => setTimeout(r, pollMs));
    }
    return fs.existsSync(credsPath);
}

async function startPairSession(pairId, method, phoneNumber) {
    const authFolder = path.join(TEMP_ROOT, pairId);
    fs.mkdirSync(authFolder, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const sock = makeWASocket({ auth: state, printQRInTerminal: false });

    const session = { status: 'connecting', qr: null, code: null, sessionId: null, error: null, sock, ttlTimer: null };
    sessions.set(pairId, session);

    // Safety net: force-clean any session that never finishes (QR never
    // scanned, code never entered) so it doesn't leak a socket + folder.
    session.ttlTimer = setTimeout(() => {
        const s = sessions.get(pairId);
        if (s && s.status !== 'connected') {
            s.status = 'error';
            s.error = 'Pairing session timed out. Please try again.';
            cleanupSession(pairId, 500);
        }
    }, SESSION_TTL_MS);

    sock.ev.on('creds.update', saveCreds);

    if (method === 'code' && !sock.authState.creds.registered) {
        try {
            const code = await sock.requestPairingCode(phoneNumber);
            session.code = code;
            session.status = 'waiting_code';
        } catch (err) {
            console.error(`[Pair ${pairId}] pairing code request failed:`, err);
            session.status = 'error';
            session.error = 'Could not request a pairing code. Check the number and try again.';
            cleanupSession(pairId, 500);
            return;
        }
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr && method === 'qr') {
            try {
                session.qr = await QRCode.toDataURL(qr);
                session.status = 'waiting_qr';
            } catch (err) {
                console.error(`[Pair ${pairId}] QR encode failed:`, err);
            }
        }

        if (connection === 'open') {
            session.status = 'finalizing';
            try {
                const credsPath = path.join(authFolder, 'creds.json');
                await waitForStableCreds(credsPath);
                const credsData = await fsp.readFile(credsPath);
                const compressed = zlib.gzipSync(credsData);
                session.sessionId = `PRIME-MD~${compressed.toString('base64')}`;
                session.status = 'connected';
                clearTimeout(session.ttlTimer);
                cleanupSession(pairId, 60000);
            } catch (err) {
                console.error(`[Pair ${pairId}] finalize failed:`, err);
                session.status = 'error';
                session.error = 'Paired, but could not read the session file.';
                cleanupSession(pairId, 500);
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.error(`[Pair ${pairId}] connection closed:`, lastDisconnect?.error?.message || statusCode);
            if (statusCode === DisconnectReason.loggedOut) {
                session.status = 'error';
                session.error = 'Session was logged out. Please try pairing again.';
                cleanupSession(pairId, 500);
            } else if (session.status !== 'connected' && session.status !== 'finalizing') {
                session.status = 'error';
                session.error = 'Connection lost before pairing finished. Please try again.';
                cleanupSession(pairId, 500);
            }
        }
    });
}

router.get('/pair', requireSecret, (req, res) => {
    res.sendFile(path.join(__dirname, 'pair.html'));
});

router.post('/pair/start', requireSecret, rateLimited, express.json(), async (req, res) => {
    const { method, phone } = req.body || {};

    if (!['qr', 'code'].includes(method)) {
        return res.status(400).json({ error: 'method must be "qr" or "code"' });
    }
    if (method === 'code' && (!phone || !/^\d{8,15}$/.test(phone))) {
        return res.status(400).json({ error: 'Enter a valid phone number with country code, digits only.' });
    }
    if (sessions.size >= MAX_CONCURRENT_SESSIONS) {
        return res.status(503).json({ error: 'Server is busy with other pairing requests. Please try again shortly.' });
    }

    const pairId = crypto.randomBytes(8).toString('hex');

    startPairSession(pairId, method, phone).catch((err) => {
        console.error(`[Pair ${pairId}] session start failed:`, err);
        const s = sessions.get(pairId);
        if (s) {
            s.status = 'error';
            s.error = 'Could not start pairing. Please try again.';
            cleanupSession(pairId, 500);
        } else {
            fs.rm(path.join(TEMP_ROOT, pairId), { recursive: true, force: true }, () => {});
        }
    });

    res.json({ pairId });
});

router.get('/pair/status/:pairId', requireSecret, (req, res) => {
    const session = sessions.get(req.params.pairId);
    if (!session) return res.status(404).json({ status: 'not_found' });

    res.json({
        status: session.status,
        qr: session.qr || null,
        code: session.code || null,
        sessionId: session.sessionId || null,
        error: session.error || null,
    });
});

module.exports = router;
