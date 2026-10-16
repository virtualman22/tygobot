const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder, ActionRowBuilder } = require('discord.js');
const { getSettings } = require('../db');
const { eph, requireMod } = require('../utils');
const { CATEGORIES, claimButtons } = require('./ticket');
const { WALLET_RULE } = require('../sites');

const claimTypes = Object.entries(CATEGORIES).filter(([, c]) => c.claim);

const data = new SlashCommandBuilder()
  .setName('claimform')
  .setDescription('Post the claim form buttons (Stake / Moon) in any chat')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addStringOption(o => o.setName('type').setDescription('What kind of claim').setRequired(true)
    .addChoices(...claimTypes.map(([value, c]) => ({ name: c.label, value }))))
  .addChannelOption(o => o.setName('channel').setDescription('Where to post it (default: this channel)')
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread))
  .addStringOption(o => o.setName('message').setDescription('Custom text shown above the button').setMaxLength(500));

async function execute(interaction) {
  if (!requireMod(interaction)) return;
  const key = interaction.options.getString('type');
  const c = CATEGORIES[key];
  const target = interaction.options.getChannel('channel') ?? interaction.channel;

  const s = getSettings(interaction.guildId);
  if (!s.claims_channel) {
    return interaction.reply(eph({ content: '⚠️ Set your claims channel first. Every submitted form is sent there (and nowhere else):\n`/setup set claims_channel:#your-claims-channel`' }));
  }

  try {
    await target.send({
      embeds: [new EmbedBuilder().setColor('#9146FF').setTitle(`${c.emoji} ${c.label}`)
        .setDescription(`${interaction.options.getString('message')
          ?? `Press **Stake claim** or **Moon claim** (the site your reward is for) and fill in your details. ${c.screenshot ? 'You\'ll also be asked to upload a screenshot. ' : ''}Only staff can see what you submit.`}\n\n💳 ${WALLET_RULE}`)],
      components: [new ActionRowBuilder().addComponents(claimButtons(key))],
    });
  } catch (e) {
    return interaction.reply(eph({ content: `❌ Couldn't post there: ${e.message}` }));
  }
  return interaction.reply(eph({ content: `✅ Claim form posted in ${target}.` }));
}

module.exports = { data, execute };
