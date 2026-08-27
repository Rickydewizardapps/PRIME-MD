const { cmd, getGroupMetadata, getLidMapping } = require("../lib");
const { getGroupSetting, setGroupSetting } = require("../lib/database/groupSettings");
const { isSuperUser: checkSuperUser } = require("../lib/database/sudo");

cmd(
  {
    pattern: "unmute",
    react: "⏳",
    aliases: ["open", "groupopen", "gcopen"],
    category: "group",
    description: "Open Group Chat.",
  },
  async (from, sock, conText) => {
    const { reply, isAdmin, isSuperAdmin, isGroup, isBotAdmin, sender, isSuperUser } = conText;

    if (!isGroup) return reply("*Wrong place. This command works in groups only!* 🍀");
    if (!isBotAdmin) return reply("*Bot must be an admin to use this command!* 🛡️");
    if (!isAdmin && !isSuperAdmin && !isSuperUser) return reply("*This command is only for group admins!* 🍉");

    try {
      await sock.groupSettingUpdate(from, "not_announcement");
      await sock.sendMessage(from, {
        text: `Group successfully unmuted!`,
        mentions: [sender],
      });
    } catch (e) {
      return reply(`Failed to unmute group: ${e.message}`);
    }
  },
);

cmd(
  {
    pattern: "mute",
    react: "⏳",
    aliases: ["close", "groupmute", "gcmute", "gcclose", "adminonly", "adminsonly"],
    category: "group",
    description: "Close Group Chat",
  },
  async (from, sock, conText) => {
    const { reply, isAdmin, isSuperAdmin, isGroup, isBotAdmin, sender, isSuperUser } = conText;

    if (!isGroup) return reply("*Wrong place. This command works in groups only!* 🍀");
    if (!isBotAdmin) return reply("*Bot must be an admin to use this command!* 🛡️");
    if (!isAdmin && !isSuperAdmin && !isSuperUser) return reply("*This command is only for group admins!* 🍉");

    try {
      await sock.groupSettingUpdate(from, "announcement");
      await sock.sendMessage(from, {
        text: `Group successfully muted!`,
        mentions: [sender],
      });
    } catch (e) {
      return reply(`Failed to mute group: ${e.message}`);
    }
  },
);


cmd(
  {
    pattern: "met",
    react: "⚡",
    category: "general",
    description: "Check group metadata",
  },
  async (from, sock, conText) => {
    const { react } = conText;

    try {
      const gInfo = await getGroupMetadata(sock, from);

      const formatJid = (jid) => {
        if (!jid) return "N/A";
        return `@${jid.split("@")[0]}`;
      };

      const superAdmins = [];
      const admins = [];
      const members = [];
      const mentionJids = [];

      gInfo.participants.forEach((p) => {
        const jid =
          p.id ||
          p.jid ||
          p.phoneNumber ||
          p.pn;

        if (jid) mentionJids.push(jid);

        const formattedJid = formatJid(jid);

        if (p.admin === "superadmin") {
          superAdmins.push(`- ${formattedJid} - Owner`);
        } else if (p.admin === "admin") {
          admins.push(`- ${formattedJid} - Admin`);
        } else {
          members.push(`- ${formattedJid} - Member`);
        }
      });

      const allParticipants = [...superAdmins, ...admins, ...members].join("\n");

      const allAdmins = [
        ...superAdmins.map(s => s.replace(" - Owner", "")),
        ...admins.map(a => a.replace(" - Admin", "")),
      ];

      const metadataText =
`*– ( GROUP METADATA )*\n\n` +
`──────────────✧\n` +
`*ね ID:* ${gInfo.id}\n` +
`*ね Subject:* ${gInfo.subject || "None"}\n` +
`*ね Subject Owner:* ${formatJid(gInfo.subjectOwnerPn || gInfo.subjectOwnerJid)}\n` +
`*ね Subject Changed:* ${new Date(gInfo.subjectTime * 1000).toLocaleString()}\n` +
`*ね Owner:* ${formatJid(gInfo.ownerPn || gInfo.ownerJid)}\n` +
`*ね Created:* ${new Date(gInfo.creation * 1000).toLocaleString()}\n` +
`*ね Size:* ${gInfo.size} participants\n` +
`*ね Description:* ${gInfo.desc || "None"}\n\n` +

`*– ( ADMINS ) [${superAdmins.length + admins.length}]*\n` +
`${allAdmins.join("\n") || "No admins"}\n\n` +

`*– ( PARTICIPANTS ) [${gInfo.participants.length}]*\n` +
`${allParticipants}\n\n` +

`*– ( GROUP SETTINGS )*\n` +
`*ね Restrict:* ${gInfo.restrict ? "Yes" : "No"}\n` +
`*ね Announce:* ${gInfo.announce ? "Yes" : "No"}\n` +
`*ね Join Approval:* ${gInfo.joinApprovalMode ? "Yes" : "No"}\n` +
`*ね Member Add:* ${gInfo.memberAddMode ? "Yes" : "No"}\n` +
`*ね Community:* ${gInfo.isCommunity ? "Yes" : "No"}`;

      await sock.sendMessage(from, {
        text: metadataText,
        mentions: [...new Set(mentionJids)]
      });

    } catch (e) {
      await react("🙅‍♂️");
      await sock.sendMessage(from, {
        text: "Failed to fetch group metadata."
      });
    }
  },
);

