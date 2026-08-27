const { cmd, commands, getSetting } = require("../lib");
const FormData = require("form-data");
const { Blob } = require("buffer");
const axios = require("axios");
const fs = require("fs").promises;
const fsA = require("node:fs");
const { S_WHATSAPP_NET } = require("@whiskeysockets/baileys");
const { Jimp } = require("jimp");
const path = require("path");
const moment = require("moment-timezone");
const {
  groupCache,
  getGroupMetadata,
  cachedGroupMetadata,
} = require("../lib/connection/groupCache");

const { exec: _shellExec } = require("child_process");

const {
  generateWAMessageFromContent,
  proto,
  downloadContentFromMessage,
} = require("@whiskeysockets/baileys");
const util = require("util");

// ─────────────────────────────────────────────
//  EVAL  >
// ─────────────────────────────────────────────

cmd({
    pattern: ">",
    on: "body",
    react: "⚡",
    category: "owner",
    dontAddCommandList: true,
    description: "Eval JS: > code | reply text | reply .js doc",
}, async (from, sock, conText) => {
    const { mek, reply, react, isSuperUser, body } = conText;

    if (!isSuperUser) return;
    if (!body.startsWith(">") && !body.startsWith("$") && !body.startsWith("=>")) return;

    let code = body.slice(1).trim();

    // ── Read code from quoted message if body is empty ──
    if (!code && mek.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
        const quoted = mek.message.extendedTextMessage.contextInfo.quotedMessage;

        // Case A: .js document
        if (quoted.documentMessage?.mimetype === "application/javascript") {
            await react("📂");
            try {
                const stream = await downloadContentFromMessage(quoted.documentMessage, "document");
                let buffer = Buffer.from([]);
                for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                code = buffer.toString("utf8");
                console.log("[Eval] loaded code from .js document, length:", code.length);
            } catch (e) {
                return reply("🙅‍♂️ Failed to read .js file: " + e.message);
            }
        }
        // Case B: text message
        else {
            code = quoted.conversation || quoted.extendedTextMessage?.text || "";
        }
    }

    if (!code) return reply("Usage: > <js expression>");

    await react("⏳");
    try {
        const gift = require("../lib");
        const _rawDb = require("../lib/database/database").DATABASE;
        const settings = await gift.getAllSettings();
        const { getSetting, setSetting, getAllSettings, commands } = gift;
        const prefix = settings.PREFIX;
        const botPrefix = settings.PREFIX;

        const db = new Proxy({ raw: _rawDb }, {
            get(target, key) {
                if (key === "raw") return _rawDb;
                if (key === "toJSON") return () => settings;
                if (key === "toString") return () => JSON.stringify(settings, null, 2);
                const upper = String(key).toUpperCase();
                if (upper in settings) return settings[upper];
                return target[key];
            },
        });

        const bot = sock;
        const conn = sock;
        const client = sock;
        const m = mek;

        // For crm paste
        const { generateWAMessageFromContent, proto } = require("@whiskeysockets/baileys");

        const {
            sender, isGroup, groupInfo, groupName, participants,
            isSuperAdmin, isAdmin, isBotAdmin, superUser,
            botName, ownerNumber, ownerName,
        } = conText;

        let result;
        try {
            // Pehle expression try karo
            result = await eval(`(async () => { return (${code}) })()`);
        } catch (e1) {
            // Agar fail ho to full code block
            result = await eval(`(async () => { ${code} })()`);
        }

        if (result === undefined) result = "(undefined)";

        let output;
        if (typeof result === "object" && result !== null) {
            try {
                output = util.inspect(result, { depth: 2, maxArrayLength: 50 });
            } catch (_) {
                output = String(result);
            }
        } else {
            output = String(result);
        }

        if (output.length > 4000) output = output.slice(0, 4000) + "\n\n...truncated";
        await react("✅");
        await reply(`${output}`);
        
    } catch (err) {
        await react("🙅‍♂️");
        await reply(`🙅‍♂️ Error:\n\`\`${err.message}\`\`\``);
    }
});



