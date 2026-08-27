const { cmd, copyFolderSync } = require("../lib");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

// === Private Repo Config ===
const GITHUB_OWNER = process.env.GITHUB_OWNER || "ali-feki";
const GITHUB_REPO  = process.env.GITHUB_REPO  || "PRIME-MD-BOT";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN  || "";

const GH_HEADERS = {
  "User-Agent": "node.js",
  Accept: "application/vnd.github+json",
  ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
};

// ─── Version Check Helper ───────────────────────────────────────────
async function getLatestCommit() {
  const { data } = await axios.get(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits/${GITHUB_BRANCH}`,
    { headers: GH_HEADERS }
  );
  return data;
}

// ─── .update — sirf check karo ─────────────────────────────────────
cmd(
  {
    pattern: "update",
    react: "🔍",
    category: "owner",
    description: "Check if bot update is available.",
  },
  async (from, sock, conText) => {
    const { reply, react, isSuperUser, getCommitHash } = conText;

    if (!isSuperUser) {
      await react("🙅‍♂️");
      return reply("🙅‍♂️ Owner Only Command!");
    }

    try {
      await reply("🔍 Checking for updates...");

      const commitData = await getLatestCommit();
      const latestHash = commitData.sha;
      const currentHash = await getCommitHash().catch(() => null);

      const authorName  = commitData.commit.author.name;
      const commitDate  = new Date(commitData.commit.author.date).toLocaleString();
      const commitMsg   = commitData.commit.message;
      const shortLatest = latestHash.slice(0, 7);
      const shortCurrent = currentHash ? currentHash.slice(0, 7) : "unknown";

      if (latestHash === currentHash) {
        return reply(
          `✅ *Bot is up to date!*\n\n` +
          `📦 Version: \`${shortLatest}\`\n` +
          `👤 Author: ${authorName}\n` +
          `📅 Date: ${commitDate}\n` +
          `💬 ${commitMsg}`
        );
      }

      return reply(
        `🆕 *Update Available!*\n\n` +
        `📦 Current:  \`${shortCurrent}\`\n` +
        `🚀 Latest:   \`${shortLatest}\`\n\n` +
        `👤 Author: ${authorName}\n` +
        `📅 Date: ${commitDate}\n` +
        `💬 ${commitMsg}\n\n` +
        `➡️ Run *.update now* to update`
      );

    } catch (e) {
      console.error("[update check]", e.message);
      await react("🙅‍♂️");
      return reply(`🙅‍♂️ Failed to check update:\n${e.message}`);
    }
  }
);

// ─── .update now — download & apply ────────────────────────────────
cmd(
  {
    pattern: "update now",
    aliases: ["updatenow", "updt", "sync"],
    react: "🆕",
    category: "owner",
    description: "Update the bot to the latest version.",
  },
  async (from, sock, conText) => {
    const { reply, react, isSuperUser, getCommitHash, setCommitHash } = conText;

    if (!isSuperUser) {
      await react("🙅‍♂️");
      return reply("🙅‍♂️ Owner Only Command!");
    }

    try {
      await reply("🔍 Checking for updates...");

      const commitData  = await getLatestCommit();
      const latestHash  = commitData.sha;
      const currentHash = await getCommitHash().catch(() => null);

      const authorName = commitData.commit.author.name;
      const commitDate = new Date(commitData.commit.author.date).toLocaleString();
      const commitMsg  = commitData.commit.message;

      if (latestHash === currentHash) {
        return reply("✅ Bot is already on the latest version!");
      }

      await reply(
        `🔄 *Starting Update...*\n\n` +
        `👤 Author: ${authorName}\n` +
        `📅 Date: ${commitDate}\n` +
        `💬 ${commitMsg}`
      );

      // Download zip (private repo ke liye token header zaroori)
      const zipUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/zipball/${GITHUB_BRANCH}`;
      const zipPath = path.join(__dirname, "..", `${GITHUB_REPO}-update.zip`);

      const { data: zipData } = await axios.get(zipUrl, {
        responseType: "arraybuffer",
        headers: GH_HEADERS,
      });

      fs.writeFileSync(zipPath, zipData);
      await reply("📦 Downloaded. Extracting...");

      const extractPath = path.join(__dirname, "..", "latest_update");
      if (fs.existsSync(extractPath)) fs.rmSync(extractPath, { recursive: true, force: true });

      const zip = new AdmZip(zipPath);
      zip.extractAllTo(extractPath, true);

      // GitHub zipball mein ek folder hota hai e.g. "ali-feki-stark-pro-abc1234"
      const dirs = fs.readdirSync(extractPath).filter(f =>
        fs.statSync(path.join(extractPath, f)).isDirectory()
      );

      if (!dirs.length) throw new Error("Extracted folder not found");

      const sourcePath      = path.join(extractPath, dirs[0]);
      const destinationPath = path.join(__dirname, "..");

      const excludeList = [
        ".env",
        "lib/database/database.db",
        "lib/session/session.db",
        "config.js",
      ];

      copyFolderSync(sourcePath, destinationPath, excludeList);
      await setCommitHash(latestHash);

      // Cleanup
      fs.unlinkSync(zipPath);
      fs.rmSync(extractPath, { recursive: true, force: true });

      await reply("✅ *Update Complete!* Bot is restarting...");

      setTimeout(() => process.exit(0), 2000);

    } catch (e) {
      console.error("[update now]", e.message);
      await react("🙅‍♂️");
      return reply(`🙅‍♂️ Update Failed:\n${e.message}`);
    }
  }
);

cmd(
  {
    pattern: "restart",
    aliases: ["reboot", "reloadbot"],
    react: "🔄",
    category: "owner",
    description: "Restart the bot.",
  },
  async (from, sock, conText) => {
    const { reply, react, isSuperUser, mek } = conText;

    if (!isSuperUser) {
      await react("🙅‍♂️");
      return reply("🙅‍♂️ Owner Only Command!");
    }

    try {
      await sock.sendMessage(from, {
        text: "🔄 *Restarting Bot...*\n\nPlease wait a moment.",
      }, { quoted: mek });

      setTimeout(() => process.exit(0), 2000);

    } catch (e) {
      console.error("[restart]", e);
      return reply(`🙅‍♂️ Restart failed: ${e.message}`);
    }
  }
);

cmd(
  {
    pattern: "reboot",
    aliases: ["hardreboot", "forcerestart"],
    react: "⚡",
    category: "owner",
    description: "Force reboot the bot (immediate).",
  },
  async (from, sock, conText) => {
    const { reply, react, isSuperUser, mek } = conText;

    if (!isSuperUser) {
      await react("🙅‍♂️");
      return reply("🙅‍♂️ Owner Only Command!");
    }

    try {
      await sock.sendMessage(from, {
        text: "⚡ *Force Rebooting...*\n\nBot will be back in seconds.",
      }, { quoted: mek });

      setTimeout(() => process.exit(1), 1000);

    } catch (e) {
      console.error("[reboot]", e);
      process.exit(1);
    }
  }
);
