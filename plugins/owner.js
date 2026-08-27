const { cmd, commands } = require("../lib");
const fs = require("fs").promises;
const { S_WHATSAPP_NET, isJidGroup } = require("@whiskeysockets/baileys");
const { Jimp } = require("jimp");
const moment = require("moment-timezone");
const { sendButtons } = require('gifted-btns');
const { downloadMediaMessage, convertLidToJid } = require("../lib/connection/serializer");
    
cmd(
  {
    pattern: "owner",
    react: "👑",
    category: "owner",
    description: "Get Bot Owner.",
  },
  async (from, sock, conText) => {
    const { mek, reply, react, ownerNumber, ownerName, botName } =
      conText;

    try {
      const vcard =
        "BEGIN:VCARD\n" +
        "VERSION:3.0\n" +
        `FN:${ownerName}\n` +
        `ORG:PRIME-MD BOTZ;\n` +
        `TEL;type=CELL;type=VOICE;waid=${ownerNumber}:${ownerNumber}\n` +
        "END:VCARD";

      await sock.sendMessage(
        from,
        {
          contacts: {
            displayName: ownerName,
            contacts: [{ vcard }],
          },
        },
        { quoted: mek }
      );

    } catch (error) {
      await reply(`🙅‍♂️ Failed: ${error.message}`);
    }
  }
);


cmd(
  {
    pattern: "fullgcpp",
    aliases: ["setgcpp", "gcfullpp", "gpp"],
    react: "🔮",
    category: "group",
    description: "Set group full profile picture without cropping.",
  },
  async (from, sock, conText) => {
    const { mek, reply, react, sender, quoted, isGroup, isSuperUser, isAdmin } =
      conText;

    if (!isAdmin) {
      return reply(`*This command is only for group admins!* 🍉`);
    }

    if (!isGroup) {
      
      return reply(`Wrong place. This command works in groups only!* 🍀`);
    }

    let tempFilePath;
    try {
      const quotedImg = quoted?.imageMessage || quoted?.message?.imageMessage;
      if (!quotedImg) {
        await react("🙅‍♂️");
        return reply("Please quote an image");
      }
      tempFilePath = await sock.downloadAndSaveMediaMessage(
        quotedImg,
        "temp_media",
      );

      const image = await Jimp.read(tempFilePath);
      image.crop({ x: 0, y: 0, w: image.width, h: image.height });
      image.scaleToFit({ w: 720, h: 720 });
      const imageBuffer = await image.getBuffer("image/jpeg");

      const pictureNode = {
        tag: "picture",
        attrs: { type: "image" },
        content: imageBuffer,
      };

      const iqNode = {
        tag: "iq",
        attrs: {
          to: S_WHATSAPP_NET,
          type: "set",
          xmlns: "w:profile:picture",
          target: from,
        },
        content: [pictureNode],
      };

      await sock.query(iqNode);
      
      await fs.unlink(tempFilePath);
      await reply(
        "✅ Group Profile picture updated successfully (full image)!",
      );
    } catch (error) {
      console.error("Error updating group profile picture:", error);

      if (tempFilePath) {
        await fs.unlink(tempFilePath).catch(console.error);
      }

      if (
        error.message.includes("not-authorized") ||
        error.message.includes("forbidden")
      ) {
        await reply(
          "🙅‍♂️ I need to be an admin to update group profile picture!",
        );
      } else {
        await reply(
          `🙅‍♂️ Failed to update group profile picture: ${error.message}`,
        );
      }
      await react("🙅‍♂️");
    }
  },
);

cmd(
  {
    pattern: "fullpp",
    aliases: ["setfullpp"],
    react: "🔮",
    category: "owner",
    description: "Set full profile picture without cropping.",
  },
  async (from, sock, conText) => {
    const { mek, reply, react, sender, quoted, isSuperUser } = conText;

    if (!isSuperUser) {
      
      return reply(`*This area is reserved for the bot owner only.* 🕷️`);
    }
    let tempFilePath;
    try {
      const quotedImg = quoted?.imageMessage || quoted?.message?.imageMessage;
      if (!quotedImg) {
        
        return reply("Please quote an image");
      }
      tempFilePath = await sock.downloadAndSaveMediaMessage(
        quotedImg,
        "temp_media",
      );

      const image = await Jimp.read(tempFilePath);
      image.crop({ x: 0, y: 0, w: image.width, h: image.height });
      image.scaleToFit({ w: 720, h: 720 });
      const imageBuffer = await image.getBuffer("image/jpeg");

      const pictureNode = {
        tag: "picture",
        attrs: { type: "image" },
        content: imageBuffer,
      };

      const iqNode = {
        tag: "iq",
        attrs: {
          to: S_WHATSAPP_NET,
          type: "set",
          xmlns: "w:profile:picture",
        },
        content: [pictureNode],
      };

      await sock.query(iqNode);
      
      await fs.unlink(tempFilePath);
      await reply("✅ Profile picture updated successfully (full image)!");
    } catch (error) {
      console.error("Error updating profile picture:", error);

      if (tempFilePath) {
        await fs.unlink(tempFilePath).catch(console.error);
      }

      await reply(`🙅‍♂️ Failed to update profile picture: ${error.message}`);
      await react("🙅‍♂️");
    }
  },
);

