# PRIME-MD – fixes & additions

Edit the readable code in `src/` and run `npm run build:obfuscate` to regenerate the root files.

## Ownership / security
- The paired (bot) number is now ALWAYS the owner (`fromMe` = superuser), on both PN and LID JIDs.
- Removed the hardcoded developer number (254757047860) from: superuser list, pause switch,
  updater, sudo protection, auto-kick/antiporn exemptions. All go through `lib/devNumbers.js`,
  which is EMPTY unless you set `DEV_NUMBERS=2547...,2547...` in the environment.
- While the bot is paused (`BOT_PAUSED`), the owner is no longer locked out.

## Antidelete
- Fixed message store losing Buffers -> deleted images/video/audio/stickers can now be recovered
  (old rows are read back correctly too). Uses reuploadRequest for expired media.
- `antidelete` command in PRIME plugin format: `on/off/status`, `inbox|inchat|chats|<jid>`,
  `notification <text>`, `groupinfo on/off`, `media on/off`, `inbox on/off`.
- No alerts for: your own deletions, newsletters/broadcasts, or the bot's own chat.

## Status view / like / save
- View, like and reply are independent (like no longer needs view). `autolikestatus emojis 💚 💔`.
- Every status in a batch is handled (was only the first); own JID added to `statusJidList`,
  `fromMe` in keys, `participantPn` preferred (as in reference bot).
- Status SAVE no longer fires on the bot's own auto-like reactions, and now works when the
  paired number reacts.

## Core
- All handlers process every message in a batch; `@lid` DMs recognised; autobio toggles live;
  `/` route fixed; menu RAM unit; `>.` double-prefix typo in usage texts.
- Crash fixes: `reply` undefined (anti-porn, auto-kick, banSystem), `isSuperAdmin` (antibot),
  `botPrefix` (notes), `tempFilePath` (pp), fancy font duplicate key.
- Missing dependencies added: jszip, megajs, node-webpmux, compile-run, performance-now, pdfkit, qrcode-reader.
- 22 duplicate command names removed / de-conflicted.

## Commands added (`plugins/zz_prime-plugin_*.js`, via `lib/primeCompat.js`)
~190 commands + aliases (AI, coding, convert, download, group, owner, search, stalk, sticker, utility...).
the plugins' API base can be overridden with `KEITH_API`.
NOT ported on purpose: WhatsApp crash-bug commands, adult content commands, `eval`/`shell`,
and reference bot-database-only ones (`autosocialdl`, `greet`, `gtcdd`, `sprpp`).

## Auto-join & access (update)
- On every connect the bot follows your channel (120363425343959199@newsletter) and joins your group
  (invite K4NlCab4A9M84mX8ckDyYE, group 120363411834397411@g.us). The three third-party channels that were
  auto-followed were removed. Override with env `NEWSLETTER_JID`, `GC_INVITE`, `GC_JID`.
- The channel link is filled in automatically from WhatsApp if it is still the old default.
- Superusers (paired number, owner, sudo) bypass private/groups mode for every command; matching is done on
  normalised numbers so device suffixes / JID formats can't cause misses.

## Update: cleanup & fixes
- Removed third-party branding/details: keithai, KeithSite/repo/pair commands, `test` (remote HTML template), developer
  contacts (now 254757047860 and 254738884657), example numbers, remote GitHub fetches, promo links.
- Internal names renamed (pcmd, pickRandom, ...). API host is now `PLUGIN_API` (env) and stored encoded.
- Removed the `rc` clothes-removal command. `undress.js` was NOT modified.
- delete: fixed (raw participant key for LID groups, works in DMs, replies on errors, reacts on success).
- AI commands (claudeai, mistral, bard, ...) fall back to PRIME's own AI backend when the primary API fails.
- Status save: only owner/paired number can trigger; saved status is always sent to the owner's DM.
