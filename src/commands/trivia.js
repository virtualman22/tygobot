const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { db } = require('../db');
const { eph, requireMod, shuffle, truncate } = require('../utils');

const sessions = new Map();
const LETTERS = ['A', 'B', 'C', 'D'];
const POINTS = { easy: 10, medium: 15, hard: 20 };
const ANSWER_SECONDS = 20;
const MEDALS = ['🥇', '🥈', '🥉'];

async function fetchOpenTdb({ category, difficulty }) {
  const url = new URL('https://opentdb.com/api.php');
  url.searchParams.set('amount', '1');
  url.searchParams.set('type', 'multiple');
  url.searchParams.set('encode', 'url3986');
  if (category) url.searchParams.set('category', String(category));
  if (difficulty) url.searchParams.set('difficulty', difficulty);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const json = await res.json();
    if (json.response_code !== 0 || !json.results?.length) return null;
    const q = json.results[0];
    const d = decodeURIComponent;
    return {
      question: d(q.question), correct: d(q.correct_answer), wrong: q.incorrect_answers.map(d),
      category: d(q.category), difficulty: q.difficulty,
    };
  } catch { return null; }
}

function fetchCustom(guildId, difficulty) {
  const row = db.prepare(`SELECT * FROM custom_questions WHERE guild_id = ? ${difficulty ? 'AND difficulty = ?' : ''} ORDER BY RANDOM() LIMIT 1`)
    .get(...(difficulty ? [guildId, difficulty] : [guildId]));
  if (!row) return null;
  return {
    question: row.question, correct: row.correct, wrong: JSON.parse(row.wrong),
    category: row.category || 'Community', difficulty: row.difficulty || 'medium',
  };
}

async function pickQuestion(guildId, { category, difficulty, source }) {
  if (source === 'custom') return fetchCustom(guildId, difficulty);
  if (source !== 'opentdb' && Math.random() < 0.3) {
    const c = fetchCustom(guildId, difficulty);
    if (c) return c;
  }
  return (await fetchOpenTdb({ category, difficulty })) ?? (source === 'opentdb' ? null : fetchCustom(guildId, difficulty));
}

/** Posts a trivia question. Returns { error } or { ok: true }. Also used by the daily scheduler. */
async function startTrivia(client, channel, opts = {}) {
  if ([...sessions.values()].some(s => s.channelId === channel.id)) {
    return { error: 'A trivia question is already running in this channel.' };
  }
  const q = await pickQuestion(channel.guildId, opts);
  if (!q) return { error: 'Couldn\'t get a question right now (the free API allows 1 request per 5 seconds). Try again shortly.' };

  const answers = shuffle([q.correct, ...q.wrong]).slice(0, 4);
  const id = Math.random().toString(36).slice(2, 8);
  const endsAt = Date.now() + ANSWER_SECONDS * 1000;

  const embed = new EmbedBuilder().setColor('#9146FF').setTitle('🧠 Trivia time!')
    .setDescription(`**${q.question}**\n\n${answers.map((a, i) => `**${LETTERS[i]}.** ${a}`).join('\n')}\n\n⏳ Ends <t:${Math.floor(endsAt / 1000)}:R>`)
    .setFooter({ text: `${q.category} • ${q.difficulty} • ${POINTS[q.difficulty] ?? 15} pts` });
  const row = new ActionRowBuilder().addComponents(answers.map((a, i) =>
    new ButtonBuilder().setCustomId(`tr:${id}:${i}`).setLabel(truncate(`${LETTERS[i]}. ${a}`, 80)).setStyle(ButtonStyle.Primary)));

  const message = await channel.send({ embeds: [embed], components: [row] });
  sessions.set(id, {
    id, channelId: channel.id, guildId: channel.guildId, message, q, answers,
    correctIdx: answers.indexOf(q.correct), answers_by: new Map(),
  });
  setTimeout(() => endTrivia(id).catch(console.error), ANSWER_SECONDS * 1000);
  return { ok: true };
}