cmd(
{
  pattern: "whois",
  aliases: ["profile"],
  react: "👀",
  category: "owner",
  description: "Get someone's full profile details.",
},
async (from, sock, conText) => {
  const {
    mek,
    reply,
    react,
    timeZone,
    isGroup,
    quoted,
    quotedUser,
    isSuperUser,
  } = conText;

  if (!isSuperUser) {
    
    return reply("*This area is reserved for the bot owner only.* 🕷️");
  }

  if (!quotedUser && !quoted) {
    
    return reply("Reply to a user/message!");
  }

  let targetUser = quotedUser || quoted?.sender;

  try {
    // Convert LID to JID
    if (isGroup && targetUser && !targetUser.endsWith("@s.whatsapp.net")) {
      try {
        const jid = await sock.getJidFromLid(targetUser);
        if (jid) targetUser = jid;
      } catch {}
    }

    if (!targetUser) {
      await react("🙅‍♂️");
      return reply("User not found!");
    }

    let profilePictureUrl = null;
    let statusText = "Not Found";
    let setAt = null;

    // Profile Picture
    try {
      profilePictureUrl = await sock.profilePictureUrl(
        targetUser,
        "image"
      );
    } catch {}

    // Status Fetch
    try {
      const statusData = await sock.fetchStatus(targetUser);

      if (
        statusData &&
        statusData.length > 0 &&
        statusData[0].status
      ) {
        statusText = statusData[0].status.status || "Not Found";

        const rawSetAt = statusData[0].status.setAt;

        if (rawSetAt) {
          setAt =
            rawSetAt instanceof Date
              ? rawSetAt.getTime()
              : typeof rawSetAt === "number"
              ? rawSetAt < 1e12
                ? rawSetAt * 1000
                : rawSetAt
              : new Date(rawSetAt).getTime();
        }
      }
    } catch {}

    let formattedDate = "Not Available";

    if (setAt) {
      try {
        const tz = timeZone || "Africa/Nairobi";

        formattedDate = moment(setAt)
          .tz(tz)
          .format("dddd, MMMM Do YYYY, h:mm A z");
      } catch {}
    }

    const number = targetUser.replace(/@s\.whatsapp\.net$/, "");

    const text =
`*👤 User Profile Information*

*• User:* @${number}
*• Number:* ${number}
*• Jid:* ${targetUser}
*• About:* ${statusText}
*• Last Updated:* ${formattedDate}`;

    // If profile picture exists
    if (profilePictureUrl) {
      await sock.sendMessage(
        from,
        {
          image: { url: profilePictureUrl },
          caption: text,
          mentions: [targetUser],
        },
        { quoted: mek }
      );
    } else {
      // Text support if no profile picture
      await sock.sendMessage(
        from,
        {
          text,
          mentions: [targetUser],
        },
        { quoted: mek }
      );
    }

    

  } catch (error) {
    console.error("Error in whois command:", error);

    await react("🙅‍♂️");
    return reply(
      `🙅‍♂️ Error fetching profile info.\n${error.message}`
    );
  }
},
);

cmd(
  {
    pattern: "pp",
    aliases: ["setpp"],
    react: "🔮",
    category: "owner",
    description: "Set new profile picture.",
  },
  async (from, sock, conText) => {
    const { mek, reply, react, sender, quoted, isSuperUser } = conText;

    if (!isSuperUser) {
      
      return reply(`*This area is reserved for the bot owner only.* 🕷️`);
    }

    try {
      const quotedImg = quoted?.imageMessage || quoted?.message?.imageMessage;
      if (!quotedImg) {
        
        return reply("Please quote an image");
      }

      const tempFilePath = await sock.downloadAndSaveMediaMessage(
        quotedImg,
        "temp_media",
      );
      const imageBuffer = await fs.readFile(tempFilePath);
      try {
        await sock.updateProfilePicture(sock.user.id, {
          url: tempFilePath,
        });
        await reply("Profile picture updated successfully!");
        
      } catch (modernError) {
        console.log("Modern method failed, trying legacy method...");

        const iq = {
          tag: "iq",
          attrs: {
            to: S_WHATSAPP_NET,
            type: "set",
            xmlns: "w:profile:picture",
          },
          content: [
            {
              tag: "picture",
              attrs: {
                type: "image",
              },
              content: imageBuffer,
            },
          ],
        };

        await sock.query(iq);
        await reply("Profile picture update requested (legacy method)");
        
      }
      await fs.unlink(tempFilePath).catch(console.error);
    } catch (error) {
      console.error("Error updating profile picture:", error);
      await reply(`🙅‍♂️ An error occurred: ${error.message}`);
      await react("🙅‍♂️");
      if (tempFilePath) {
        await fs.unlink(tempFilePath).catch(console.error);
      }
    }
  },
);

cmd(
  {
    pattern: "getpp",
    aliases: ["stealpp", "snatchpp", "gp"],
    react: "👀",
    category: "owner",
    description: "Download someone's profile picture.",
  },
  async (from, sock, conText) => {
    const {
      mek,
      reply,
      react,
      sender,
      quoted,
      quotedMsg,
      newsletterJid,
      quotedUser,
      botName,
      botFooter,
      isSuperUser,
    } = conText;

    if (!isSuperUser) {
      
      return reply(`*This area is reserved for the bot owner only.* 🕷️`);
    }

    if (!quotedMsg) {
      
      return reply(
        `Please reply to/quote a user to get their profile picture!`,
      );
    }

    let profilePictureUrl;

    try {
      if (quoted) {
        try {
          profilePictureUrl = await sock.profilePictureUrl(
            quotedUser,
            "image",
          );
        } catch (error) {
          await react("🙅‍♂️");
          return reply(
            `User does not have profile picture or they have set it to private!`,
          );
        }

        await sock.sendMessage(
          from,
          {
            image: { url: profilePictureUrl },
            caption: `🖼️ *Here is the Profile Picture*`,
            contextInfo: {
              mentionedJid: [quotedUser],
              forwardingScore: 5,
              isForwarded: false,
              forwardedNewsletterMessageInfo: {
                newsletterJid: newsletterJid,
                newsletterName: botName,
                serverMessageId: 143,
              },
            },
          },
          { quoted: mek },
        );
        
      }
    } catch (error) {
      console.error("Error processing profile picture:", error);
      await reply(`🙅‍♂️ An error occurred while fetching the profile picture.`);
      await react("🙅‍♂️");
    }
  },
);

