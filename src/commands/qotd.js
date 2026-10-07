const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { db, getSettings } = require('../db');
const { eph, requireMod, truncate } = require('../utils');

/** Posts the next unused question. Used by /qotd post and the daily scheduler. */
async function postQotd(client, guildId, channelId) {
  const next = () => db.prepare('SELECT * FROM qotd_questions WHERE guild_id = ? AND used = 0 ORDER BY id LIMIT 1').get(guildId);
  let q = next();
  if (!q) {
    db.prepare('UPDATE qotd_questions SET used = 0 WHERE guild_id = ?').run(guildId);
    q = next();
  }
  if (!q) return false;
  const channel = await client.channels.fetch(channelId);
  await channel.send({
    embeds: [new EmbedBuilder().setColor('#F1C40F').setTitle('💬 Question of the Day').setDescription(`**${q.question}**\n\nShare your answer below!`).setTimestamp()],
  });
  db.prepare('UPDATE qotd_questions SET used = 1 WHERE id = ?').run(q.id);
  return true;
}

const data = new SlashCommandBuilder()
  .setName('qotd')
  .setDescription('Question of the Day')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand(s => s.setName('add').setDescription('Add a question to the queue')
    .addStringOption(o => o.setName('question').setDescription('The question').setRequired(true).setMaxLength(300)))
  .addSubcommand(s => s.setName('list').setDescription('Show the queue'))
  .addSubcommand(s => s.setName('remove').setDescription('Remove a question')
    .addIntegerOption(o => o.setName('id').setDescription('Question ID').setRequired(true)))
  .addSubcommand(s => s.setName('post').setDescription('Post the next question now'));

async function execute(interaction) {
  if (!requireMod(interaction)) return;
  const sub = interaction.options.getSubcommand();
  const g = interaction.guildId;

  if (sub === 'add') {
    const res = db.prepare('INSERT INTO qotd_questions (guild_id, question, author_id) VALUES (?, ?, ?)')
      .run(g, interaction.options.getString('question'), interaction.user.id);
    return interaction.reply(eph({ content: `✅ Added as #${res.lastInsertRowid}.` }));
  }
  if (sub === 'list') {
    const rows = db.prepare('SELECT * FROM qotd_questions WHERE guild_id = ? ORDER BY id LIMIT 25').all(g);
    if (!rows.length) return interaction.reply(eph({ content: 'Queue is empty. Use `/qotd add`.' }));
    return interaction.reply(eph({ content: rows.map(r => `${r.used ? '✔️' : '🕐'} **#${r.id}** ${truncate(r.question, 100)}`).join('\n') }));
  }
  if (sub === 'remove') {
    const res = db.prepare('DELETE FROM qotd_questions WHERE id = ? AND guild_id = ?').run(interaction.options.getInteger('id'), g);
    return interaction.reply(eph({ content: res.changes ? '🗑️ Removed.' : '❌ Not found.' }));
  }
  if (sub === 'post') {
    const channelId = getSettings(g).qotd_channel ?? interaction.channelId;
    const ok = await postQotd(interaction.client, g, channelId);
    return interaction.reply(eph({ content: ok ? `✅ Posted in <#${channelId}>.` : '❌ No questions in the queue.' }));
  }
}

module.exports = { data, execute, postQotd };
