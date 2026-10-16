const { cmd } = require("../lib");
const cyber = require("../lib/cyber");

// ───── Facebook ─────
cmd(
  { pattern: "facebook", aliases: ["fb", "fbdl"], category: "downloader",
    react: "📥", description: "Download Facebook video" },
  async (from, sock, conText) => {
    const { reply, react, q, msg, m } = conText;
    const cur = msg || m;
    if (!q) return reply("📥 Usage: `.fb <facebook url>`");
    try {
      if (react) await react("🔍");
      const url = await cyber.facebook(q);
      if (!url) return reply("❌ Failed to fetch Facebook video.");
      await sock.sendMessage(from, { video: { url }, mimetype: "video/mp4" }, { quoted: cur });
      if (react) await react("✅");
    } catch (e) { console.error("[FB]", e.message); await reply(`❌ ${e.message}`); }
  }
);

// ───── Instagram ─────
cmd(
  { pattern: "instagram", aliases: ["ig", "igdl"], category: "downloader",
    react: "📥", description: "Download Instagram media" },
  async (from, sock, conText) => {
    const { reply, react, q, msg, m } = conText;
    const cur = msg || m;
    if (!q) return reply("📥 Usage: `.ig <instagram url>`");
    try {
      if (react) await react("🔍");
      const urls = await cyber.instagram(q);
      if (!urls || !urls.length) return reply("❌ Failed to fetch Instagram media.");
      for (const u of urls.slice(0, 5)) {
        const isVideo = /\.mp4|video/i.test(u);
        await sock.sendMessage(from, isVideo
          ? { video: { url: u }, mimetype: "video/mp4" }
          : { image: { url: u } },
          { quoted: cur });
      }
      if (react) await react("✅");
    } catch (e) { console.error("[IG]", e.message); await reply(`❌ ${e.message}`); }
  }
);

// ───── TikTok ─────
cmd(
  { pattern: "tiktok", aliases: ["tt", "ttdl"], category: "downloader",
    react: "📥", description: "Download TikTok video" },
  async (from, sock, conText) => {
    const { reply, react, q, msg, m } = conText;
    const cur = msg || m;
    if (!q) return reply("📥 Usage: `.tt <tiktok url>`");
    try {
      if (react) await react("🔍");
      const d = await cyber.tiktok(q);
      if (!d?.video) return reply("❌ Failed to fetch TikTok video.");
      await sock.sendMessage(from, {
        video: { url: d.video },
        mimetype: "video/mp4",
        caption: d.title ? `🎵 ${d.title}` : "",
      }, { quoted: cur });
      if (react) await react("✅");
    } catch (e) { console.error("[TT]", e.message); await reply(`❌ ${e.message}`); }
  }
);

// ───── YouTube (delegates to play logic) ─────
cmd(
  { pattern: "song", aliases: ["play2", "ytmp3"], category: "downloader",
    react: "🎶", description: "Download YouTube audio" },
  async (from, sock, conText) => {
    const { reply, react, q, msg, m } = conText;
    const cur = msg || m;
    if (!q) return reply("🎵 Usage: `.song <name or URL>`");
    try {
      if (react) await react("🔍");
      let url = q;
      if (!/(youtube\.com|youtu\.be)/i.test(q)) {
        const s = await cyber.search(q);
        if (!s) return reply("❌ No results.");
        url = s.url;
      }
      const audio = await cyber.ytmp3(url);
      if (!audio) return reply("❌ Failed to fetch audio.");
      await sock.sendMessage(from, { audio: { url: audio }, mimetype: "audio/mp4" }, { quoted: cur });
      if (react) await react("✅");
    } catch (e) { console.error("[SONG]", e.message); await reply(`❌ ${e.message}`); }
  }
);

cmd(
  { pattern: "video2", aliases: ["ytmp4", "ytv"], category: "downloader",
    react: "🎬", description: "Download YouTube video" },
  async (from, sock, conText) => {
    const { reply, react, q, msg, m } = conText;
    const cur = msg || m;
    if (!q) return reply("🎬 Usage: `.video2 <name or URL>`");
    try {
      if (react) await react("🔍");
      let url = q;
      if (!/(youtube\.com|youtu\.be)/i.test(q)) {
        const s = await cyber.search(q);
        if (!s) return reply("❌ No results.");
        url = s.url;
      }
      const video = await cyber.ytmp4(url);
      await sock.sendMessage(from, { video: { url: video }, mimetype: "video/mp4" }, { quoted: cur });
      if (react) await react("✅");
    } catch (e) { console.error("[VIDEO2]", e.message); await reply(`❌ ${e.message}`); }
  }
);