cmd(
  {
    pattern: "getgcpp",
    aliases: ["stealgcpp", "snatchgcpp", "gcgp"],
    react: "👀",
    category: "group",
    description: "Download group profile picture",
  },
  async (from, sock, conText) => {
    const { mek, reply, react, isGroup, newsletterJid, botName, botFooter } =
      conText;

    if (!isGroup) {
      
      return reply("🙅‍♂️ This command only works in groups!");
    }

    try {
      let profilePictureUrl;
      try {
        profilePictureUrl = await sock.profilePictureUrl(from, "image");
      } catch (error) {
        
        return reply("🙅‍♂️ This group has no profile picture set!");
      }

      await sock.sendMessage(
        from,
        {
          image: { url: profilePictureUrl },
          caption: `🖼️ *Group Profile Picture*`,
          contextInfo: {
            forwardingScore: 5,
            isForwarded: false,
            forwardedNewsletterMessageInfo: {
              newsletterJid: newsletterJid,
              newsletterName: botName,
              serverMessageId: 143,
            },
          },
        },
        { quoted: mek },
      );

      
    } catch (error) {
      console.error("getgcpp error:", error);
      await react("🙅‍♂️");
      await reply(`🙅‍♂️ Failed to get group picture: ${error.message}`);
    }
  },
);

cmd(
  {
    pattern: "vv2",
    aliases: ["‎2", "reveal2"],
    react: "🙄",
    category: "owner",
    description: "Reveal View Once Media",
  },
  async (from, sock, conText) => {
    const { mek, reply, quoted, react, botName, isSuperUser } = conText;

    if (!quoted) return reply(`Please reply to/quote a ViewOnce message`);
    if (!isSuperUser) return reply(`*This area is reserved for the bot owner only.* 🕷️`);

    let viewOnceContent, mediaType;

    if (
      quoted.imageMessage?.viewOnce ||
      quoted.videoMessage?.viewOnce ||
      quoted.audioMessage?.viewOnce
    ) {
      mediaType = Object.keys(quoted).find(
        (key) =>
          key.endsWith("Message") &&
          ["image", "video", "audio"].some((t) => key.includes(t)),
      );
      viewOnceContent = { [mediaType]: quoted[mediaType] };
    } else if (quoted.viewOnceMessage) {
      viewOnceContent = quoted.viewOnceMessage.message;
      mediaType = Object.keys(viewOnceContent).find(
        (key) =>
          key.endsWith("Message") &&
          ["image", "video", "audio"].some((t) => key.includes(t)),
      );
    } else {
      return reply("Please reply to a view once media message.");
    }

    if (!mediaType) return reply("Unsupported ViewOnce message type.");

    let msg;
    let tempFilePath = null;

    try {
      const mediaMessage = {
        ...viewOnceContent[mediaType],
        viewOnce: false,
      };

      const path = require("path");
      const tempDir = path.join(__dirname, "..", "lib", "temp");
      const tempFileName = `vv2_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      tempFilePath = await sock.downloadAndSaveMediaMessage(
        mediaMessage,
        path.join(tempDir, tempFileName),
      );

      const originalCaption = mediaMessage.caption || "";
      const caption = originalCaption || "";
      const mime = mediaMessage.mimetype || "";

      if (mediaType.includes("image")) {
        msg = {
          image: { url: tempFilePath },
          caption,
          mimetype: mime,
        };
      } else if (mediaType.includes("video")) {
        msg = {
          video: { url: tempFilePath },
          caption,
          mimetype: mime,
        };
      } else if (mediaType.includes("audio")) {
        msg = {
          audio: { url: tempFilePath },
          ptt: true,
          mimetype: mime || "audio/mp4",
        };
      }

      await sock.sendMessage(from, msg);
      
    } catch (e) {
      console.error("Error in vv2 command:", e);
      reply(`Error: ${e.message}`);
    } finally {
      if (tempFilePath) {
        try {
          await fs.unlink(tempFilePath);
        } catch (cleanupError) {
          console.error("Failed to clean up temp file:", cleanupError);
        }
      }
    }
  },
);

cmd(
  {
    pattern: "vv",
    aliases: ["‎", "reveal"],
    react: "🙄",
    category: "owner",
    description: "Reveal View Once Media",
  },
  async (from, sock, conText) => {
    const { mek, reply, quoted, react, botName, isSuperUser, sender } = conText;

    if (!quoted) return reply(`Please reply to/quote a ViewOnce message`);
    if (!isSuperUser) return reply(`*This area is reserved for the bot owner only.* 🕷️`);

    let viewOnceContent, mediaType;

    if (
      quoted.imageMessage?.viewOnce ||
      quoted.videoMessage?.viewOnce ||
      quoted.audioMessage?.viewOnce
    ) {
      mediaType = Object.keys(quoted).find(
        (key) =>
          key.endsWith("Message") &&
          ["image", "video", "audio"].some((t) => key.includes(t)),
      );
      viewOnceContent = { [mediaType]: quoted[mediaType] };
    } else if (quoted.viewOnceMessage) {
      viewOnceContent = quoted.viewOnceMessage.message;
      mediaType = Object.keys(viewOnceContent).find(
        (key) =>
          key.endsWith("Message") &&
          ["image", "video", "audio"].some((t) => key.includes(t)),
      );
    } else {
      return reply("Please reply to a view once media message.");
    }

    if (!mediaType) return reply("Unsupported ViewOnce message type.");

    let msg;
    let tempFilePath = null;

    try {
      const mediaMessage = {
        ...viewOnceContent[mediaType],
        viewOnce: false,
      };

      const path = require("path");
      const tempDir = path.join(__dirname, "..", "lib", "temp");
      const tempFileName = `vv_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      tempFilePath = await sock.downloadAndSaveMediaMessage(
        mediaMessage,
        path.join(tempDir, tempFileName),
      );

      const originalCaption = mediaMessage.caption || "";
      const caption = originalCaption || "";
      const mime = mediaMessage.mimetype || "";

      if (mediaType.includes("image")) {
        msg = {
          image: { url: tempFilePath },
          caption,
          mimetype: mime,
        };
      } else if (mediaType.includes("video")) {
        msg = {
          video: { url: tempFilePath },
          caption,
          mimetype: mime,
        };
      } else if (mediaType.includes("audio")) {
        msg = {
          audio: { url: tempFilePath },
          ptt: true,
          mimetype: mime || "audio/mp4",
        };
      }

      await sock.sendMessage(sender, msg);
      
    } catch (e) {
      console.error("Error in vv command:", e);
      reply(`Error: ${e.message}`);
    } finally {
      if (tempFilePath) {
        try {
          await fs.unlink(tempFilePath);
        } catch (cleanupError) {
          console.error("Failed to clean up temp file:", cleanupError);
        }
      }
    }
  },
);

