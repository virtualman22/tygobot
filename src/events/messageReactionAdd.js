const { Events, EmbedBuilder } = require('discord.js');
const { db, getSettings } = require('../db');

module.exports = {
  name: Events.MessageReactionAdd,
  async execute(reaction, user) {
    if (user.bot) return;
    try {
      if (reaction.partial) await reaction.fetch();
      if (reaction.message.partial) await reaction.message.fetch();
      if (reaction.emoji.name !== '⭐') return;

      const msg = reaction.message;
      if (!msg.guild) return;
      const s = getSettings(msg.guild.id);
      if (!s.starboard_channel || msg.channelId === s.starboard_channel || reaction.count < s.starboard_threshold) return;

      const header = `⭐ **${reaction.count}** · <#${msg.channelId}>`;
      const existing = db.prepare('SELECT * FROM starboard WHERE message_id = ?').get(msg.id);
      const board = await msg.guild.channels.fetch(s.starboard_channel);

      if (existing) {
        const starMsg = await board.messages.fetch(existing.star_message_id);
        await starMsg.edit({ content: header });
        return;
      }
      const embed = new EmbedBuilder().setColor('#F1C40F')
        .setAuthor({ name: msg.author.username, iconURL: msg.author.displayAvatarURL() })
        .setDescription(`${msg.content || ''}\n\n[Jump to message](${msg.url})`.slice(0, 4000))
        .setTimestamp(msg.createdAt);
      const img = msg.attachments.find(a => a.contentType?.startsWith('image/'));
      if (img) embed.setImage(img.url);
      const sent = await board.send({ content: header, embeds: [embed] });
      db.prepare('INSERT INTO starboard (message_id, guild_id, star_message_id) VALUES (?, ?, ?)').run(msg.id, msg.guild.id, sent.id);
    } catch (e) { console.error('Starboard failed:', e.message); }
  },
};
