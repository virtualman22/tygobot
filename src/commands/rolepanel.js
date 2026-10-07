const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { eph } = require('../utils');

const builder = new SlashCommandBuilder()
  .setName('rolepanel')
  .setDescription('Post a panel where members pick their own roles with buttons')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .addStringOption(o => o.setName('title').setDescription('Panel title').setRequired(true).setMaxLength(100))
  .addRoleOption(o => o.setName('role1').setDescription('Role').setRequired(true))
  .addStringOption(o => o.setName('description').setDescription('Panel text').setMaxLength(500));
for (let i = 2; i <= 5; i++) builder.addRoleOption(o => o.setName(`role${i}`).setDescription('Role'));

async function execute(interaction) {
  const roles = [1, 2, 3, 4, 5].map(i => interaction.options.getRole(`role${i}`)).filter(Boolean);
  const bad = roles.find(r => r.managed || r.id === interaction.guildId);
  if (bad) return interaction.reply(eph({ content: `❌ **${bad.name}** can't be self-assigned (managed or @everyone).` }));
  const row = new ActionRowBuilder().addComponents(roles.map(r =>
    new ButtonBuilder().setCustomId(`rl:${r.id}`).setLabel(r.name.slice(0, 80)).setStyle(ButtonStyle.Secondary)));
  await interaction.channel.send({
    embeds: [new EmbedBuilder().setColor('#9146FF').setTitle(interaction.options.getString('title'))
      .setDescription(`${interaction.options.getString('description') ?? 'Click a button to add or remove a role.'}\n\n${roles.map(r => `• ${r}`).join('\n')}`)],
    components: [row],
  });
  return interaction.reply(eph({ content: '✅ Panel posted. Make sure my role is **above** these roles in Server Settings → Roles.' }));
}

module.exports = { data: builder, execute, buttons: {
  async rl(interaction, [roleId]) {
    const role = interaction.guild.roles.cache.get(roleId);
    if (!role) return interaction.reply(eph({ content: '❌ That role no longer exists.' }));
    try {
      if (interaction.member.roles.cache.has(roleId)) {
        await interaction.member.roles.remove(roleId);
        return interaction.reply(eph({ content: `➖ Removed **${role.name}**.` }));
      }
      await interaction.member.roles.add(roleId);
      return interaction.reply(eph({ content: `➕ You now have **${role.name}**.` }));
    } catch {
      return interaction.reply(eph({ content: '❌ I can\'t manage that role. A mod needs to move my role above it.' }));
    }
  },
} };