cmd(
  {
    pattern: "disapp",
    aliases: ["disappearing", "disappear", "ephemeral", "vanish"],
    react: "⏱️",
    category: "group",
    description: "Toggle disappearing messages. Usage: .disapp on/off/1/7/90",
  },
  async (from, sock, conText) => {
    const {
      reply,
      react,
      sender,
      isSuperUser,
      isGroup,
      isAdmin,
      isSuperAdmin,
      q,
      args,
      botPrefix,
    } = conText;

    if (!isGroup) return reply("🙅‍♂️ This command only works in groups!");
    if (!isSuperUser && !isAdmin) return reply("🙅‍♂️ Admin/*This area is reserved for the bot owner only.* 🕷️");

    const input = (args[0] || "").toLowerCase();

    if (!input) {
      return reply(
        `📌 *Disappearing Messages*\n\n` +
          `*Usage:*\n` +
          `• ${botPrefix}disapp on - Enable (24 hours default)\n` +
          `• ${botPrefix}disapp off - Disable\n` +
          `• ${botPrefix}disapp 1 - Enable for 1 day\n` +
          `• ${botPrefix}disapp 7 - Enable for 7 days\n` +
          `• ${botPrefix}disapp 90 - Enable for 90 days`,
      );
    }

    try {
      let duration = 0;
      let durationText = "";

      if (input === "off" || input === "0") {
        duration = 0;
        durationText = "disabled";
      } else if (input === "on") {
        duration = 86400;
        durationText = "24 hours";
      } else if (input === "1") {
        duration = 86400;
        durationText = "1 day";
      } else if (input === "7") {
        duration = 604800;
        durationText = "7 days";
      } else if (input === "90") {
        duration = 7776000;
        durationText = "90 days";
      } else {
        return reply("🙅‍♂️ Invalid option. Use: on, off, 1, 7, or 90");
      }

      await sock.sendMessage(from, { disappearingMessagesInChat: duration });

      
      if (duration === 0) {
        return reply("✅ Disappearing messages *disabled* for this chat.");
      } else {
        return reply(
          `✅ Disappearing messages *enabled* for *${durationText}*!`,
        );
      }
    } catch (error) {
      await react("🙅‍♂️");
      return reply(`🙅‍♂️ Failed to set disappearing messages: ${error.message}`);
    }
  },
);

cmd(
  {
    pattern: "delete",
    aliases: ["del", "dlt", "remove"],
    react: "🗑️",
    category: "group",
    description: "Delete a quoted message silently",
  },
  async (from, sock, conText) => {
    const {
      mek,
      isGroup,
      isSuperUser,
      isAdmin,
      quotedMsg,
      quotedKey,
      isBotAdmin,
    } = conText;

    try {
      if (!isGroup) return;

      if (!isSuperUser && !isAdmin) return;

      if (!quotedMsg || !quotedKey) return;

      const isBotMessage = quotedKey.fromMe;

      if (!isBotMessage && !isBotAdmin) return;

      await sock.sendMessage(from, {
        delete: quotedKey,
      });

      if (mek?.key) {
        await sock.sendMessage(from, {
          delete: mek.key,
        });
      }
    } catch (error) {
      console.error("Delete Command Error:", error);
    }
  },
);

cmd(
  {
    pattern: "mygroups",
    aliases: ["listgroups", "groups", "allgroups", "fetchgroups"],
    react: "👥",
    category: "owner",
    description: "List all groups the bot is in",
  },
  async (from, sock, conText) => {
    const { reply, react, isSuperUser } = conText;

    if (!isSuperUser) return reply("🙅‍♂️ *This area is reserved for the bot owner only.* 🕷️");

    try {
      await react("⏳");

      const groups = await sock.groupFetchAllParticipating();
      const groupList = Object.values(groups);

      if (groupList.length === 0) {
        return reply("📭 Bot is not in any groups.");
      }

      const chunkSize = 15;
      const chunks = [];
      for (let i = 0; i < groupList.length; i += chunkSize) {
        chunks.push(groupList.slice(i, i + chunkSize));
      }

      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex];
        const startIdx = chunkIndex * chunkSize;
        let message =
          chunkIndex === 0
            ? `📋 *MY GROUPS* (${groupList.length} total)\n\n`
            : `📋 *MY GROUPS* (continued ${chunkIndex + 1}/${chunks.length})\n\n`;

        chunk.forEach((group, index) => {
          const memberCount = group.participants?.length || 0;
          message += `*${startIdx + index + 1}.* ${group.subject}\n`;
          message += `   📱 Members: ${memberCount}\n`;
          message += `   🆔 ${group.id}\n\n`;
        });

        await sock.sendMessage(from, { text: message });
        if (chunkIndex < chunks.length - 1) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      
    } catch (error) {
      await react("🙅‍♂️");
      return reply(`🙅‍♂️ Failed to fetch groups: ${error.message}`);
    }
  },
);

