const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const { getSettings } = require('../db');
const { eph, isMod, logToGuild } = require('../utils');

const P = PermissionFlagsBits;

const CATEGORIES = {
  giveaway: {
    label: 'Giveaway Claim', emoji: '🎁', style: ButtonStyle.Success, channel: 'giveaway',
    help: 'Congrats on winning! Please tell us:\n• Which giveaway you won (link to the message if you can)\n• Your username for the prize',
  },
  milestone: {
    label: 'Milestones', emoji: '🏆', style: ButtonStyle.Primary, channel: 'milestone',
    help: 'Please tell us:\n• Which milestone you reached\n• Proof (screenshot or link)\n• Your username',
  },
  tech: {
    label: 'Technical Assistance', emoji: '🛠️', style: ButtonStyle.Secondary, channel: 'support',
    help: 'Please describe:\n• What is going wrong\n• What you expected to happen\n• Screenshots or error messages, if any',
  },
  bonus: {
    label: 'Bonuses', emoji: '💰', style: ButtonStyle.Primary, channel: 'bonus',
    help: 'Please tell us:\n• Which bonus you are asking about\n• Your username\n• Any proof or details that help us check it',
  },
};

const data = new SlashCommandBuilder()
  .setName('ticket')
  .setDescription('Support tickets')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addSubcommand(s => s.setName('panel').setDescription('Post the ticket panel (4 category buttons) in this channel')
    .addStringOption(o => o.setName('title').setDescription('Panel title').setMaxLength(100))
    .addStringOption(o => o.setName('description').setDescription('Panel text').setMaxLength(500)));

async function execute(interaction) {
  const row = new ActionRowBuilder().addComponents(Object.entries(CATEGORIES).map(([key, c]) =>
    new ButtonBuilder().setCustomId(`tk:open:${key}`).setLabel(c.label).setEmoji(c.emoji).setStyle(c.style)));
  const intro = interaction.options.getString('description')
    ?? 'Pick the option that fits your request and a private channel will open for you and our staff.';
  await interaction.channel.send({
    embeds: [new EmbedBuilder().setColor('#9146FF').setTitle(interaction.options.getString('title') ?? '🎫 Open a ticket')
      .setDescription(`${intro}\n\n${Object.values(CATEGORIES).map(c => `${c.emoji} **${c.label}**`).join('\n')}`)],
    components: [row],
  });
  return interaction.reply(eph({ content: '✅ Ticket panel posted.' }));
}

const ticketInfo = topic => {
  const [tag, userId, cat] = String(topic ?? '').split(':');
  return tag === 'ticket' ? { userId, cat } : null;
};

const buttons = {
  async tk(interaction, [action, cat]) {
    const guild = interaction.guild;

    if (action === 'open') {
      const c = CATEGORIES[cat];
      if (!c) return interaction.reply(eph({ content: '❌ Unknown ticket type.' }));

      const existing = guild.channels.cache.find(ch => ch.topic === `ticket:${interaction.user.id}:${cat}`);
      if (existing) return interaction.reply(eph({ content: `You already have an open **${c.label}** ticket: ${existing}` }));

      const s = getSettings(guild.id);
      const me = interaction.client.user.id;
      const overwrites = [
        { id: guild.id, deny: [P.ViewChannel] },
        { id: interaction.user.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles] },
        { id: me, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageChannels] },
      ];
      if (s.mod_role) overwrites.push({ id: s.mod_role, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageMessages] });

      try {
        const name = `${c.channel}-${interaction.user.username.toLowerCase().replace(/[^a-z0-9_-]/g, '')}`.slice(0, 90);
        const ch = await guild.channels.create({
          name, type: ChannelType.GuildText, parent: s.ticket_category || undefined,
          topic: `ticket:${interaction.user.id}:${cat}`, permissionOverwrites: overwrites,
        });
        await ch.send({
          content: `<@${interaction.user.id}>${s.mod_role ? ` <@&${s.mod_role}>` : ''}`,
          embeds: [new EmbedBuilder().setColor('#9146FF').setTitle(`${c.emoji} ${c.label}`).setDescription(`${c.help}\n\nA staff member will be with you soon.`)],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('tk:claim').setLabel('Claim').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('tk:close').setLabel('Close ticket').setStyle(ButtonStyle.Danger),
          )],
          allowedMentions: { users: [interaction.user.id], roles: s.mod_role ? [s.mod_role] : [] },
        });
        await logToGuild(interaction.client, guild.id, `🎫 **${c.label}** ticket opened by <@${interaction.user.id}>: ${ch}`);
        return interaction.reply(eph({ content: `✅ Your ticket is ready: ${ch}` }));
      } catch (e) {
        return interaction.reply(eph({ content: `❌ Couldn't create the ticket (I need the Manage Channels permission): ${e.message}` }));
      }
    }

    if (action === 'claim') {
      if (!isMod(interaction)) return interaction.reply(eph({ content: '❌ Only staff can claim tickets.' }));
      return interaction.reply({ content: `🙋 <@${interaction.user.id}> is handling this ticket.`, allowedMentions: { parse: [] } });
    }

    if (action === 'close') {
      const info = ticketInfo(interaction.channel.topic);
      if (!info) return interaction.reply(eph({ content: '❌ This isn\'t a ticket channel.' }));
      if (info.userId !== interaction.user.id && !isMod(interaction)) {
        return interaction.reply(eph({ content: '❌ Only staff or the ticket owner can close this.' }));
      }
      await interaction.reply('🔒 Closing this ticket in 5 seconds…');
      await logToGuild(interaction.client, guild.id, `🎫 Ticket **${interaction.channel.name}** closed by <@${interaction.user.id}>.`);
      setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
    }
  },
};

module.exports = { data, execute, buttons };