async function endTrivia(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);

  const entries = [...s.answers_by.entries()];
  const winners = entries.filter(([, a]) => a.idx === s.correctIdx).sort((a, b) => a[1].at - b[1].at);
  const base = POINTS[s.q.difficulty] ?? 15;

  const upsert = db.prepare(`INSERT INTO trivia_scores (guild_id, user_id, correct, answered, streak, best_streak)
    VALUES (@g, @u, @c, 1, @c, @c)
    ON CONFLICT (guild_id, user_id) DO UPDATE SET
      answered = answered + 1, correct = correct + @c,
      streak = CASE WHEN @c = 1 THEN streak + 1 ELSE 0 END,
      best_streak = MAX(best_streak, CASE WHEN @c = 1 THEN streak + 1 ELSE 0 END)`);
  const addPts = db.prepare('INSERT INTO trivia_points (guild_id, user_id, points, ts) VALUES (?, ?, ?, ?)');
  const now = Date.now();
  db.transaction(() => {
    for (const [uid, a] of entries) upsert.run({ g: s.guildId, u: uid, c: a.idx === s.correctIdx ? 1 : 0 });
    winners.forEach(([uid], i) => addPts.run(s.guildId, uid, base + (i === 0 ? 5 : 0), now));
  })();

  const lines = winners.slice(0, 10).map(([uid], i) => `${MEDALS[i] ?? '✅'} <@${uid}> **+${base + (i === 0 ? 5 : 0)}**${i === 0 ? ' (fastest!)' : ''}`);
  const embed = new EmbedBuilder().setColor(winners.length ? '#2ECC71' : '#E74C3C').setTitle('🧠 Trivia — time\'s up!')
    .setDescription(`**${s.q.question}**\n\n${s.answers.map((a, i) => `${i === s.correctIdx ? '✅' : '▫️'} **${LETTERS[i]}.** ${a}`).join('\n')}\n\n` +
      `${entries.length} answered · ${winners.length} correct\n${lines.join('\n') || '*Nobody got it this time!*'}`)
    .setFooter({ text: `${s.q.category} • ${s.q.difficulty}` });
  await s.message.edit({ embeds: [embed], components: [] }).catch(() => {});
}

function leaderboardRows(guildId, period) {
  const since = period === 'week' ? Date.now() - 7 * 86_400_000 : period === 'month' ? Date.now() - 30 * 86_400_000 : 0;
  return db.prepare(`SELECT user_id, SUM(points) p FROM trivia_points WHERE guild_id = ? AND ts > ?
                     GROUP BY user_id ORDER BY p DESC LIMIT 10`).all(guildId, since);
}

const categories = [['General Knowledge', 9], ['Movies', 11], ['Music', 12], ['Video Games', 15], ['Science & Nature', 17],
  ['Computers', 18], ['Sports', 21], ['Geography', 22], ['History', 23], ['Animals', 27]];
const diffChoices = ['easy', 'medium', 'hard'].map(d => ({ name: d, value: d }));