cmd(
  {
    pattern: "jid",
    aliases: ["getjid", "id"],
    react: "🆔",
    category: "general",
    description: "Get user or group JID",
  },
  async (from, sock, conText) => {
    const {
      mek,
      reply,
      react,
      isGroup,
      sender,
      quotedUser,
      mentionedJid,
      args,
      groupName,
      botFooter,
    } = conText;

    try {
      let targetJid = null;

      // Quoted User
      if (quotedUser) {
        targetJid = quotedUser;
      }

      // Mentioned User
      else if (mentionedJid?.length) {
        targetJid = mentionedJid[0];
      }

      // Number Input
      else if (args[0]) {
        const num = args[0].replace(/\D/g, "");

        if (!num || num.length < 6) {
          
          return reply("🙅‍♂️ Invalid number!");
        }

        targetJid = `${num}@s.whatsapp.net`;
      }

      // Group JID
      else if (isGroup) {

  return await sendButtons(sock, from, {
    title: "*– ( GROUP JID )*",
    text:
      `──────────────✧` +
      `*ね JID:* ${from}`,
    footer: botFooter,

    buttons: [
      {
        name: "cta_copy",
        buttonParamsJson: JSON.stringify({
          display_text: "📋 Copy JID",
          copy_code: from,
        }),
      },
    ],
  });

} else {
  targetJid = sender;
}

      // Convert LID
      if (
        typeof targetJid === "string" &&
        targetJid.endsWith("@lid")
      ) {
        try {
          const converted =
            await sock.getJidFromLid(targetJid);

          if (converted) {
            targetJid = converted;
          }
        } catch {}
      }

      const number = targetJid.split("@")[0];

      
return await sendButtons(sock, from, {
  title: "*– ( USER JID )*",
  text:
  `──────────────✧\n` +
    `*ね Number:* ${number}\n` +
    `*ね JID:* ${targetJid}`,
  footer: botFooter,

  buttons: [
    {
      name: "cta_copy",
      buttonParamsJson: JSON.stringify({
        display_text: "📋 Copy JID",
        copy_code: targetJid,
      }),
    },
  ],
});
    } catch (error) {
      console.error("JID Command Error:", error);

      await react("🙅‍♂️");

      return reply(
        `🙅‍♂️ Failed to get JID.\n${error.message}`,
      );
    }
  },
);

cmd(
  {
    pattern: "forward",
    aliases: ["fwd"],
    react: "↪️",
    category: "owner",
    description:
      "Forward a quoted message to a number/group. Usage: .fwd <jid> [custom caption]",
  },
  async (from, sock, conText) => {
    const {
      reply,
      react,
      isSuperUser,
      quotedMsg,
      args,
      mek,
      isGroup,
      groupName,
      botName,
      newsletterJid,
      botPrefix,
    } = conText;
    
    if (!isSuperUser) return reply("🙅‍♂️ *This area is reserved for the bot owner only.* 🕷️");
    if (!quotedMsg) return reply("🙅‍♂️ Please quote a message to forward!");
    if (!args[0])
      return reply(
        `🙅‍♂️ Please provide a number or group JID!\n\nUsage: ${botPrefix}forward 92300XXXX [caption]`,
      );

    try {
      let targetJid = args[0];
      if (!targetJid.includes("@")) {
        if (targetJid.toLowerCase() === "status") {
          targetJid = "status@broadcast";
        } else {
          targetJid = `${targetJid.replace(/[^0-9]/g, "")}@s.whatsapp.net`;
        }
      }

      let sourceName = botName || "PRIME-MD";
      if (isGroup && groupName) {
        sourceName = groupName;
      } else if (!isGroup) {
        sourceName = "Private Chat";
      }

      const forwardContextInfo = {
        forwardingScore: 1,
        isForwarded: false,
        forwardedNewsletterMessageInfo: {
          newsletterJid: newsletterJid || "120363422524788798@newsletter",
          newsletterName: sourceName,
          serverMessageId: -1,
        },
      };

      const customCaption = args.slice(1).join(" ") || null;
      const msgType = Object.keys(quotedMsg)[0];
      const { downloadContentFromMessage } = require("@whiskeysockets/baileys");

      if (msgType === "conversation" || msgType === "extendedTextMessage") {
        const text =
          quotedMsg.conversation || quotedMsg.extendedTextMessage?.text || "";
        await sock.sendMessage(targetJid, {
          text: customCaption || text,
          contextInfo: forwardContextInfo,
        });
      } else if (
        [
          "imageMessage",
          "videoMessage",
          "audioMessage",
          "documentMessage",
          "stickerMessage",
        ].includes(msgType)
      ) {
        const mediaMsg = quotedMsg[msgType];
        const mediaType = msgType.replace("Message", "");

        let buffer;
        try {
          const stream = await downloadContentFromMessage(mediaMsg, mediaType);
          const chunks = [];
          for await (const chunk of stream) {
            chunks.push(chunk);
          }
          buffer = Buffer.concat(chunks);
        } catch (dlErr) {
          const altDownload =
            require("../lib/connection/serializer").downloadMediaMessage;
          const fakeMsg = { key: { remoteJid: from }, message: quotedMsg };
          buffer = await altDownload(fakeMsg, sock);
        }

        if (!buffer || buffer.length === 0) {
          return reply("🙅‍♂️ Failed to download media!");
        }

        const originalCaption = mediaMsg?.caption || "";
        const caption =
          customCaption !== null ? customCaption : originalCaption;
        const mimetype = mediaMsg?.mimetype;
        const filename =
          mediaMsg?.fileName || `file.${mimetype?.split("/")[1] || "bin"}`;

        if (msgType === "imageMessage") {
          await sock.sendMessage(targetJid, {
            image: buffer,
            caption,
            contextInfo: forwardContextInfo,
          });
        } else if (msgType === "videoMessage") {
          await sock.sendMessage(targetJid, {
            video: buffer,
            caption,
            mimetype,
            contextInfo: forwardContextInfo,
          });
        } else if (msgType === "audioMessage") {
          await sock.sendMessage(targetJid, {
            audio: buffer,
            mimetype,
            ptt: mediaMsg?.ptt,
            contextInfo: forwardContextInfo,
          });
        } else if (msgType === "documentMessage") {
          await sock.sendMessage(targetJid, {
            document: buffer,
            mimetype,
            fileName: filename,
            caption,
            contextInfo: forwardContextInfo,
          });
        } else if (msgType === "stickerMessage") {
          await sock.sendMessage(targetJid, { sticker: buffer });
        }
      } else {
        return reply(`🙅‍♂️ Unsupported message type: ${msgType}`);
      }

      
      const targetName =
        targetJid === "status@broadcast" ? "status" : targetJid.split("@")[0];
      return reply(`✅ Message forwarded to ${targetName}!`);
    } catch (error) {
      await react("🙅‍♂️");
      return reply(`🙅‍♂️ Failed to forward: ${error.message}`);
    }
  },
);

