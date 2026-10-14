const lib = require("../lib");
const { cmd } = lib;
const axios = require("axios");
const crypto = require("crypto");

// Prefer the bot's own downloader (knows the socket store), fall back to baileys
let downloadMediaMessage = lib.downloadMediaMessage;
if (typeof downloadMediaMessage !== "function") {
  downloadMediaMessage = require("@whiskeysockets/baileys").downloadMediaMessage;
}

const aesEncrypt = (data, key, iv) => {
  const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(key, "utf8"), Buffer.from(iv, "utf8"));
  let encrypted = cipher.update(data, "utf8", "base64");
  encrypted += cipher.final("base64");
  return encrypted;
};

const genRandom = (len) => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  const randomBytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) result += chars[randomBytes[i] % chars.length];
  return result;
};

const publicKey = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDa2oPxMZe71V4dw2r8rHWt59gH
W5INRmlhepe6GUanrHykqKdlIB4kcJiu8dHC/FJeppOXVoKz82pvwZCmSUrF/1yr
rnmUDjqUefDu8myjhcbio6CnG5TtQfwN2pz3g6yHkLgp8cFfyPSWwyOCMMMsTU9s
snOjvdDb4wiZI8x3UwIDAQAB
-----END PUBLIC KEY-----`;

const getBrowserHeaders = () => ({
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  pragma: "no-cache",
  "sec-ch-ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-site",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  origin: "https://deepfakemaker.io",
  referer: "https://deepfakemaker.io/ai-clothes-remover/",
});

const VALID_PROMPTS = ["nude", "bikini", "topless", "underwear", "naked", "swimsuit", "lingerie"];
const PROMPT_EMOJIS = { nude: "🔞", bikini: "👙", topless: "🔥", underwear: "🩲", naked: "🍑", swimsuit: "🏊", lingerie: "💋" };
const STATUS = ["🎨 working on it...", "⚙️ processing...", "🌀 almost there..."];

cmd(
  {
    pattern: "undress",
    aliases: ["undressai", "clothesremover", "remclothes"],
    react: "⏳",
    category: "owner",
    description: "AI clothes remover (reply to an image). Owner only.",
  },
  async (from, sock, conText) => {
    const { reply, quoted, isSuperUser, q, msg, m } = conText;
    const currentMsg = msg || m;

    console.log("UD: start", { from, hasMsg: !!currentMsg, hasQuoted: !!quoted, q });

    if (!isSuperUser) return reply("❌ This command is only available for the owner!");

    const contextInfo =
      currentMsg?.message?.extendedTextMessage?.contextInfo ||
      currentMsg?.message?.imageMessage?.contextInfo ||
      currentMsg?.message?.videoMessage?.contextInfo ||
      currentMsg?.message?.documentMessage?.contextInfo ||
      {};

    // Try every shape of the quoted message the fork may give us
    let quotedContent = null;
    if (quoted?.message) quotedContent = quoted.message;
    else if (quoted?.imageMessage) quotedContent = quoted;
    else if (contextInfo.quotedMessage) quotedContent = contextInfo.quotedMessage;

    if (!quotedContent?.imageMessage) {
      return reply("📷 Reply to an image with `.undress`");
    }

    // Build the quoted message key properly
    const quotedKey = {
      remoteJid: from,
      id: quoted?.key?.id || contextInfo.stanzaId || currentMsg?.key?.id,
      fromMe: quoted?.key?.fromMe ?? false,
      participant: quoted?.key?.participant || contextInfo.participant || undefined,
    };

    console.log("UD: quotedKey", quotedKey);

    try {
      if (currentMsg?.key) {
        await sock.sendMessage(from, { react: { text: "⏳", key: currentMsg.key } });
      }

      const initialMsg = await sock.sendMessage(
        from,
        { text: "🔄 *Processing your image...*\n_Uploading & analyzing..._" },
        { quoted: currentMsg }
      );

      // ── 1. Download the quoted image (with timeout) ────────────────
      console.log("UD: downloading image…");
      const mediaMessage = { key: quotedKey, message: quotedContent };

      const buffer = await Promise.race([
        downloadMediaMessage(mediaMessage, "buffer", {}, {
          logger: console,
          reuploadRequest: sock.updateMediaMessage,
        }),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("downloadMediaMessage timeout (30s)")), 30000)
        ),
      ]);

      if (!buffer || buffer.length < 100) {
        throw new Error("Failed to download image (empty buffer)");
      }
      console.log("UD: downloaded bytes =", buffer.length);

      // ── 2. Prompts ─────────────────────────────────────────────────
      let prompt = (q || "nude").toLowerCase().trim();
      if (!VALID_PROMPTS.includes(prompt)) prompt = "nude";
      const promptEmoji = PROMPT_EMOJIS[prompt] || "🎨";

      // ── 3. Crypto ──────────────────────────────────────────────────
      const t = Math.floor(Date.now() / 1000).toString();
      const nonce = crypto.randomUUID();
      const tempAesKey = genRandom(16);
      if (!tempAesKey || tempAesKey.length !== 16) throw new Error("Failed to generate AES key");

      const secret_key = crypto
        .publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(tempAesKey, "utf8"))
        .toString("base64");

      const userId = genRandom(64).toLowerCase();
      const signData = `ai_df:NHGNy5YFz7HeFb:${t}:${nonce}:${secret_key}`;
      const sign = aesEncrypt(signData, tempAesKey, tempAesKey);

      const instance = axios.create({
        baseURL: "https://apiv1.deepfakemaker.io/api",
        params: { app_id: "ai_df", t, nonce, secret_key, sign },
        headers: getBrowserHeaders(),
        timeout: 30000,
      });

      // ── 4. Get signed upload URL ───────────────────────────────────
      console.log("UD: requesting upload-sign…");
      const hash = crypto.createHash("sha256").update(buffer).digest("hex");
      const filename = genRandom(32) + "_" + Date.now() + ".jpg";
      const uploadResponse = await instance.post("/user/v2/upload-sign", {
        filename, hash, user_id: userId,
      });
      const uploadUrl = uploadResponse?.data?.data?.url;
      const objectName = uploadResponse?.data?.data?.object_name;
      if (!uploadUrl) throw new Error("Upload URL failed: " + JSON.stringify(uploadResponse?.data));
      console.log("UD: upload-sign ok", { objectName });

      // ── 5. PUT the image to that URL ───────────────────────────────
      console.log("UD: uploading image…");
      await axios.put(uploadUrl, buffer, {
        headers: { "content-type": "image/jpeg", "content-length": buffer.length.toString() },
        timeout: 30000,
      });
      console.log("UD: image uploaded");

      // ── 6. Create the task ─────────────────────────────────────────
      console.log("UD: creating task…");
      const taskResponse = await instance.post("/img/v2/free/clothes/remover/task", {
        prompt,
        image: "https://cdn.deepfakemaker.io/" + objectName,
        platform: "clothes_remover",
        user_id: userId,
      });
      const taskId = taskResponse?.data?.data?.task_id;
      if (!taskId) throw new Error("Task creation failed: " + JSON.stringify(taskResponse?.data));
      console.log("UD: task created", taskId);

      await sock.sendMessage(from, {
        text: `✅ *Task ready!*\n${promptEmoji} Style: ${prompt}\n🆔 ID: \`${taskId.slice(0, 8)}\`\n_✨ started the task ..._`,
        edit: initialMsg.key,
      });

      // ── 7. Poll ────────────────────────────────────────────────────
      let resultUrl = null;
      for (let i = 1; i <= 40; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        console.log("UD: poll attempt", i);

        const check = await instance.get("/img/v2/free/clothes/remover/task", {
          params: { user_id: userId, task_id: taskId },
        });

        const status = check?.data?.msg;
        const url = check?.data?.data?.generate_url || check?.data?.data?.image_url;

        if (status === "success" && url) { resultUrl = url; break; }
        if (check?.data?.data?.status === "failed") throw new Error("Task failed on server");

        if (i % 5 === 0) {
          const statusMsg = STATUS[i % STATUS.length];
          try { await sock.sendMessage(from, { edit: initialMsg.key, text: statusMsg }); } catch (_) {}
        }
      }

      if (!resultUrl) throw new Error("⏰ Timeout — result not ready after 100s");
      console.log("UD: got result url", resultUrl);

      // ── 8. Send the result ─────────────────────────────────────────
      await sock.sendMessage(from, {
        image: { url: resultUrl },
        caption: `🖼️ *Done!* ${promptEmoji} ${prompt}\n_Powered by PRIME-MD_`,
      }, { quoted: currentMsg });

      await sock.sendMessage(from, { react: { text: "✅", key: currentMsg.key } });
      try { await sock.sendMessage(from, { edit: initialMsg.key, text: `✅ Done! ${promptEmoji}` }); } catch (_) {}
    } catch (err) {
      console.error("UD ERROR:", err?.response?.data || err.message || err);
      try { await sock.sendMessage(from, { react: { text: "❌", key: currentMsg.key } }); } catch (_) {}
      await reply(`❌ *Error:* ${err.message}`);
    }
  }
);
