const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { db, getSettings } = require('../db');
const { eph, requireMod } = require('../utils');

const COLORS = { Pending: '#F1C40F', Approved: '#2ECC71', Denied: '#E74C3C', Considering: '#3498DB' };

const data = new SlashCommandBuilder()
  .setName('suggest')
  .setDescription('Community suggestions')
  .addSubcommand(s => s.setName('new').setDescription('Submit a suggestion')
    .addStringOption(o => o.setName('idea').setDescription('Your suggestion').setRequired(true).setMaxLength(1500)))
  .addSubcommand(s => s.setName('review').setDescription('(Mods) Approve / deny a suggestion')
    .addIntegerOption(o => o.setName('id').setDescription('Suggestion number').setRequired(true))
    .addStringOption(o => o.setName('status').setDescription('Decision').setRequired(true)
      .addChoices(...Object.keys(COLORS).filter(k => k !== 'Pending').map(k => ({ name: k, value: k }))))
    .addStringOption(o => o.setName('reason').setDescription('Optional explanation').setMaxLength(500)));

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const s = getSettings(interaction.guildId);

  if (sub === 'new') {
    if (!s.suggest_channel) return interaction.reply(eph({ content: '❌ No suggestions channel is set. Ask a mod to run `/setup set suggest_channel`.' }));
    const idea = interaction.options.getString('idea');
    try {
      const ch = await interaction.client.channels.fetch(s.suggest_channel);
      const msg = await ch.send({ embeds: [new EmbedBuilder().setColor(COLORS.Pending).setDescription(idea)
        .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() }).setFooter({ text: 'Pending' })] });
      const res = db.prepare('INSERT INTO suggestions (guild_id, channel_id, message_id, user_id, content) VALUES (?, ?, ?, ?, ?)')
        .run(interaction.guildId, ch.id, msg.id, interaction.user.id, idea);
      await msg.edit({ embeds: [EmbedBuilder.from(msg.embeds[0]).setTitle(`Suggestion #${res.lastInsertRowid}`)] });
      await msg.react('👍'); await msg.react('👎');
      return interaction.reply(eph({ content: `✅ Posted in <#${ch.id}> as #${res.lastInsertRowid}.` }));
    } catch (e) {
      return interaction.reply(eph({ content: `❌ Couldn't post: ${e.message}` }));
    }
  }

  if (!requireMod(interaction)) return;
  const row = db.prepare('SELECT * FROM suggestions WHERE id = ? AND guild_id = ?').get(interaction.options.getInteger('id'), interaction.guildId);
  if (!row) return interaction.reply(eph({ content: '❌ Suggestion not found.' }));
  const status = interaction.options.getString('status');
  const reason = interaction.options.getString('reason');
  try {
    const ch = await interaction.client.channels.fetch(row.channel_id);
    const msg = await ch.messages.fetch(row.message_id);
    const e = EmbedBuilder.from(msg.embeds[0]).setColor(COLORS[status]).setFooter({ text: `${status} by ${interaction.user.username}` });
    e.setFields(reason ? [{ name: `${status} — reason`, value: reason }] : []);
    await msg.edit({ embeds: [e] });
  } catch (e) {
    return interaction.reply(eph({ content: `❌ Couldn't update the message: ${e.message}` }));
  }
  db.prepare('UPDATE suggestions SET status = ? WHERE id = ?').run(status, row.id);
  return interaction.reply(eph({ content: `✅ Suggestion #${row.id} marked **${status}**.` }));
}

module.exports = { data, execute };