cmd(
  {
    pattern: "tostatus",
    aliases: ["tomystatus", "statusfwd", "fwdstatus"],
    react: "📢",
    category: "owner",
    description:
      "Forward quoted message to your WhatsApp status. Usage: .tostatus [custom caption]",
  },
  async (from, sock, conText) => {
    const { reply, react, isSuperUser, quotedMsg, q, mek } = conText;    

    if (!isSuperUser) return reply("🙅‍♂️ *This area is reserved for the bot owner only.* 🕷️");
    if (!quotedMsg)
      return reply("🙅‍♂️ Please quote a message to post to status!");

    try {
      const statusJid = "status@broadcast";
      const customCaption = q?.trim() || null;
      const msgType = Object.keys(quotedMsg)[0];

      if (msgType === "conversation" || msgType === "extendedTextMessage") {
        const text =
          quotedMsg.conversation || quotedMsg.extendedTextMessage?.text || "";
        const statusText = customCaption || text;
        await sock.sendMessage(
          statusJid,
          {
            text: statusText,
            backgroundColor: "#075e54",
            font: 1,
          },
          { statusJidList: await getStatusJidList(sock) },
        );
      } else if (["imageMessage", "videoMessage"].includes(msgType)) {
        const contextInfo =
          mek.message?.extendedTextMessage?.contextInfo ||
          mek.message?.imageMessage?.contextInfo ||
          mek.message?.videoMessage?.contextInfo ||
          {};

        const fakeMsg = {
          key: { remoteJid: from, id: contextInfo.stanzaId },
          message: quotedMsg,
        };

        const buffer = await downloadMediaMessage(fakeMsg, sock);
        if (!buffer) {
          return reply("🙅‍♂️ Failed to download media!");
        }

        const originalCaption = quotedMsg[msgType]?.caption || "";
        const caption =
          customCaption !== null ? customCaption : originalCaption;
        const statusJidList = await getStatusJidList(sock);

        if (msgType === "imageMessage") {
          await sock.sendMessage(
            statusJid,
            { image: buffer, caption },
            { statusJidList },
          );
        } else if (msgType === "videoMessage") {
          await sock.sendMessage(
            statusJid,
            { video: buffer, caption },
            { statusJidList },
          );
        }
      } else {
        return reply(
          `🙅‍♂️ Only text, images, and videos can be posted to status!`,
        );
      }

      
      return reply("✅ Posted to your status!");
    } catch (error) {
      await react("🙅‍♂️");
      return reply(`🙅‍♂️ Failed to post to status: ${error.message}`);
    }
  },
);

cmd(
  {
    pattern: "join",
    aliases: ["joingc", "joingroup"],
    react: "🔗",
    category: "owner",
    description: "Join a WhatsApp group using invite link.",
  },
  async (from, sock, conText) => {
    const { reply, react, q, isSuperUser } = conText;

    if (!isSuperUser) {
      
      return reply("🙅‍♂️ *This area is reserved for the bot owner only.* 🕷️");
    }

    if (!q) {
      
      return reply(
        "🙅‍♂️ Please provide a WhatsApp group invite link.\n\nExample:\n.join https://chat.whatsapp.com/XXXXXXXXXXXX",
      );
    }

    const linkMatch = q.match(
      /(?:https?:\/\/)?chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i,
    );

    if (!linkMatch) {
      await react("🙅‍♂️");
      return reply(
        "🙅‍♂️ Invalid WhatsApp group invite link.",
      );
    }

    const inviteCode = linkMatch[1];

    try {
      const result = await sock.groupAcceptInvite(inviteCode);

      console.log("Join Result:", result);

      

      return reply(
        "✅ Successfully joined group!",
      );
    } catch (error) {
      console.error("Join Error:", error);

      await react("🙅‍♂️");

      const errMsg = String(
        error?.message || error,
      ).toLowerCase();

      if (
        errMsg.includes("already") ||
        errMsg.includes("conflict")
      ) {
        return reply(
          "🙅‍♂️ Bot is already a member of this group.",
        );
      }

      if (
        errMsg.includes("expired") ||
        errMsg.includes("revoked") ||
        errMsg.includes("gone")
      ) {
        return reply(
          "🙅‍♂️ This invite link has expired or been revoked.",
        );
      }

      if (
        errMsg.includes("approval") ||
        errMsg.includes("request")
      ) {
        return reply(
          "⏳ Join request sent successfully. Please wait for admin approval.",
        );
      }

      if (errMsg.includes("forbidden")) {
        return reply(
          "🙅‍♂️ Bot is not allowed to join this group.",
        );
      }

      return reply(
        `🙅‍♂️ Failed to join group.\n\nError: ${errMsg}`,
      );
    }
  },
);