const data = new SlashCommandBuilder()
  .setName('trivia')
  .setDescription('Trivia games, scores and custom questions')
  .addSubcommand(s => s.setName('play').setDescription('Post a trivia question')
    .addIntegerOption(o => o.setName('category').setDescription('Category').addChoices(...categories.map(([name, value]) => ({ name, value }))))
    .addStringOption(o => o.setName('difficulty').setDescription('Difficulty').addChoices(...diffChoices))
    .addStringOption(o => o.setName('source').setDescription('Where questions come from').addChoices(
      { name: 'Mixed (default)', value: 'any' }, { name: 'Open Trivia DB only', value: 'opentdb' }, { name: 'Our custom questions only', value: 'custom' })))
  .addSubcommand(s => s.setName('leaderboard').setDescription('Top players')
    .addStringOption(o => o.setName('period').setDescription('Time range').addChoices(
      { name: 'Last 7 days', value: 'week' }, { name: 'Last 30 days', value: 'month' }, { name: 'All time', value: 'all' })))
  .addSubcommand(s => s.setName('stats').setDescription('Show trivia stats')
    .addUserOption(o => o.setName('user').setDescription('Defaults to you')))
  .addSubcommand(s => s.setName('add').setDescription('(Mods) Add a custom question'))
  .addSubcommand(s => s.setName('questions').setDescription('(Mods) List custom questions'))
  .addSubcommand(s => s.setName('remove').setDescription('(Mods) Remove a custom question')
    .addIntegerOption(o => o.setName('id').setDescription('Question ID').setRequired(true)));

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const g = interaction.guildId;

  if (sub === 'play') {
    await interaction.deferReply({ flags: 64 });
    const res = await startTrivia(interaction.client, interaction.channel, {
      category: interaction.options.getInteger('category'),
      difficulty: interaction.options.getString('difficulty'),
      source: interaction.options.getString('source') ?? 'any',
    });
    return interaction.editReply(res.error ? `❌ ${res.error}` : '✅ Question posted!');
  }

  if (sub === 'leaderboard') {
    const period = interaction.options.getString('period') ?? 'week';
    const rows = leaderboardRows(g, period);
    const label = { week: 'last 7 days', month: 'last 30 days', all: 'all time' }[period];
    const desc = rows.length ? rows.map((r, i) => `${MEDALS[i] ?? `**${i + 1}.**`} <@${r.user_id}> — **${r.p}** pts`).join('\n') : '*No scores yet — try `/trivia play`!*';
    return interaction.reply({ embeds: [new EmbedBuilder().setColor('#9146FF').setTitle(`🏆 Trivia leaderboard (${label})`).setDescription(desc)], allowedMentions: { parse: [] } });
  }

  if (sub === 'stats') {
    const user = interaction.options.getUser('user') ?? interaction.user;
    const s = db.prepare('SELECT * FROM trivia_scores WHERE guild_id = ? AND user_id = ?').get(g, user.id);
    const pts = db.prepare('SELECT COALESCE(SUM(points), 0) p FROM trivia_points WHERE guild_id = ? AND user_id = ?').get(g, user.id).p;
    if (!s) return interaction.reply(eph({ content: `${user.username} hasn't played yet.` }));
    const acc = s.answered ? Math.round((s.correct / s.answered) * 100) : 0;
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor('#9146FF').setTitle(`🧠 ${user.username}'s trivia stats`).addFields(
        { name: 'Points', value: String(pts), inline: true }, { name: 'Correct', value: `${s.correct}/${s.answered} (${acc}%)`, inline: true },
        { name: 'Streak', value: `${s.streak} (best ${s.best_streak})`, inline: true })],
    });
  }

  if (!requireMod(interaction)) return;

  if (sub === 'add') {
    const f = (id, label, style, ph, required = true, max = 300) => new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setPlaceholder(ph).setRequired(required).setMaxLength(max));
    return interaction.showModal(new ModalBuilder().setCustomId('trqadd').setTitle('Add trivia question').addComponents(
      f('question', 'Question', TextInputStyle.Paragraph, 'Who won the first monthly event?'),
      f('correct', 'Correct answer', TextInputStyle.Short, 'The right answer', true, 70),
      f('wrong', 'Wrong answers (1-3, one per line)', TextInputStyle.Paragraph, 'Wrong 1\nWrong 2\nWrong 3', true, 250),
      f('category', 'Category (optional)', TextInputStyle.Short, 'Community', false, 40),
      f('difficulty', 'Difficulty: easy / medium / hard', TextInputStyle.Short, 'medium', false, 10),
    ));
  }

  if (sub === 'questions') {
    const rows = db.prepare('SELECT id, question, difficulty FROM custom_questions WHERE guild_id = ? ORDER BY id DESC LIMIT 20').all(g);
    if (!rows.length) return interaction.reply(eph({ content: 'No custom questions yet. Use `/trivia add`.' }));
    return interaction.reply(eph({ content: rows.map(r => `**#${r.id}** [${r.difficulty ?? 'medium'}] ${truncate(r.question, 90)}`).join('\n') }));
  }

  if (sub === 'remove') {
    const res = db.prepare('DELETE FROM custom_questions WHERE id = ? AND guild_id = ?').run(interaction.options.getInteger('id'), g);
    return interaction.reply(eph({ content: res.changes ? '🗑️ Removed.' : '❌ Not found.' }));
  }
}

const buttons = {
  async tr(interaction, [id, idx]) {
    const s = sessions.get(id);
    if (!s) return interaction.reply(eph({ content: '⌛ This question has already ended.' }));
    if (s.answers_by.has(interaction.user.id)) return interaction.reply(eph({ content: 'You already locked in an answer!' }));
    s.answers_by.set(interaction.user.id, { idx: Number(idx), at: Date.now() });
    return interaction.reply(eph({ content: `🔒 Locked in **${LETTERS[Number(idx)]}**. Results when the timer ends.` }));
  },
};

const modals = {
  async trqadd(interaction) {
    if (!requireMod(interaction)) return;
    const v = id => interaction.fields.getTextInputValue(id).trim();
    const wrong = v('wrong').split('\n').map(x => x.trim()).filter(Boolean);
    if (wrong.length < 1 || wrong.length > 3) return interaction.reply(eph({ content: '❌ Give 1 to 3 wrong answers, one per line.' }));
    const diff = v('difficulty').toLowerCase() || 'medium';
    if (!POINTS[diff]) return interaction.reply(eph({ content: '❌ Difficulty must be easy, medium or hard.' }));
    const res = db.prepare('INSERT INTO custom_questions (guild_id, question, correct, wrong, category, difficulty) VALUES (?, ?, ?, ?, ?, ?)')
      .run(interaction.guildId, v('question'), v('correct'), JSON.stringify(wrong), v('category') || null, diff);
    return interaction.reply(eph({ content: `✅ Added question #${res.lastInsertRowid}.` }));
  },
};

module.exports = { data, execute, buttons, modals, startTrivia };