cmd(
  {
    pattern: "demote",
    react: "👑",
    category: "group",
    description: "Demote a user from being an admin.",
  },
  async (from, sock, conText) => {
    const {
      reply, react, sender, quotedUser, superUser,
      isSuperAdmin, isAdmin, isGroup, isBotAdmin, isSuperUser,
      q, mek, mentionedJid, groupAdmins, groupMetadata,
    } = conText;

    if (!isGroup) return reply("*Wrong place. This command works in groups only!* 🍀");
    if (!isBotAdmin) return reply("*Bot must be an admin to use this command!* 🛡️");
    if (!isAdmin && !isSuperAdmin && !isSuperUser) return reply("*This command is only for group admins!* 🍉");

    const convertLidToJid = async (lid) => {
      if (!lid || !lid.includes("@lid")) return lid;
      const cached = getLidMapping(lid);
      if (cached) return cached;
      try {
        const result = await sock.getJidFromLid(lid);
        if (result) return result;
      } catch (e) {}
      return lid;
    };

    let targetJid = null;

    if (mentionedJid && mentionedJid.length > 0) {
      targetJid = await convertLidToJid(mentionedJid[0]);
    } else if (quotedUser) {
      targetJid = await convertLidToJid(quotedUser);
    } else if (q) {
      const num = q.replace(/[^0-9]/g, "");
      if (num.length >= 10) targetJid = num + "@s.whatsapp.net";
    }

    if (!targetJid || targetJid.includes("@lid")) {
      if (targetJid && targetJid.includes("@lid") && groupMetadata?.participants) {
        const lidNum = targetJid.split("@")[0];
        const found = groupMetadata.participants.find(
          p => p.lid?.split("@")[0] === lidNum || p.id?.split("@")[0] === lidNum
        );
        if (found?.id) targetJid = found.id;
        else if (found?.pn) targetJid = found.pn + "@s.whatsapp.net";
      }
    }

    if (!targetJid || targetJid.includes("@lid")) {
      await react("🙅‍♂️");
      return reply("Could not identify user. Provide their number.\nExample: .demote <number>");
    }

    if (!targetJid.includes("@")) targetJid += "@s.whatsapp.net";

    const targetNum = targetJid.split("@")[0];
    const isTargetSuperUser = await checkSuperUser(targetJid, sock);
    const standardizedSuperUsers = superUser.map(u => u.split("@")[0]);

    if (isTargetSuperUser || standardizedSuperUsers.includes(targetNum)) {
      await react("🙅‍♂️");
      return reply("Cannot demote a superuser!");
    }

    const groupSuperAdmins = conText.groupSuperAdmins || [];
    const adminNums = groupAdmins.map(a => a.split("@")[0]);
    const superAdminNums = groupSuperAdmins.map(a => a.split("@")[0]);
    const allAdminNums = [...adminNums, ...superAdminNums];

    let isTargetAdmin = allAdminNums.includes(targetNum);
    let isSuperAdminTarget = superAdminNums.includes(targetNum);

    if (groupMetadata?.participants) {
      const participant = groupMetadata.participants.find(p => {
        const pNum = (p.id || p.pn || p.phoneNumber || "").split("@")[0];
        return pNum === targetNum || (p.pn || "").split("@")[0] === targetNum;
      });
      if (participant?.admin) {
        isTargetAdmin = true;
        if (participant.admin === "superadmin") isSuperAdminTarget = true;
      }
    }

    if (!isTargetAdmin) {
      return await sock.sendMessage(from, {
        text: `@${targetNum} is not an admin.`,
        mentions: [targetJid],
      });
    }

    if (isSuperAdminTarget) {
      return await sock.sendMessage(from, {
        text: `@${targetNum} is the group owner and cannot be demoted.`,
        mentions: [targetJid],
      });
    }

    try {
      await sock.groupParticipantsUpdate(from, [targetJid], "demote");

      await sock.sendMessage(from, {
        text: `@${targetNum} is no longer an admin.`,
        mentions: [targetJid],
      });
    } catch (e) {
      await react("🙅‍♂️");
      if (e.message?.includes("403") || e.message?.toLowerCase().includes("forbidden")) {
        await sock.sendMessage(from, {
          text: `Cannot demote @${targetNum}. They may be a group owner.`,
          mentions: [targetJid],
        });
      } else {
        return reply(`Failed to demote: ${e.message}`);
      }
    }
  },
);

cmd(
  {
    pattern: "promote",
    aliases: ["toadmin"],
    react: "👑",
    category: "group",
    description: "Promote a user to admin.",
  },
  async (from, sock, conText) => {
    const {
      reply, react, sender, quotedUser,
      isSuperAdmin, isAdmin, isGroup, isBotAdmin, isSuperUser,
      q, mentionedJid, groupAdmins, mek,
      groupSuperAdmins, groupMetadata,
    } = conText;

    if (!isGroup) return reply("*Wrong place. This command works in groups only!* 🍀");
    if (!isBotAdmin) return reply("*Bot must be an admin to use this command!* 🛡️");
    if (!isAdmin && !isSuperAdmin && !isSuperUser) return reply("*This command is only for group admins!* 🍉");

    const convertLidToJid = async (lid) => {
      if (!lid || !lid.includes("@lid")) return lid;
      const cached = getLidMapping(lid);
      if (cached) return cached;
      try {
        const result = await sock.getJidFromLid(lid);
        if (result) return result;
      } catch (e) {}
      return lid;
    };

    let targetJid = null;

    if (mentionedJid && mentionedJid.length > 0) {
      targetJid = await convertLidToJid(mentionedJid[0]);
    } else if (quotedUser) {
      targetJid = await convertLidToJid(quotedUser);
    } else if (q) {
      const num = q.replace(/[^0-9]/g, "");
      if (num.length >= 10) targetJid = num + "@s.whatsapp.net";
    }

    if (!targetJid || targetJid.includes("@lid")) {
      if (targetJid && targetJid.includes("@lid") && groupMetadata?.participants) {
        const lidNum = targetJid.split("@")[0];
        const found = groupMetadata.participants.find(
          p => p.lid?.split("@")[0] === lidNum || p.id?.split("@")[0] === lidNum
        );
        if (found?.id) targetJid = found.id;
        else if (found?.pn) targetJid = found.pn + "@s.whatsapp.net";
      }
    }

    if (!targetJid || targetJid.includes("@lid")) {
      return reply("Could not identify user. Provide their number.\nExample: .promote <number>");
    }

    if (!targetJid.includes("@")) targetJid += "@s.whatsapp.net";

    const targetNum = targetJid.split("@")[0];
    const adminNums = groupAdmins ? groupAdmins.map(a => a.split("@")[0]) : [];
    const superAdminNums = groupSuperAdmins ? groupSuperAdmins.map(a => a.split("@")[0]) : [];
    const allAdminNums = [...adminNums, ...superAdminNums];

    let isAlreadyAdmin = allAdminNums.includes(targetNum);
    let isSuperAdminTarget = superAdminNums.includes(targetNum);

    if (groupMetadata?.participants) {
      const participant = groupMetadata.participants.find(p => {
        const pNum = (p.id || p.pn || p.phoneNumber || "").split("@")[0];
        return pNum === targetNum || (p.pn || "").split("@")[0] === targetNum;
      });
      if (participant?.admin) {
        isAlreadyAdmin = true;
        if (participant.admin === "superadmin") isSuperAdminTarget = true;
      }
    }

    if (isSuperAdminTarget) {
      return await sock.sendMessage(from, {
        text: `@${targetNum} is the group owner and is already an admin.`,
        mentions: [targetJid],
      });
    }

    if (isAlreadyAdmin) {
      return await sock.sendMessage(from, {
        text: `@${targetNum} is already an admin.`,
        mentions: [targetJid],
      });
    }

    try {
      await sock.groupParticipantsUpdate(from, [targetJid], "promote");

      await sock.sendMessage(from, {
        text: `@${targetNum} is now an admin.`,
        mentions: [targetJid],
      });
    } catch (e) {
      await react("🙅‍♂️");
      if (e.message?.includes("403") || e.message?.toLowerCase().includes("forbidden")) {
        await sock.sendMessage(from, {
          text: `Cannot promote @${targetNum}. They may not be a group member.`,
          mentions: [targetJid],
        });
      } else {
        return reply(`Failed to promote: ${e.message}`);
      }
    }
  },
);