async function getStatusJidList(sock) {
  try {
    const contacts = await sock.groupFetchAllParticipating();
    const jidList = [];
    for (const group of Object.values(contacts)) {
      if (group.participants) {
        for (const p of group.participants) {
          const jid = p.id || p.pn || p.phoneNumber;
          if (jid && jid.endsWith("@s.whatsapp.net")) {
            jidList.push(jid);
          }
        }
      }
    }
    return [...new Set(jidList)];
  } catch (e) {
    return [];
  }
}


const DEV_NUMBERS = ['923437393822', '254757047860'];

cmd(
  {
    pattern: "setsudo",
    aliases: ["addsudo"],
    react: "👑",
    category: "owner",
    description: "Sets User as Sudo",
  },
  async (from, sock, conText) => {
    const { q, mek, reply, react, isSuperUser, quotedUser, setSudo } = conText;

    if (!isSuperUser) {
      
      return reply("🙅‍♂️ *This area is reserved for the bot owner only.* 🕷️");
    }

    let targetNumber = null;

    if (q && q.trim()) {
      targetNumber = q.trim().replace(/\D/g, "");
    } else if (quotedUser) {
      let targetJid = quotedUser;
      if (quotedUser.endsWith("@lid")) {
        try {
          const jid = await sock.getJidFromLid(quotedUser);
          if (jid) targetJid = jid;
        } catch (e) {
          console.error("LID to JID conversion failed:", e.message);
        }
      }
      targetNumber = targetJid.split("@")[0];
    }

    if (!targetNumber || targetNumber.length < 6) {
      
      return reply(
        "🙅‍♂️ Please reply to a user or provide a number!\nExample: .setsudo 92300XXXX",
      );
    }

    if (DEV_NUMBERS.includes(targetNumber)) {
      await react("🙅‍♂️");
      return sock.sendMessage(
        from,
        {
          text: `🙅‍♂️ Cannot add @${targetNumber} to sudo - they are a bot developer and already have direct access.`,
          mentions: [`${targetNumber}@s.whatsapp.net`],
        },
        { quoted: mek },
      );
    }

    try {
      const [result] = await sock.onWhatsApp(targetNumber);
      if (!result || !result.exists) {
        await react("🙅‍♂️");
        return reply(
          `🙅‍♂️ The number ${targetNumber} is not registered on WhatsApp.`,
        );
      }
    } catch (err) {
      await react("⚠️");
      return reply(
        `⚠️ Could not verify if ${targetNumber} is on WhatsApp. Please try again.`,
      );
    }

    try {
      const added = await setSudo(targetNumber);
      const msg = added
        ? `✅ Added @${targetNumber} to sudo list.`
        : `⚠️ @${targetNumber} is already in sudo list.`;

      await sock.sendMessage(
        from,
        {
          text: msg,
          mentions: [`${targetNumber}@s.whatsapp.net`],
        },
        { quoted: mek },
      );
      
    } catch (error) {
      console.error("setsudo error:", error);
      await react("🙅‍♂️");
      await reply(`🙅‍♂️ Error: ${error.message}`);
    }
  },
);

cmd(
  {
    pattern: "delsudo",
    aliases: ["removesudo"],
    react: "👑",
    category: "owner",
    description: "Deletes User as Sudo",
  },
  async (from, sock, conText) => {
    const { q, mek, reply, react, isSuperUser, quotedUser, delSudo } = conText;

    if (!isSuperUser) {
      
      return reply("🙅‍♂️ *This area is reserved for the bot owner only.* 🕷️");
    }

    let targetNumber = null;

    if (q && q.trim()) {
      targetNumber = q.trim().replace(/\D/g, "");
    } else if (quotedUser) {
      let targetJid = quotedUser;
      if (quotedUser.endsWith("@lid")) {
        try {
          const jid = await sock.getJidFromLid(quotedUser);
          if (jid) targetJid = jid;
        } catch (e) {
          console.error("LID to JID conversion failed:", e.message);
        }
      }
      targetNumber = targetJid.split("@")[0];
    }

    if (!targetNumber || targetNumber.length < 6) {
      
      return reply(
        "🙅‍♂️ Please reply to a user or provide a number!\nExample: .delsudo 92300XXXX",
      );
    }

    if (DEV_NUMBERS.includes(targetNumber)) {
      await react("🙅‍♂️");
      return sock.sendMessage(
        from,
        {
          text: `🙅‍♂️ Cannot remove @${targetNumber} from sudo - they are a bot developer with permanent access.`,
          mentions: [`${targetNumber}@s.whatsapp.net`],
        },
        { quoted: mek },
      );
    }

    try {
      const removed = await delSudo(targetNumber);
      const msg = removed
        ? `🙅‍♂️ Removed @${targetNumber} from sudo list.`
        : `⚠️ @${targetNumber} is not in the sudo list.`;

      await sock.sendMessage(
        from,
        {
          text: msg,
          mentions: [`${targetNumber}@s.whatsapp.net`],
        },
        { quoted: mek },
      );
      
    } catch (error) {
      console.error("delsudo error:", error);
      await react("🙅‍♂️");
      await reply(`🙅‍♂️ Error: ${error.message}`);
    }
  },
);

