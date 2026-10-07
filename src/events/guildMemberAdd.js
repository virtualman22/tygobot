const { Events, EmbedBuilder } = require('discord.js');
const { getSettings } = require('../db');

// Requires the privileged "Server Members Intent" (ENABLE_PRIVILEGED_INTENTS=true)
module.exports = {
  name: Events.GuildMemberAdd,
  async execute(member) {
    const s = getSettings(member.guild.id);
    if (!s.welcome_channel) return;
    try {
      const ch = await member.guild.channels.fetch(s.welcome_channel);
      const text = (s.welcome_message || 'Welcome {user}!')
        .replaceAll('{user}', `<@${member.id}>`)
        .replaceAll('{server}', member.guild.name)
        .replaceAll('{count}', String(member.guild.memberCount));
      await ch.send({
        content: `<@${member.id}>`,
        embeds: [new EmbedBuilder().setColor('#9146FF').setDescription(text).setThumbnail(member.user.displayAvatarURL())],
        allowedMentions: { users: [member.id] },
      });
    } catch (e) { console.error('Welcome failed:', e.message); }
  },
};