cmd(
  {
    pattern: "kick",
    aliases: ["out"],
    react: "✈️",
    category: "group",
    description: "Remove a user from the group.",
  },
  async (from, sock, conText) => {
    const {
      reply, react, sender, quotedUser, superUser,
      isSuperAdmin, isAdmin, isGroup, isBotAdmin, isSuperUser,
      q, mek, mentionedJid, groupMetadata,
    } = conText;

    if (!isGroup) return reply("*Wrong place. This command works in groups only!* 🍀");
    if (!isBotAdmin) return reply("*Bot must be an admin to use this command!* 🛡️");
    if (!isAdmin && !isSuperAdmin && !isSuperUser) return reply("*This command is only for group admins!* 🍉");

    const convertLidToJid = async (lid) => {
      if (!lid || !lid.includes("@lid")) return lid;
      const cached = getLidMapping(lid);
      if (cached) return cached;
      try {
        const result = await sock.getJidFromLid(lid);
        if (result) return result;
      } catch (e) {}
      return lid;
    };

    let targetJid = null;
    let quotedMsgKey = null;

    if (mentionedJid && mentionedJid.length > 0) {
      targetJid = await convertLidToJid(mentionedJid[0]);
    } else if (quotedUser) {
      targetJid = await convertLidToJid(quotedUser);
      if (mek.message?.extendedTextMessage?.contextInfo?.stanzaId) {
        quotedMsgKey = {
          remoteJid: from,
          id: mek.message.extendedTextMessage.contextInfo.stanzaId,
          participant: mek.message.extendedTextMessage.contextInfo.participant,
          fromMe: false,
        };
      }
    } else if (q) {
      const num = q.replace(/[^0-9]/g, "");
      if (num.length >= 10) targetJid = num + "@s.whatsapp.net";
    }

    if (!targetJid || targetJid.includes("@lid")) {
      if (targetJid && targetJid.includes("@lid") && groupMetadata?.participants) {
        const lidNum = targetJid.split("@")[0];
        const found = groupMetadata.participants.find(
          p => p.lid?.split("@")[0] === lidNum || p.id?.split("@")[0] === lidNum
        );
        if (found?.id) targetJid = found.id;
        else if (found?.pn) targetJid = found.pn + "@s.whatsapp.net";
      }
    }

    if (!targetJid || targetJid.includes("@lid")) {
      return reply("Could not identify user. Provide their number.\nExample: .kick 923xxxxxxxxx");
    }

    if (!targetJid.includes("@")) targetJid += "@s.whatsapp.net";

    const targetNum = targetJid.split("@")[0];
    const standardizedSuperUsers = superUser.map(u => u.split("@")[0]);

    if (standardizedSuperUsers.includes(targetNum)) {
      await react("🙅‍♂️");
      return reply("Cannot kick my creator!");
    }

    const botJid = sock.user?.id?.split(":")[0] + "@s.whatsapp.net";
    if (targetJid.toLowerCase() === botJid.toLowerCase()) {
      await react("🙅‍♂️");
      return reply("Cannot kick myself!");
    }

    const groupSuperAdmins = conText.groupSuperAdmins || [];
    const superAdminNums = groupSuperAdmins.map(a => a.split("@")[0]);
    let isSuperAdminTarget = superAdminNums.includes(targetNum);

    if (groupMetadata?.participants) {
      const participant = groupMetadata.participants.find(p => {
        const pNum = (p.id || p.pn || p.phoneNumber || "").split("@")[0];
        return pNum === targetNum || (p.pn || "").split("@")[0] === targetNum;
      });
      if (participant?.admin === "superadmin") isSuperAdminTarget = true;
    }

    if (isSuperAdminTarget) {
      await react("🙅‍♂️");
      return await sock.sendMessage(from, {
        text: `@${targetNum} is the group owner and cannot be kicked.`,
        mentions: [targetJid],
      });
    }

    try {
      if (quotedMsgKey) {
        try {
          await sock.sendMessage(from, {
            delete: quotedMsgKey,
          });
        } catch (delErr) {
          console.error("[kick] message delete failed:", delErr.message);
        }
      }

      await sock.groupParticipantsUpdate(from, [targetJid], "remove");

      await sock.sendMessage(from, {
        text: `@${targetNum} has been removed from the group.`,
        mentions: [targetJid],
      });

    } catch (e) {
      await react("🙅‍♂️");
      if (e.message?.includes("403") || e.message?.toLowerCase().includes("forbidden")) {
        await sock.sendMessage(from, {
          text: `Cannot kick @${targetNum}. They may be an admin or not in the group.`,
          mentions: [targetJid],
        });
      } else {
        return reply(`Failed to remove user: ${e.message}`);
      }
    }
  },
);

