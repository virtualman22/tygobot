const { Events, PermissionsBitField } = require('discord.js');
const { db, getSettings } = require('../db');
const { levelFromXp } = require('../utils');
const { SCREENSHOT_CATEGORIES, attachScreenshot } = require('../commands/ticket');

const LINK_RE = /(https?:\/\/|discord\.gg\/|discord\.com\/invite\/)/i;

module.exports = {
  name: Events.MessageCreate,
  async execute(message) {
    if (message.author.bot || !message.inGuild()) return;
    const s = getSettings(message.guildId);

    // Milestone claims: the first image the claimant posts in the chat becomes their screenshot
    // (needs the Message Content intent; otherwise members can use /screenshot instead)
    if (message.attachments.some(a => a.contentType?.startsWith('image/'))) {
      const marks = SCREENSHOT_CATEGORIES.map(() => '?').join(',');
      const claim = db.prepare(`SELECT * FROM claims WHERE channel_id = ? AND user_id = ? AND paid = 0 AND screenshot IS NULL
                                AND category IN (${marks}) ORDER BY id DESC LIMIT 1`)
        .get(message.channelId, message.author.id, ...SCREENSHOT_CATEGORIES);
      if (claim) {
        await attachScreenshot(message.client, claim, message.url);
        message.react('✅').catch(() => {});
      }
    }

    // Link filter (needs Message Content intent; harmless no-op without it)
    if (s.automod_links && message.content && LINK_RE.test(message.content)
        && !message.member?.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
      try {
        await message.delete();
        const warn = await message.channel.send({ content: `<@${message.author.id}> links aren't allowed here.`, allowedMentions: { users: [message.author.id] } });
        setTimeout(() => warn.delete().catch(() => {}), 6000);
      } catch { /* missing permissions */ }
      return;
    }

    // XP: 15-25 per message, once a minute
    if (!s.xp_enabled) return;
    const now = Date.now();
    const row = db.prepare('SELECT xp, last_gain FROM xp WHERE guild_id = ? AND user_id = ?').get(message.guildId, message.author.id);
    if (row && now - row.last_gain < 60_000) return;
    const gain = 15 + Math.floor(Math.random() * 11);
    const before = levelFromXp(row?.xp ?? 0);
    db.prepare(`INSERT INTO xp (guild_id, user_id, xp, last_gain) VALUES (?, ?, ?, ?)
                ON CONFLICT (guild_id, user_id) DO UPDATE SET xp = xp + excluded.xp, last_gain = excluded.last_gain`)
      .run(message.guildId, message.author.id, gain, now);
    const after = levelFromXp((row?.xp ?? 0) + gain);
    if (after > before) {
      message.channel.send({ content: `🎉 <@${message.author.id}> reached **level ${after}**!`, allowedMentions: { users: [message.author.id] } }).catch(() => {});
    }
  },
};
