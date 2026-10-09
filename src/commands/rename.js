const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { eph, requireMod, logToGuild } = require('../utils');

const SLUG_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum];

const data = new SlashCommandBuilder()
  .setName('rename')
  .setDescription('Rename a channel (this one by default)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addStringOption(o => o.setName('name').setDescription('The new name').setRequired(true).setMinLength(1).setMaxLength(100))
  .addChannelOption(o => o.setName('channel').setDescription('Which channel (default: this one)'));

async function execute(interaction) {
  if (!requireMod(interaction)) return;
  const target = interaction.options.getChannel('channel') ?? interaction.channel;
  let name = interaction.options.getString('name').trim();
  // Text channels use lowercase-with-dashes names; voice channels, categories and threads keep what you type
  if (SLUG_TYPES.includes(target.type)) name = name.toLowerCase().replace(/\s+/g, '-').replace(/-+/g, '-');
  name = name.slice(0, 100);
  if (!name) return interaction.reply(eph({ content: '❌ That name is empty.' }));
  if (name === target.name) return interaction.reply(eph({ content: 'It already has that name.' }));

  await interaction.deferReply(eph());
  const old = target.name;
  try {
    // Discord only allows 2 renames per channel every 10 minutes; discord.js waits it out, so don't hang on it
    const done = await Promise.race([target.setName(name, `Renamed by ${interaction.user.tag}`).then(() => true), new Promise(r => setTimeout(() => r(false), 8000))]);
    if (!done) return interaction.editReply({ content: `⏳ Discord is rate-limiting renames on that channel (2 per 10 minutes). It will be renamed to **${name}** automatically as soon as the limit resets.` });
  } catch (e) {
    return interaction.editReply({ content: `❌ Couldn't rename it: ${/permission/i.test(e.message) ? 'I need the **Manage Channels** permission on that channel.' : e.message}` });
  }
  await logToGuild(interaction.client, interaction.guildId, `✏️ <@${interaction.user.id}> renamed <#${target.id}> from **${old}** to **${name}**.`);
  return interaction.editReply({ content: `✅ Renamed **${old}** → **${name}**.` });
}

module.exports = { data, execute };