cmd(
  {
    pattern: "add",
    react: "➕",
    category: "group",
    description: "Add a user to the group.",
  },
  async (from, sock, conText) => {
    const {
      reply, react, isSuperAdmin, isAdmin, isSuperUser,
      isGroup, isBotAdmin, q, mek, groupMetadata,
    } = conText;

    if (!isGroup) return reply("*Wrong place. This command works in groups only!* 🍀");
    if (!isBotAdmin) return reply("*Bot must be an admin to use this command!* 🛡️");
    if (!isAdmin && !isSuperAdmin && !isSuperUser) return reply("*This command is only for group admins!* 🍉");

    if (!q) {
      return reply("Please provide the number to add.\nExample: .add 923xxxxxxxxx");
    }

    const num = q.replace(/[^0-9]/g, "");
    if (num.length < 10) {
      await react("🙅‍♂️");
      return reply("Invalid number format.");
    }

    const targetJid = num + "@s.whatsapp.net";

    try {
      const [result] = await sock.onWhatsApp(num);
      if (!result || !result.exists) {
        await react("🙅‍♂️");
        return reply(`${num} is not registered on WhatsApp.`);
      }
    } catch (err) {
      await react("⚠️");
      return reply(`Could not verify if ${num} is on WhatsApp. Try again.`);
    }

    if (groupMetadata?.participants) {
      const alreadyIn = groupMetadata.participants.find(p => {
        const pNum = (p.id || p.pn || p.phoneNumber || "").split("@")[0];
        return pNum === num;
      });
      if (alreadyIn) {
        await react("🙅‍♂️");
        return await sock.sendMessage(from, {
          text: `@${num} is already in this group.`,
          mentions: [targetJid],
        });
      }
    }

    try {
      const result = await sock.groupParticipantsUpdate(from, [targetJid], "add");
      const status = result[0]?.status;

      if (status === "403") {
        const meta = await sock.groupMetadata(from);
        const inviteCode = await sock.groupInviteCode(from);
        const inviteLink = `https://chat.whatsapp.com/${inviteCode}`;

        await sock.sendMessage(targetJid, {
          text: `You have been invited to join *${meta.subject}*\n\nInvite Link: ${inviteLink}`,
        });

        await react("⚠️");
        await sock.sendMessage(from, {
          text: `@${num} has privacy settings preventing direct add. Invite link sent to their DM.`,
          mentions: [targetJid],
        });
      } else if (status === "408") {
        await react("🙅‍♂️");
        await sock.sendMessage(from, {
          text: `@${num} left this group recently and cannot be added yet.`,
          mentions: [targetJid],
        });
      } else if (status === "409") {
        await react("🙅‍♂️");
        await sock.sendMessage(from, {
          text: `@${num} is already in this group.`,
          mentions: [targetJid],
        });
      } else {
        await sock.sendMessage(from, {
          text: `@${num} has been added to the group.`,
          mentions: [targetJid],
        });
      }
    } catch (e) {
      await react("🙅‍♂️");
      return reply(`Failed to add user: ${e.message}`);
    }
  },
);

cmd(
  {
    pattern: "link",
    aliases: ["gclink", "grouplink", "invitelink", "invite"],
    react: "🔗",
    category: "group",
    description: "Get the group invite link.",
  },
  async (from, sock, conText) => {
    const { reply, react, isAdmin, isSuperAdmin, isGroup, isBotAdmin, mek, isSuperUser } = conText;

    if (!isGroup) return reply("*Wrong place. This command works in groups only!* 🍀");
    if (!isBotAdmin) return reply("*Bot must be an admin to use this command!* 🛡️");
    if (!isAdmin && !isSuperAdmin && !isSuperUser) return reply("*This command is only for group admins!* 🍉");

    try {
      const meta = await sock.groupMetadata(from);
      const inviteCode = await sock.groupInviteCode(from);
      const inviteLink = `https://chat.whatsapp.com/${inviteCode}`;
      const adminCount = meta.participants.filter(p => p.admin === "admin" || p.admin === "superadmin").length;

      const text =
        `*Here is Group Invite Link:*\n${inviteLink}`;

      await sock.sendMessage(from, { text });

    } catch (e) {
      await react("🙅‍♂️");
      return reply(`Failed to get invite link: ${e.message}`);
    }
  },
);

cmd(
  {
    pattern: "newgroup",
    aliases: ["newgc", "creategroup"],
    react: "🆕",
    category: "group",
    description: "Create a new group.",
  },
  async (from, sock, conText) => {
    const { reply, react, sender, isSuperUser, q, mek } = conText;

    if (!isSuperUser) return reply("*This area is reserved for the bot owner only.* 🕷️");

    if (!q || !q.trim()) {
      return reply("Please provide a group name.\nExample: .newgroup My Group");
    }

    try {
      const group = await sock.groupCreate(q.trim(), [sender]);
      const inviteCode = await sock.groupInviteCode(group.id);
      const inviteLink = `https://chat.whatsapp.com/${inviteCode}`;

      await sock.sendMessage(from, {
        text:
          `*Group Created!*\n\n` +
          `*Name:* ${q.trim()}\n` +
          `*ID:* ${group.id}\n\n` +
          `*Invite Link:* ${inviteLink}`,
      });

    } catch (e) {
      await react("🙅‍♂️");
      return reply(`Failed to create group: ${e.message}`);
    }
  },
);

cmd(
  {
    pattern: "kickall",
    aliases: ["terminategc", "destroygc", "end"],
    react: "💀",
    category: "group",
    description: "Terminate group - removes all members and bot leaves.",
  },
  async (from, sock, conText) => {
    const { reply, react, sender, isSuperUser, isGroup, isBotAdmin, isAdmin, isSuperAdmin, mek } = conText;

    if (!isGroup) return reply("*Wrong place. This command works in groups only!* 🍀");
    if (!isSuperUser) return reply("*This area is reserved for the bot owner only.* 🕷️");
    if (!isBotAdmin) return reply("*Bot must be an admin to use this command!* 🛡️");
    if (!isAdmin && !isSuperAdmin && !isSuperUser) return reply("*This command is only for group admins!* 🍉");

    try {
      await sock.sendMessage(from, {
        text: `*WARNING*\n\nGroup will be terminated now...\nAll members will be removed.`,
      });

      await new Promise(r => setTimeout(r, 1000));

      const meta = await sock.groupMetadata(from);
      const botJid = sock.user?.id?.split(":")[0] + "@s.whatsapp.net";

      const membersToRemove = meta.participants
        .filter(p => p.id !== botJid && p.id !== sender)
        .map(p => p.id);

      if (membersToRemove.length > 0) {
        await sock.groupParticipantsUpdate(from, membersToRemove, "remove");
      }

      await sock.groupLeave(from);
    } catch (e) {
      await react("🙅‍♂️");
      return reply(`Failed to terminate group: ${e.message}`);
    }
  },
);