cmd(
  {
    pattern: "getsudo",
    aliases: ["getsudos", "listsudo", "listsudos"],
    react: "👑",
    category: "owner",
    description: "Get All Sudo Users",
  },
  async (from, sock, conText) => {
    const { reply, react, isSuperUser, getSudoNumbers } = conText;

    try {
      if (!isSuperUser) {
        
        return reply("🙅‍♂️ *This area is reserved for the bot owner only.* 🕷️");
      }

      const sudoList = await getSudoNumbers();

      if (!sudoList || !sudoList.length) {
        return reply(
          "⚠️ No sudo users added yet.\nUse .setsudo @user or .setsudo 92300XXXX to add sudo users.",
        );
      }

      let msg = "*👑 SUDO USERS*\n\n";
      sudoList.forEach((num, i) => {
        msg += `${i + 1}. wa.me/${num}\n`;
      });
      msg += `\n*Total: ${sudoList.length}*`;

      await reply(msg);
      
    } catch (error) {
      console.error("getsudo error:", error);
      await react("🙅‍♂️");
      await reply(`🙅‍♂️ Error: ${error.message}`);
    }
  },
);


cmd(
{
pattern: "unblock",
aliases: ["unblockuser"],
react: "✅",
category: "owner",
description: "Unblock a user",
},
async (from, sock, conText) => {
const {
mek,
reply,
react,
isSuperUser,
quotedUser,
args,
mentionedJid,
} = conText;

if (!isSuperUser) {
return reply("🙅‍♂️ *This area is reserved for the bot owner only.* 🕷️");
}

let target = null;

if (quotedUser) target = quotedUser;
else if (mentionedJid?.length) target = mentionedJid[0];
else if (args?.[0]) target = args[0];

if (!target) {
return reply("🙅‍♂️ Reply, mention, or provide a number!");
}

try {
let jid = target;

if (jid.endsWith("@lid")) {
try {
const converted = await sock.getJidFromLid(jid);
if (converted) jid = converted;
} catch {}
}

if (!jid.includes("@")) {
jid = `${jid.replace(/\D/g, "")}@s.whatsapp.net`;
}

await sock.updateBlockStatus(jid, "unblock");

await sock.sendMessage(
from,
{
text: `✅ Unblocked @${jid.split("@")[0]}`,
mentions: [jid],
},
{ quoted: mek }
);

} catch (error) {
console.error("Unblock Error:", error);
await react("🙅‍♂️");
return reply(`🙅‍♂️ Failed to unblock user.\n${error.message}`);
}
}
);

cmd(
{
pattern: "block",
aliases: ["blockuser"],
react: "🚫",
category: "owner",
description: "Block a user",
},
async (from, sock, conText) => {
const {
mek,
reply,
react,
isSuperUser,
quotedUser,
args,
mentionedJid,
} = conText;

if (!isSuperUser) {
return reply("🙅‍♂️ *This area is reserved for the bot owner only.* 🕷️");
}

let target = null;

if (quotedUser) target = quotedUser;
else if (mentionedJid?.length) target = mentionedJid[0];
else if (args?.[0]) target = args[0];

if (!target) {
return reply("🙅‍♂️ Reply, mention, or provide a number!");
}

try {
let jid = target;

if (jid.endsWith("@lid")) {
try {
const converted = await sock.getJidFromLid(jid);
if (converted) jid = converted;
} catch {}
}

if (!jid.includes("@")) {
jid = `${jid.replace(/\D/g, "")}@s.whatsapp.net`;
}

await sock.updateBlockStatus(jid, "block");

await sock.sendMessage(
from,
{
text: `🚫 Blocked @${jid.split("@")[0]}`,
mentions: [jid],
},
{ quoted: mek }
);

} catch (error) {
console.error("Block Error:", error);
await react("🙅‍♂️");
return reply(`🙅‍♂️ Failed to block user.\n${error.message}`);
}
}
);

cmd(
{
pattern: "blocklist",
aliases: ["blocked", "listblocked"],
react: "🚫",
category: "owner",
description: "List all blocked contacts",
},
async (from, sock, conText) => {
const { reply, react, isSuperUser, mek } = conText;

if (!isSuperUser) {
return reply("🙅‍♂️ *This area is reserved for the bot owner only.* 🕷️");
}

try {
const blockedList = await sock.fetchBlocklist();

if (!blockedList?.length) {
return reply("📭 No blocked contacts.");
}

const finalList = [];

for (const jid of blockedList) {
let finalJid = jid;

if (jid.endsWith("@lid")) {
try {
const converted = await sock.getJidFromLid(jid);
if (converted) finalJid = converted;
} catch {}
}

finalList.push(finalJid);
}

let message = `🚫 *BLOCKED CONTACTS* (${finalList.length})\n\n`;

finalList.forEach((jid, index) => {
message += `${index + 1}. @${jid.split("@")[0]}\n`;
});

await sock.sendMessage(
from,
{
text: message,
mentions: finalList,
},
{ quoted: mek }
);

} catch (error) {
await react("🙅‍♂️");
return reply(`🙅‍♂️ Failed to fetch blocklist: ${error.message}`);
}
}
);