cmd(
  {
    pattern: "rmbg",
    category: "owner",
    react: "🧠",
    description: "Remove background from an image (reply to image)",
  },
  async (from, sock, conText) => {
    const { reply, mek, react, sender, botName, newsletterJid } = conText;

    try {
      const msg = mek;

      // Get quoted message
      const quoted =
        msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage;

      if (!quoted) {
        return reply("🙅‍♂️ Please reply to an image");
      }

      // Extract image message
      const imageMsg = quoted.imageMessage || quoted.documentMessage;

      if (!imageMsg) {
        return reply("🙅‍♂️ Reply to a valid image");
      }

      await react("⏳");

      // Download buffer
      const stream = await downloadContentFromMessage(imageMsg, "image");

      let buffer = Buffer.from([]);
      for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
      }

      // Convert Buffer → Blob (IMPORTANT FIX)
      const blob = new Blob([buffer], { type: "image/png" });

      // Prepare FormData
const form = new FormData();

form.append("image_file", buffer, {
  filename: "image.png",
  contentType: "image/png",
});

      // API KEY
      const API_KEY = process.env.REMOVE_BG_API || "SbjibtuwvtFPyf9Vvv1bUog9";

      // Call remove.bg API
      const res = await axios.post(
        "https://api.remove.bg/v1.0/removebg",
        form,
        {
          headers: {
            ...form.getHeaders(),
            "X-Api-Key": API_KEY,
          },
          responseType: "arraybuffer",
        }
      );

      const outputBuffer = Buffer.from(res.data, "binary");

      

      // Send result
      await sock.sendMessage(from, {
        image: outputBuffer,
        caption: "✅ Background removed",
        contextInfo: {
                        forwardingScore: 1,
                        isForwarded: false,
                        forwardedNewsletterMessageInfo: {
                            newsletterJid: newsletterJid,
                            newsletterName: botName,
                            serverMessageId: 143,
                        },
                    },
      });

    } catch (err) {
      console.error(err);
      await react("🙅‍♂️");
      reply("🙅‍♂️ Failed to remove background");
    }
  }
);

cmd(
  {
    pattern: "wasted",
    category: "owner",
    react: "💀",
    description: "Make someone look WASTED 💀",
  },
  async (from, sock, conText) => {
    const { reply, mek, react, sender, botName, newsletterJid } = conText;

    try {
      const msg = mek;

      let userToWaste;

      // ✅ Mention
      const mentioned =
        msg?.message?.extendedTextMessage?.contextInfo?.mentionedJid;

      if (mentioned && mentioned.length > 0) {
        userToWaste = mentioned[0];
      }

      // ✅ Reply
      else {
        const quoted =
          msg?.message?.extendedTextMessage?.contextInfo?.participant;

        if (quoted) {
          userToWaste = quoted;
        }
      }

      if (!userToWaste) {
        return reply("⚠️ Mention or reply to a user to use .wasted");
      }

      await react("⏳");

      // Get profile picture
      let profilePic;
      try {
        profilePic = await sock.profilePictureUrl(userToWaste, "image");
      } catch {
        profilePic = "https://i.imgur.com/9aciic.jpeg";
      }

      // Call API
      const res = await axios.get(
        `https://some-random-api.com/canvas/overlay/wasted?avatar=${encodeURIComponent(profilePic)}`,
        { responseType: "arraybuffer" }
      );

      await react("💀");

      await sock.sendMessage(from, {
        image: Buffer.from(res.data),
        caption: `⚰️ *Wasted* : @${userToWaste.split("@")[0]} 💀\nRest in pieces!`,
        mentions: [userToWaste],
        contextInfo: {
                        forwardingScore: 1,
                        isForwarded: false,
                        forwardedNewsletterMessageInfo: {
                            newsletterJid: newsletterJid,
                            newsletterName: botName,
                            serverMessageId: 143,
                        },
                    },
      });

    } catch (err) {
      console.error(err);
      await react("🙅‍♂️");
      reply("🙅‍♂️ Failed to generate wasted image");
    }
  }
);

// ================== NEWSLETTER COMMAND (PRO + BUTTONS) ==================

cmd(
  {
    pattern: "pair",
    on: "text",
    react: "🔗",
    category: "owner",
    description: "Generate WhatsApp pairing code",
  },
  async (from, sock, conText) => {
    const { body, reply, react, botName, botFooter } = conText;

    const number = body.split(" ")[1];

    if (!number) {
      return reply("Example:\n.pair 923XXXXXXXXX");
    }

    const cleanNumber = number.replace(/[^0-9]/g, "");

    if (cleanNumber.length < 10) {
      return reply("🙅‍♂️ Invalid number");
    }

    await react("⏳");

    try {
      const url = `https://stark-pair-nine.vercel.app/code?number=${cleanNumber}`;

      const { data } = await axios.get(url, {
        timeout: 60000,
      });

      if (!data || !data.code) {
        await react("🙅‍♂️");
        return reply("🙅‍♂️ No pairing code returned");
      }

      const code = data.code;

      let msg = `──────────────✧
*ね Number:* ${cleanNumber}
*ね Pair Code:* ${code}
*ね Status:* Active`;

      await sendButtons(sock, from, {
        title: "*– ( PAIR GENERATED )*",
        text: msg,
        footer: botFooter || botName || "Bot",

        buttons: [
          {
            name: "cta_copy",
            buttonParamsJson: JSON.stringify({
              display_text: "📋 Copy Code",
              copy_code: code,
            }),
          },          
          {
            name: "cta_url",
            buttonParamsJson: JSON.stringify({
              display_text: "🌐 Open Website",
              url: "https://stark-pair-nine.vercel.app",
            }),
          },
        ],
      });

    } catch (err) {
      console.error(err);

      await react("🙅‍♂️");

      return reply("🙅‍♂️ Error generating pairing code");
    }
  }
);