cmd(
  {
    pattern: "accept",
    aliases: ["approve"],
    react: "✅",
    category: "group",
    description: "Accept a pending join request.",
  },
  async (from, sock, conText) => {
    const { reply, react, isGroup, isBotAdmin, isAdmin, isSuperAdmin, isSuperUser, args, botPrefix } = conText;

    if (!isGroup) return reply("*Wrong place. This command works in groups only!* 🍀");
    if (!isBotAdmin) return reply("*Bot must be an admin to use this command!* 🛡️");
    if (!isAdmin && !isSuperAdmin && !isSuperUser) return reply("*This command is only for group admins!* 🍉");
    if (!args[0]) return reply(`Please provide a phone number.\nUsage: ${botPrefix}accept 923xxxxxxxxx`);

    try {
      const number = args[0].replace(/[^0-9]/g, "");
      const userJid = `${number}@s.whatsapp.net`;

      await sock.groupRequestParticipantsUpdate(from, [userJid], "approve");

      await sock.sendMessage(from, {
        text: `@${number}'s join request approved!`,
        mentions: [userJid],
      });
    } catch (e) {
      await react("🙅‍♂️");
      if (e.message?.includes("not-found") || e.message?.includes("item-not-found")) {
        return reply("No pending join request found for this number.");
      }
      return reply(`Failed to accept request: ${e.message}`);
    }
  },
);

cmd(
  {
    pattern: "reject",
    aliases: ["decline"],
    react: "🙅‍♂️",
    category: "group",
    description: "Reject a pending join request.",
  },
  async (from, sock, conText) => {
    const { reply, react, isGroup, isBotAdmin, isAdmin, isSuperAdmin, isSuperUser, args, botPrefix } = conText;

    if (!isGroup) return reply("*Wrong place. This command works in groups only!* 🍀");
    if (!isBotAdmin) return reply("*Bot must be an admin to use this command!* 🛡️");
    if (!isAdmin && !isSuperAdmin && !isSuperUser) return reply("*This command is only for group admins!* 🍉");
    if (!args[0]) return reply(`Please provide a phone number.\nUsage: ${botPrefix}reject 923xxxxxxxxx`);

    try {
      const number = args[0].replace(/[^0-9]/g, "");
      const userJid = `${number}@s.whatsapp.net`;

      await sock.groupRequestParticipantsUpdate(from, [userJid], "reject");

      await sock.sendMessage(from, {
        text: `@${number}'s join request rejected!`,
        mentions: [userJid],
      });
    } catch (e) {
      await react("🙅‍♂️");
      if (e.message?.includes("not-found") || e.message?.includes("item-not-found")) {
        return reply("No pending join request found for this number.");
      }
      return reply(`Failed to reject request: ${e.message}`);
    }
  },
);

cmd(
  {
    pattern: "acceptall",
    aliases: ["approveall"],
    react: "✅",
    category: "group",
    description: "Accept all pending join requests.",
  },
  async (from, sock, conText) => {
    const { reply, react, isGroup, isBotAdmin, isAdmin, isSuperAdmin, isSuperUser } = conText;

    if (!isGroup) return reply("*Wrong place. This command works in groups only!* 🍀");
    if (!isBotAdmin) return reply("*Bot must be an admin to use this command!* 🛡️");
    if (!isAdmin && !isSuperAdmin && !isSuperUser) return reply("*This command is only for group admins!* 🍉");

    try {
      const pendingRequests = await sock.groupRequestParticipantsList(from);
      if (!pendingRequests || pendingRequests.length === 0) {
        return reply("No pending join requests in this group.");
      }

      const jids = pendingRequests.map(r => r.jid);
      await sock.groupRequestParticipantsUpdate(from, jids, "approve");

      return reply(`Successfully approved *${jids.length}* pending join request(s)!`);
    } catch (e) {
      await react("🙅‍♂️");
      return reply(`Failed to accept all requests: ${e.message}`);
    }
  },
);

cmd(
  {
    pattern: "rejectall",
    aliases: ["declineall"],
    react: "🙅‍♂️",
    category: "group",
    description: "Reject all pending join requests.",
  },
  async (from, sock, conText) => {
    const { reply, react, isGroup, isBotAdmin, isAdmin, isSuperAdmin, isSuperUser } = conText;

    if (!isGroup) return reply("*Wrong place. This command works in groups only!* 🍀");
    if (!isBotAdmin) return reply("*Bot must be an admin to use this command!* 🛡️");
    if (!isAdmin && !isSuperAdmin && !isSuperUser) return reply("*This command is only for group admins!* 🍉");

    try {
      const pendingRequests = await sock.groupRequestParticipantsList(from);
      if (!pendingRequests || pendingRequests.length === 0) {
        return reply("No pending join requests in this group.");
      }

      const jids = pendingRequests.map(r => r.jid);
      await sock.groupRequestParticipantsUpdate(from, jids, "reject");

      return reply(`Successfully rejected *${jids.length}* pending join request(s)!`);
    } catch (e) {
      await react("🙅‍♂️");
      return reply(`Failed to reject all requests: ${e.message}`);
    }
  },
);

