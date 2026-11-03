const { SlashCommandBuilder, PermissionFlagsBits, escapeMarkdown } = require('discord.js');
const { eph, isMod, requireMod } = require('../utils');
const mc = require('../memberCard');
const bridge = require('../bridge');

// /card — staff pull up any member's website card (privately). Staff on the website's staff list also get the staff block.
const data = new SlashCommandBuilder()
  .setName('card')
  .setDescription('Show a member\'s website card: Kick, Stake, site points and leaderboard wager')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addUserOption(o => o.setName('member').setDescription('The Discord member'))
  .addStringOption(o => o.setName('name').setDescription('Or search by their Kick, Stake or Discord username').setMaxLength(60));

async function execute(interaction) {
  if (!requireMod(interaction)) return;
  if (!bridge.enabled()) return interaction.reply(eph({ content: '⚪ The website link is off (set SITE_URL and BRIDGE_SECRET).' }));
  const member = interaction.options.getUser('member');
  const name = interaction.options.getString('name')?.trim();
  if (!member && !name) return interaction.reply(eph({ content: 'Pick a **member** or type a **name** (Kick, Stake or Discord username).' }));

  await interaction.deferReply(eph());
  const c = await mc.fetchCard(member ? { discord_id: member.id } : { query: name }, interaction.user.id);
  if (!c) return interaction.editReply({ content: '⚠️ I couldn\'t reach the website. Try again in a minute (`/sitelink status`).' });
  if (!c.found) {
    return interaction.editReply(member
      ? { embeds: [mc.notLinkedEmbed(member.id, false)], allowedMentions: { parse: [] } }
      : { content: `🔍 No website member matches **${escapeMarkdown(name)}** (checked Kick, Stake and Discord usernames).` });
  }
  const user = member || await interaction.client.users.fetch(c.discord_id).catch(() => null);
  const note = c.staff ? '' : '\n-# Log in on the website once with your staff account to also see the staff details here.';
  return interaction.editReply({ content: `<@${c.discord_id}>${note}`, embeds: [mc.cardEmbed(c, user, { staff: true })], components: [mc.refreshRow(c.discord_id)], allowedMentions: { parse: [] } });
}

// "Refresh card" on a card (in a ticket or a /card reply): fetches the latest numbers. Staff see the staff block when they refresh their own /card view.
const buttons = {
  async mc(interaction, [action, userId]) {
    if (action !== 'refresh' || !/^\d+$/.test(userId || '')) return;
    const staff = isMod(interaction);
    const ownTicket = String(interaction.channel?.topic ?? '').startsWith(`ticket:${interaction.user.id}:`);
    if (!staff && !ownTicket) return interaction.reply(eph({ content: '❌ Only the member or staff can refresh this card.' }));
    await interaction.deferUpdate();
    const c = await mc.fetchCard({ discord_id: userId }, staff && interaction.message.flags?.has?.(64) ? interaction.user.id : '');
    if (!c || !c.found) return interaction.followUp(eph({ content: '⚠️ I couldn\'t refresh the card right now.' }));
    const user = await interaction.client.users.fetch(userId).catch(() => null);
    return interaction.editReply({ embeds: [mc.cardEmbed(c, user, { staff: Boolean(c.staff) })], components: [mc.refreshRow(userId)] });
  },
};

module.exports = { data, execute, buttons };
