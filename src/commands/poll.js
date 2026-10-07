const {
  SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const { db } = require('../db');
const { eph, requireMod, parseDuration, truncate, ts } = require('../utils');

function counts(messageId, n) {
  const c = new Array(n).fill(0);
  for (const r of db.prepare('SELECT option_idx, COUNT(*) c FROM poll_votes WHERE message_id = ? GROUP BY option_idx').all(messageId)) c[r.option_idx] = r.c;
  return c;
}

function pollEmbed(p, closed = false) {
  const options = JSON.parse(p.options);
  const c = counts(p.message_id, options.length);
  const total = c.reduce((a, b) => a + b, 0);
  const lines = options.map((o, i) => {
    const pct = total ? Math.round((c[i] / total) * 100) : 0;
    return `**${i + 1}. ${o}**\n${'█'.repeat(Math.round(pct / 10)).padEnd(10, '░')} ${c[i]} (${pct}%)`;
  });
  return new EmbedBuilder().setColor(closed ? '#95A5A6' : '#3498DB')
    .setTitle(`📊 ${p.question}`).setDescription(lines.join('\n\n'))
    .setFooter({ text: `${total} vote${total === 1 ? '' : 's'}${closed ? ' • closed' : ''}` })
    .addFields(!closed && p.ends_at ? [{ name: 'Closes', value: ts(p.ends_at, 'R') }] : []);
}

function pollButtons(p) {
  const options = JSON.parse(p.options);
  const rows = [];
  for (let i = 0; i < options.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(options.slice(i, i + 5).map((o, j) =>
      new ButtonBuilder().setCustomId(`poll:${i + j}`).setLabel(truncate(`${i + j + 1}. ${o}`, 80)).setStyle(ButtonStyle.Secondary))));
  }
  return rows;
}

async function closePoll(client, p) {
  db.prepare('UPDATE polls SET closed = 1 WHERE message_id = ?').run(p.message_id);
  try {
    const ch = await client.channels.fetch(p.channel_id);
    const msg = await ch.messages.fetch(p.message_id);
    await msg.edit({ embeds: [pollEmbed(p, true)], components: [] });
  } catch { /* message deleted */ }
}

const data = new SlashCommandBuilder()
  .setName('poll')
  .setDescription('Run polls')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand(s => s.setName('create').setDescription('Create a poll')
    .addStringOption(o => o.setName('question').setDescription('Question').setRequired(true).setMaxLength(200))
    .addStringOption(o => o.setName('options').setDescription('2-10 options separated by |  (e.g. Yes | No | Maybe)').setRequired(true))
    .addStringOption(o => o.setName('duration').setDescription('Auto-close after e.g. 30m, 12h, 3d (optional)')))
  .addSubcommand(s => s.setName('end').setDescription('Close a poll now')
    .addStringOption(o => o.setName('message_id').setDescription('Poll message ID').setRequired(true)));

async function execute(interaction) {
  if (!requireMod(interaction)) return;
  const sub = interaction.options.getSubcommand();

  if (sub === 'create') {
    const options = interaction.options.getString('options').split('|').map(o => o.trim()).filter(Boolean);
    if (options.length < 2 || options.length > 10) return interaction.reply(eph({ content: '❌ Give between 2 and 10 options separated by `|`.' }));
    const durStr = interaction.options.getString('duration');
    const dur = durStr ? parseDuration(durStr) : null;
    if (durStr && !dur) return interaction.reply(eph({ content: '❌ Duration should look like `30m`, `12h` or `3d`.' }));

    const p = { message_id: 'pending', question: interaction.options.getString('question'), options: JSON.stringify(options.map(o => truncate(o, 70))), ends_at: dur ? Date.now() + dur : null };
    await interaction.reply({ embeds: [pollEmbed(p)], components: pollButtons(p) });
    const msg = await interaction.fetchReply();
    p.message_id = msg.id;
    db.prepare('INSERT INTO polls (message_id, guild_id, channel_id, question, options, ends_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(msg.id, interaction.guildId, interaction.channelId, p.question, p.options, p.ends_at);
    if (p.ends_at) await msg.edit({ embeds: [pollEmbed(p)] });
    return;
  }

  if (sub === 'end') {
    const p = db.prepare('SELECT * FROM polls WHERE message_id = ? AND guild_id = ? AND closed = 0').get(interaction.options.getString('message_id').trim(), interaction.guildId);
    if (!p) return interaction.reply(eph({ content: '❌ No open poll with that ID.' }));
    await closePoll(interaction.client, p);
    return interaction.reply(eph({ content: '✅ Poll closed.' }));
  }
}

const buttons = {
  async poll(interaction, [idx]) {
    const p = db.prepare('SELECT * FROM polls WHERE message_id = ?').get(interaction.message.id);
    if (!p || p.closed) return interaction.reply(eph({ content: '⌛ This poll is closed.' }));
    db.prepare(`INSERT INTO poll_votes (message_id, user_id, option_idx) VALUES (?, ?, ?)
                ON CONFLICT (message_id, user_id) DO UPDATE SET option_idx = excluded.option_idx`)
      .run(p.message_id, interaction.user.id, Number(idx));
    await interaction.update({ embeds: [pollEmbed(p)] });
    await interaction.followUp(eph({ content: `✅ Voted for option ${Number(idx) + 1}. Click another to change your vote.` }));
  },
};

module.exports = { data, execute, buttons, closePoll };