cmd(
  {
    pattern: "online",
    aliases: ["listonline", "whosonline"],
    react: "🟢",
    category: "group",
    description: "List members who are currently online in the group.",
  },
  async (from, sock, conText) => {
    const { reply, react, isGroup, mek } = conText;

    if (!isGroup) return reply("*Wrong place. This command works in groups only!* 🍀");

    try {
      await reply("Checking online members... Please wait...");

      const groupMeta = await sock.groupMetadata(from);
      const participants = groupMeta.participants;
      const onlineMembers = [];
      const presenceData = new Map();

      const presenceHandler = (update) => {
        if (update.presences) {
          for (const [jid, presence] of Object.entries(update.presences)) {
            presenceData.set(jid, presence);
            presenceData.set(jid.split("@")[0], presence);
          }
        }
      };

      sock.ev.on("presence.update", presenceHandler);

      try {
        const batchSize = 5;
        for (let i = 0; i < participants.length; i += batchSize) {
          const batch = participants.slice(i, i + batchSize);
          await Promise.all(batch.map(async p => {
            try { await sock.presenceSubscribe(p.id || p.jid); } catch (e) {}
          }));
          await new Promise(r => setTimeout(r, 500));
        }

        await new Promise(r => setTimeout(r, 2000));

        for (const p of participants) {
          const participantId = p.id || p.jid;
          const numOnly = participantId.split("@")[0];
          let presence = presenceData.get(participantId) || presenceData.get(numOnly);

          if (!presence && p.pn) {
            presence = presenceData.get(p.pn) || presenceData.get(p.pn.split("@")[0]);
          }

          if (["composing", "recording", "available"].includes(presence?.lastKnownPresence)) {
            let displayJid = participantId;
            if (participantId.endsWith("@lid")) {
              const cachedJid = getLidMapping(participantId);
              if (cachedJid) displayJid = cachedJid;
              else if (p.pn) displayJid = p.pn;
            }
            const number = displayJid.split("@")[0];
            onlineMembers.push({ jid: displayJid, name: p.notify || p.name || number, number });
          }
        }
      } finally {
        sock.ev.off("presence.update", presenceHandler);
      }

      if (onlineMembers.length === 0) {
        await react("😴");
        return reply("No members are currently typing or recording.");
      }

      const mentions = onlineMembers.map(m => m.jid);
      const memberList = onlineMembers.map((m, i) => `${i + 1}. @${m.number}`).join("\n");

      await sock.sendMessage(from, {
        text:
          `*Active Members*\n\n` +
          `${onlineMembers.length} of ${participants.length} members active\n\n` +
          `${memberList}`,
        mentions,
      });
    } catch (e) {
      await react("🙅‍♂️");
      return reply(`Failed to check online members: ${e.message}`);
    }
  },
);

cmd(
  {
    pattern: "resetlink",
    aliases: ["resetgclink", "revoke", "resetgrouplink", "revokelink", "newlink"],
    react: "🔄",
    category: "group",
    description: "Reset the group invite link.",
  },
  async (from, sock, conText) => {
    const { reply, react, isGroup, isBotAdmin, isAdmin, isSuperAdmin, isSuperUser, mek } = conText;

    if (!isGroup) return reply("*Wrong place. This command works in groups only!* 🍀");
    if (!isBotAdmin) return reply("*Bot must be an admin to use this command!* 🛡️");
    if (!isAdmin && !isSuperAdmin && !isSuperUser) return reply("*This command is only for group admins!* 🍉");

    try {
      await sock.groupRevokeInvite(from);
      const newInviteCode = await sock.groupInviteCode(from);
      const newLink = `https://chat.whatsapp.com/${newInviteCode}`;
      const groupMeta = await sock.groupMetadata(from);
      const adminCount = groupMeta.participants.filter(p => p.admin === "admin" || p.admin === "superadmin").length;

      await sock.sendMessage(from, {
        text:
          `*Group Link Reset*\n\n` +
          `*Group:* ${groupMeta.subject}\n` +
          `*Total Members:* ${groupMeta.participants.length}\n` +
          `*Total Admins:* ${adminCount}\n\n` +
          `*New Link:*\n${newLink}\n\n` +
          `Old invite link has been revoked.`,
      });
    } catch (e) {
      await react("🙅‍♂️");
      return reply(`Failed to reset group link: ${e.message}`);
    }
  },
);

cmd(
  {
    pattern: "left",
    aliases: ["leave", "exitgroup", "exitgc"],
    react: "👋",
    category: "group",
    description: "Bot leaves the group. Owner only.",
  },
  async (from, sock, conText) => {
    const { reply, react, isGroup, isSuperUser, mek, botName } = conText;

    if (!isGroup) return reply("*Wrong place. This command works in groups only!* 🍀");
    if (!isSuperUser) return reply("*This area is reserved for the bot owner only.* 🕷️");

    try {
      await sock.sendMessage(from, {
        text: `Goodbye! I'm leaving this group...`,
      });

      await new Promise(r => setTimeout(r, 1000));
      await sock.groupLeave(from);
    } catch (e) {
      await react("🙅‍♂️");
      return reply(`Failed to leave group: ${e.message}`);
    }
  },
);

cmd(
  {
    pattern: "listrequests",
    aliases: ["joinrequests", "requests", "pendingrequests"],
    react: "📋",
    category: "group",
    description: "List all pending join requests.",
  },
  async (from, sock, conText) => {
    const { reply, react, isGroup, isBotAdmin, isAdmin, isSuperAdmin, isSuperUser, mek } = conText;

    if (!isGroup) return reply("*Wrong place. This command works in groups only!* 🍀");
    if (!isBotAdmin) return reply("*Bot must be an admin to use this command!* 🛡️");
    if (!isAdmin && !isSuperAdmin && !isSuperUser) return reply("*This command is only for group admins!* 🍉");

    try {
      const pendingRequests = await sock.groupRequestParticipantsList(from);
      if (!pendingRequests || pendingRequests.length === 0) {
        await react("📭");
        return reply("No pending join requests in this group.");
      }

      const resolvedJids = await Promise.all(
        pendingRequests.map(async r => {
          let jid = r.jid;
          if (jid.endsWith("@lid")) {
            const cachedJid = getLidMapping(jid);
            if (cachedJid) {
              jid = cachedJid;
            } else if (sock.getJidFromLid) {
              try {
                const resolved = await sock.getJidFromLid(jid);
                if (resolved) jid = resolved;
              } catch {}
            }
          }
          return jid;
        })
      );

      const requestList = resolvedJids.map((jid, i) => `${i + 1}. @${jid.split("@")[0]}`).join("\n");

      await sock.sendMessage(from, {
        text:
          `*Pending Join Requests*\n\n` +
          `Total: *${pendingRequests.length}* request(s)\n\n` +
          `${requestList}\n\n` +
          `Use .accept <number> or .acceptall to approve\n` +
          `Use .reject <number> or .rejectall to decline`,
        mentions: resolvedJids,
      });
    } catch (e) {
      await react("🙅‍♂️");
      return reply(`Failed to list requests: ${e.message}`);
    }
  },
);

