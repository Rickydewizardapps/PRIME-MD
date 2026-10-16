const { cmd } = require("../lib");
const cyber = require("../lib/cyber");
const isYT = (s) => /(youtube\.com|youtu\.be)/i.test(s);

cmd(
  {
    pattern: "play",
    aliases: ["song", "mp3", "audio"],
    category: "downloader",
    react: "🎶",
    description: "Download audio from YouTube",
  },
  async (from, sock, conText) => {
    const { reply, react, q, msg, m } = conText;
    const currentMsg = msg || m;
    if (!q) return reply("🎵 Usage: `.play <song name or YouTube URL>`");
    try {
      if (react) await react("🔍");
      let ytUrl = q, info = null;
      if (!isYT(q)) {
        info = await cyber.search(q);
        if (!info) return reply("❌ No results found.");
        ytUrl = info.url;
      } else {
        info = await cyber.search(q).catch(() => null);
      }
      await sock.sendMessage(from, {
        audio: { url: cyber.audioUrl(ytUrl) },
        mimetype: "audio/mp4",
        fileName: info ? `${info.title}.m4a` : "audio.m4a",
      }, { quoted: currentMsg });
      if (react) await react("✅");
    } catch (e) {
      console.error("[PLAY]", e.message);
      await reply(`❌ Error: ${e.message}`);
    }
  }
);

cmd(
  {
    pattern: "playvideo",
    aliases: ["video", "mp4", "ytv"],
    category: "downloader",
    react: "🎬",
    description: "Download video from YouTube",
  },
  async (from, sock, conText) => {
    const { reply, react, q, msg, m } = conText;
    const currentMsg = msg || m;
    if (!q) return reply("🎬 Usage: `.playvideo <song name or YouTube URL>`");
    try {
      if (react) await react("🔍");
      let ytUrl = q, info = null;
      if (!isYT(q)) {
        info = await cyber.search(q);
        if (!info) return reply("❌ No results found.");
        ytUrl = info.url;
      } else {
        info = await cyber.search(q).catch(() => null);
      }
      await sock.sendMessage(from, {
        video: { url: cyber.videoUrl(ytUrl) },
        mimetype: "video/mp4",
        caption: info ? `🎬 *${info.title}*\n${info.author || ""}` : "",
      }, { quoted: currentMsg });
      if (react) await react("✅");
    } catch (e) {
      console.error("[PLAYVIDEO]", e.message);
      await reply(`❌ Error: ${e.message}`);
    }
  }
);