cmd(
  {
    pattern: "groupname",
    aliases: ["gcname", "setgcname", "setgroupname", "gcsubject", "setgcsubject"],
    react: "✏️",
    category: "group",
    description: "Change group name.",
  },
  async (from, sock, conText) => {
    const { reply, react, isGroup, isBotAdmin, isAdmin, isSuperAdmin, isSuperUser, q, botPrefix } = conText;

    if (!isGroup) return reply("*Wrong place. This command works in groups only!* 🍀");
    if (!isBotAdmin) return reply("*Bot must be an admin to use this command!* 🛡️");
    if (!isAdmin && !isSuperAdmin && !isSuperUser) return reply("*This command is only for group admins!* 🍉");
    if (!q) return reply(`Please provide a new group name.\nUsage: ${botPrefix}groupname New Name`);

    try {
      await sock.groupUpdateSubject(from, q);

      return reply(`Group name changed to: *${q}*`);
    } catch (e) {
      await react("🙅‍♂️");
      return reply(`Failed to change group name: ${e.message}`);
    }
  },
);

cmd(
  {
    pattern: "gcdesc",
    aliases: ["groupdesc", "setgcdesc", "setgroupdesc", "description", "setdescription"],
    react: "📝",
    category: "group",
    description: "Change group description.",
  },
  async (from, sock, conText) => {
    const { reply, react, isGroup, isBotAdmin, isAdmin, isSuperAdmin, isSuperUser, q, botPrefix } = conText;

    if (!isGroup) return reply("*Wrong place. This command works in groups only!* 🍀");
    if (!isBotAdmin) return reply("*Bot must be an admin to use this command!* 🛡️");
    if (!isAdmin && !isSuperAdmin && !isSuperUser) return reply("*This command is only for group admins!* 🍉");
    if (!q) return reply(`Please provide a new description.\nUsage: ${botPrefix}gcdesc New Description`);

    try {
      await sock.groupUpdateDescription(from, q);

      return reply(`Group description updated successfully!`);
    } catch (e) {
      await react("🙅‍♂️");
      return reply(`Failed to change group description: ${e.message}`);
    }
  },
);


cmd(
{
pattern: "everyone",
react: "📢",
aliases: ["mentions"],
category: "group",
description: "Tag everyone in the group with custom message",
},
async (from, sock, conText) => {
const {
reply,
isAdmin,
isSuperAdmin,
isSuperUser,
isGroup,
mek,
q,
participants,
sender,
botName,
newsletterJid,
} = conText;

if (!isGroup) {  
  return reply("*Wrong place. This command works in groups only!* 🍀");  
}  

if (!isAdmin && !isSuperAdmin && !isSuperUser) {
      return await sock.sendMessage(from, {
        text: `*This command is only for group admins!* 🍉`,
        mentions: [sender],
      });
    }

const subject = q || "everyone";  
const mentionedJids = participants  
  .map((p) => {  
    const jid =  
      typeof p === "string"  
        ? p  
        : p.id || p.jid || p.pn || p.phoneNumber || "";  
    if (!jid) return null;  
    return jid.includes("@") ? jid : `${jid}@s.whatsapp.net`;  
  })  
  .filter(Boolean);  

try {

  await sock.sendMessage(from, {
    text: `@${from}`,
    contextInfo: {
      mentionedJid: mentionedJids,
      groupMentions: [
        {
          groupJid: from,
          groupSubject: subject,
        },
      ],
    },
  });

} catch (error) {
  console.error("Tag custom error:", error);
  return reply(`🙅‍♂️ Failed to tag custom: ${error.message}`);
}
},
);



cmd(
  {
    pattern: "hidetag",
    react: "📢",
    aliases: ["htag", "tag", "hidtag"],
    category: "group",
    description: "Send a message that secretly tags everyone",
  },
  async (from, sock, conText) => {
    const {
      reply,
      isAdmin,
      isSuperAdmin,
      isSuperUser,
      isGroup,
      q,
      sender,
      mek,
      quoted,
      quotedMsg,
      botPrefix,
    } = conText;

    if (!isGroup)
      return reply("*Wrong place. This command works in groups only!* 🍀");

    if (!isAdmin && !isSuperAdmin && !isSuperUser) {
      return sock.sendMessage(from, {
        text: "*This command is only for group admins!* 🍉",
        mentions: [sender],
      });
    }

    try {
      const meta = await sock.groupMetadata(from);
      const mentions = meta.participants.map((p) => p.id);

      // ─── QUOTED MESSAGE ───────────────────────────────────────────
      if (quoted && quotedMsg) {

        // Har possible parent message type se contextInfo?.quotedMessage nikalo
        const msgTypes = [
          "extendedTextMessage",
          "imageMessage",
          "videoMessage",
          "audioMessage",
          "documentMessage",
          "stickerMessage",
          "buttonsMessage",
          "interactiveMessage",
          "orderMessage",
          "requestPaymentMessage",
          "contactMessage",
          "contactsArrayMessage",
          "stickerPackMessage",
          "eventMessage",
          "pollCreationMessage",
          "pollCreationMessageV2",
          "pollCreationMessageV3",
          "callLogMesssage",  // typo WhatsApp ki hai, same rakho
          "conversation",
        ];

        let rawQuoted = null;
        for (const t of msgTypes) {
          rawQuoted = mek.message?.[t]?.contextInfo?.quotedMessage;
          if (rawQuoted) break;
        }

        if (rawQuoted) {
          const type = Object.keys(rawQuoted)[0];

          if (rawQuoted[type]) {
            // mentionedJid inject karo
            rawQuoted[type].contextInfo = {
              ...(rawQuoted[type].contextInfo || {}),
              mentionedJid: mentions,
            };

            // Extra text override
            if (q) {
              if ("caption" in rawQuoted[type]) {
                rawQuoted[type].caption = q;
              } else if ("text" in rawQuoted[type]) {
                rawQuoted[type].text = q;
              } else if (type === "conversation") {
                rawQuoted[type] = q; // conversation string hai object nahi
              }
            }
          }

          return await sock.relayMessage(from, rawQuoted, {});
        }

        // ─── Fallback: sendMessage ────────────────────────────────
        const buffer = await quoted.download().catch(() => null);
        const text = q || "";

        if (quotedMsg.imageMessage && buffer)
          return await sock.sendMessage(from, { image: buffer, caption: text, mentions });

        if (quotedMsg.videoMessage && buffer)
          return await sock.sendMessage(from, { video: buffer, caption: text, mentions });

        if (quotedMsg.audioMessage && buffer)
          return await sock.sendMessage(from, {
            audio: buffer,
            mimetype: quotedMsg.audioMessage.mimetype,
            ptt: quotedMsg.audioMessage.ptt || false,
          });

        if (quotedMsg.documentMessage && buffer)
          return await sock.sendMessage(from, {
            document: buffer,
            mimetype: quotedMsg.documentMessage.mimetype,
            fileName: quotedMsg.documentMessage.fileName || "file",
            caption: text,
            mentions,
          });

        if (quotedMsg.stickerMessage && buffer)
          return await sock.sendMessage(from, { sticker: buffer });

        // Last resort: text only
        return await sock.sendMessage(from, { text: text || "\u200b", mentions });
      }

      // ─── NO QUOTE: plain text ─────────────────────────────────────
      if (!q) {
        return reply(
          `Please provide a message or reply to one.\nUsage: ${botPrefix}hidetag Your message`
        );
      }

      return await sock.sendMessage(from, { text: q, mentions });

    } catch (e) {
      console.error("[hidetag]", e);
      return reply(`Failed to send hidden tag: ${e.message}`);
    }
  }
);


cmd(
  {
    pattern: "tagall",
    react: "📢",
    aliases: ["mentionall"],
    category: "group",
    description: "Tag all group members",
  },
  async (from, sock, conText) => {
    const {
      reply,
      react,
      isAdmin,
      isSuperAdmin,
      isGroup,
      isSuperUser,
      sender,
      q,
      botName,
    } = conText;

    if (!isGroup)
      return reply("*Wrong place. This command works in groups only!* 🍀");

    if (!isAdmin && !isSuperAdmin && !isSuperUser)
      return reply("*This command is only for group admins!* 🍉");

    try {
      const meta = await sock.groupMetadata(from);
      const participants = meta.participants || [];

      const superAdmins = participants
        .filter((p) => p.admin === "superadmin")
        .map((p) => p.id);

      const admins = participants
        .filter((p) => p.admin === "admin")
        .map((p) => p.id);

      const members = participants
        .filter((p) => !p.admin)
        .map((p) => p.id);

      const sortedParticipants = [
        ...superAdmins,
        ...admins,
        ...members,
      ];

      const mentions = [
        ...new Set([...sortedParticipants, sender]),
      ];

      const emojis = ["❤️", "💀", "🌚", "🌟", "🔥", "❤️‍🩹", "🌸", "🍁", "🍂", "🦋", "🍥", "🍧", "🍨", "🍫", "🍭", "🎀", "🎐", "🎗️", "👑", "🚩", "🇵🇰", "🍓", "🍇", "🧃", "🗿", "🎋", "💸", "🌷", "🪀", "👀", "🤍", "🖤", "🫂", "🌋", "🔥", "⚡", "🌏", "🌗", "🐍", "🐣", "🍉", "🍬", "🚀", "✈️", "🎈", "🎗️", "🎃", "🧩", "👾", "🧸"];

      let text = ``;

      if (q && q.trim()) {
        text += `💬 Message: ${q.trim()}\n`;
      }

      text += `👤 Tagged By: @${sender.split("@")[0]}\n\n`;

      text += `╭┈──✪〘 MENTIONS 〙✪───\n`;

      let count = 1;

      for (const id of sortedParticipants) {
        const emoji =
          emojis[Math.floor(Math.random() * emojis.length)];

        text += `│${emoji} ${count}. @${id.split("@")[0]}\n`;

        count++;
      }

      text += `╰───────────────✪`;

      await sock.sendMessage(from, {
        text,
        mentions,
      });

    } catch (e) {
      console.error(e);

      return reply(`Failed to tag all: ${e.message}`);
    }
  },
);

cmd(
  {
    pattern: "tagadmins",
    react: "👮",
    aliases: ["taggcadmins", "taggroupadmins"],
    category: "group",
    description: "Tag all group admins",
  },
  async (from, sock, conText) => {
    const {
      reply,
      react,
      isAdmin,
      isSuperAdmin,
      isGroup,
      isSuperUser,
      sender,
      q,
      botName,
    } = conText;

    if (!isGroup)
      return reply("*Wrong place. This command works in groups only!* 🍀");

    if (!isAdmin && !isSuperAdmin && !isSuperUser)
      return reply("*This command is only for group admins!* 🍉");

    try {
      const meta = await sock.groupMetadata(from);
      const participants = meta.participants || [];

      const superAdmins = participants
        .filter((p) => p.admin === "superadmin")
        .map((p) => p.id);

      const admins = participants
        .filter((p) => p.admin === "admin")
        .map((p) => p.id);

      const allAdmins = [
        ...superAdmins,
        ...admins,
      ];

      if (allAdmins.length === 0)
        return reply("No admins found in this group!");

      const mentions = [
        ...new Set([...allAdmins, sender]),
      ];

      const emojis = ["❤️", "💀", "🌚", "🌟", "🔥", "❤️‍🩹", "🌸", "🍁", "🍂", "🦋", "🍥", "🍧", "🍨", "🍫", "🍭", "🎀", "🎐", "🎗️", "👑", "🚩", "🇵🇰", "🍓", "🍇", "🧃", "🗿", "🎋", "💸", "🌷", "🪀", "👀", "🤍", "🖤", "🫂", "🌋", "🔥", "⚡", "🌏", "🌗", "🐍", "🐣", "🍉", "🍬", "🚀", "✈️", "🎈", "🎗️", "🎃", "🧩", "👾", "🧸"];

      let text = ``;

      if (q && q.trim()) {
        text += `💬 Message: ${q.trim()}\n`;
      }

      text += `👤 Tagged By: @${sender.split("@")[0]}\n\n`;

      text += `╭┈──✪〘 ADMINS 〙✪───\n`;

      let count = 1;

      for (const id of superAdmins) {
        const emoji =
          emojis[Math.floor(Math.random() * emojis.length)];

        text += `│${emoji} ${count}. @${id.split("@")[0]}\n`;

        count++;
      }

      for (const id of admins) {
        const emoji =
          emojis[Math.floor(Math.random() * emojis.length)];

        text += `│${emoji} ${count}. @${id.split("@")[0]}\n`;

        count++;
      }

      text += `╰───────────────✪`;

      await sock.sendMessage(from, {
        text,
        mentions,
      });

    } catch (e) {
      console.error(e);

      return reply(`Failed to tag admins: ${e.message}`);
    }
  },
);
