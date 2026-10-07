const {
  SlashCommandBuilder, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, AttachmentBuilder,
} = require('discord.js');
const { db } = require('../db');
const { eph, requireMod, truncate, ts, logToGuild } = require('../utils');

const STATUSES = ['Pending', 'Paid', 'Cancelled'];
const EMOJI = { Pending: '⏳', Paid: '✅', Cancelled: '❌' };
const PAGE_SIZE = 8;
const sessions = new Map();

const normStatus = s => {
  const v = String(s ?? '').trim();
  if (!v) return 'Pending';
  return STATUSES.find(x => x.toLowerCase() === v.toLowerCase()) ?? null;
};

function rewardModal(customId, v = {}) {
  const field = (id, label, style, max, required, ph) => {
    const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setMaxLength(max).setRequired(required);
    if (ph) t.setPlaceholder(ph);
    if (v[id]) t.setValue(String(v[id]).slice(0, max));
    return new ActionRowBuilder().addComponents(t);
  };
  return new ModalBuilder().setCustomId(customId).setTitle('Reward entry').addComponents(
    field('label', 'Label (what is this for?)', TextInputStyle.Short, 100, true, 'October 2026 Event'),
    field('username', 'User name', TextInputStyle.Short, 100, true, 'Discord or in-game name'),
    field('reward', 'Reward', TextInputStyle.Short, 200, true, '$50 / 1st place / VIP role'),
    field('notes', 'Notes', TextInputStyle.Paragraph, 1000, false, 'Payment method, proof, anything useful'),
    field('status', 'Status (Pending / Paid / Cancelled)', TextInputStyle.Short, 20, false, 'Pending'),
  );
}

const readRow = i => ({
  label: i.fields.getTextInputValue('label').trim(),
  username: i.fields.getTextInputValue('username').trim(),
  reward: i.fields.getTextInputValue('reward').trim(),
  notes: i.fields.getTextInputValue('notes').trim(),
  status: normStatus(i.fields.getTextInputValue('status')),
});

function entryEmbed(r) {
  return new EmbedBuilder()
    .setColor(r.status === 'Paid' ? '#2ECC71' : r.status === 'Cancelled' ? '#E74C3C' : '#F1C40F')
    .setTitle(`Reward #${r.id} — ${truncate(r.label, 200)}`)
    .addFields(
      { name: 'User', value: truncate(r.username, 1024), inline: true },
      { name: 'Reward', value: truncate(r.reward, 1024), inline: true },
      { name: 'Status', value: `${EMOJI[r.status] ?? ''} ${r.status}`, inline: true },
      { name: 'Notes', value: r.notes ? truncate(r.notes, 1024) : '*none*' },
      { name: 'Added', value: `${ts(r.created_at)} by <@${r.created_by}>`, inline: true },
      { name: 'Updated', value: ts(r.updated_at), inline: true },
    );
}

function filterSql(guildId, f) {
  const where = ['guild_id = ?'];
  const params = [guildId];
  if (f.label) { where.push('label = ? COLLATE NOCASE'); params.push(f.label); }
  if (f.user) { where.push('username LIKE ?'); params.push(`%${f.user}%`); }
  if (f.status) { where.push('status = ?'); params.push(f.status); }
  return { where: where.join(' AND '), params };
}

function listPayload(sid, s) {
  const { where, params } = filterSql(s.guildId, s.filters);
  const total = db.prepare(`SELECT COUNT(*) c FROM rewards WHERE ${where}`).get(...params).c;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  s.page = Math.min(Math.max(s.page, 0), pages - 1);
  const rows = db.prepare(`SELECT * FROM rewards WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, PAGE_SIZE, s.page * PAGE_SIZE);

  const desc = rows.length
    ? rows.map(r => `\`#${r.id}\` **${truncate(r.label, 40)}** · **${truncate(r.username, 30)}** → ${truncate(r.reward, 50)} · ${EMOJI[r.status] ?? ''} ${r.status}${r.notes ? `\n> ${truncate(r.notes.replace(/\n/g, ' '), 90)}` : ''}`).join('\n')
    : '*No entries match.*';

  const f = s.filters;
  const active = [f.label && `label: ${f.label}`, f.user && `user: ${f.user}`, f.status && `status: ${f.status}`].filter(Boolean).join(' · ');
  const embed = new EmbedBuilder().setColor('#9146FF').setTitle('🎁 Rewards tracker')
    .setDescription(desc).setFooter({ text: `Page ${s.page + 1}/${pages} · ${total} entries${active ? ` · ${active}` : ''}` });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`rwp:${sid}:-1`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(s.page === 0),
    new ButtonBuilder().setCustomId(`rwp:${sid}:1`).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(s.page >= pages - 1),
  );
  return { embeds: [embed], components: [row] };
}

const csvCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

const statusChoices = STATUSES.map(s => ({ name: s, value: s }));

const data = new SlashCommandBuilder()
  .setName('rewards')
  .setDescription('Mod tracker for rewards, prizes and payouts')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand(s => s.setName('add').setDescription('Add a new entry')
    .addStringOption(o => o.setName('label').setDescription('Pre-fill the label').setAutocomplete(true)))
  .addSubcommand(s => s.setName('list').setDescription('Browse and filter entries')
    .addStringOption(o => o.setName('label').setDescription('Filter by label').setAutocomplete(true))
    .addStringOption(o => o.setName('user').setDescription('Filter by user name (partial match)'))
    .addStringOption(o => o.setName('status').setDescription('Filter by status').addChoices(...statusChoices)))
  .addSubcommand(s => s.setName('view').setDescription('Show one entry')
    .addIntegerOption(o => o.setName('id').setDescription('Entry ID').setRequired(true)))
  .addSubcommand(s => s.setName('edit').setDescription('Edit an entry')
    .addIntegerOption(o => o.setName('id').setDescription('Entry ID').setRequired(true)))
  .addSubcommand(s => s.setName('status').setDescription('Quickly change an entry\'s status')
    .addIntegerOption(o => o.setName('id').setDescription('Entry ID').setRequired(true))
    .addStringOption(o => o.setName('status').setDescription('New status').setRequired(true).addChoices(...statusChoices)))
  .addSubcommand(s => s.setName('delete').setDescription('Delete an entry')
    .addIntegerOption(o => o.setName('id').setDescription('Entry ID').setRequired(true)))
  .addSubcommand(s => s.setName('labels').setDescription('Summary per label'))
  .addSubcommand(s => s.setName('export').setDescription('Export entries as a CSV file')
    .addStringOption(o => o.setName('label').setDescription('Only this label').setAutocomplete(true)));

async function execute(interaction) {
  if (!requireMod(interaction)) return;
  const sub = interaction.options.getSubcommand();
  const g = interaction.guildId;
  const getRow = id => db.prepare('SELECT * FROM rewards WHERE id = ? AND guild_id = ?').get(id, g);

  if (sub === 'add') {
    return interaction.showModal(rewardModal('rwadd', { label: interaction.options.getString('label') }));
  }

  if (sub === 'list') {
    const sid = Math.random().toString(36).slice(2, 8);
    const s = {
      guildId: g, userId: interaction.user.id, page: 0,
      filters: {
        label: interaction.options.getString('label'),
        user: interaction.options.getString('user'),
        status: interaction.options.getString('status'),
      },
    };
    sessions.set(sid, s);
    setTimeout(() => sessions.delete(sid), 15 * 60_000).unref();
    return interaction.reply(eph(listPayload(sid, s)));
  }

  if (sub === 'view') {
    const r = getRow(interaction.options.getInteger('id'));
    if (!r) return interaction.reply(eph({ content: '❌ Entry not found.' }));
    return interaction.reply(eph({ embeds: [entryEmbed(r)] }));
  }

  if (sub === 'edit') {
    const r = getRow(interaction.options.getInteger('id'));
    if (!r) return interaction.reply(eph({ content: '❌ Entry not found.' }));
    return interaction.showModal(rewardModal(`rwedit:${r.id}`, r));
  }

  if (sub === 'status') {
    const id = interaction.options.getInteger('id');
    const status = interaction.options.getString('status');
    const res = db.prepare('UPDATE rewards SET status = ?, updated_at = ? WHERE id = ? AND guild_id = ?').run(status, Date.now(), id, g);
    if (!res.changes) return interaction.reply(eph({ content: '❌ Entry not found.' }));
    await logToGuild(interaction.client, g, `🎁 <@${interaction.user.id}> set reward #${id} to **${status}**.`);
    return interaction.reply(eph({ content: `${EMOJI[status]} Entry #${id} is now **${status}**.` }));
  }

  if (sub === 'delete') {
    const id = interaction.options.getInteger('id');
    const res = db.prepare('DELETE FROM rewards WHERE id = ? AND guild_id = ?').run(id, g);
    if (res.changes) await logToGuild(interaction.client, g, `🎁 <@${interaction.user.id}> deleted reward entry #${id}.`);
    return interaction.reply(eph({ content: res.changes ? `🗑️ Entry #${id} deleted.` : '❌ Entry not found.' }));
  }

  if (sub === 'labels') {
    const rows = db.prepare(`SELECT label, COUNT(*) total,
        SUM(status = 'Pending') pending, SUM(status = 'Paid') paid, SUM(status = 'Cancelled') cancelled
        FROM rewards WHERE guild_id = ? GROUP BY label COLLATE NOCASE ORDER BY MAX(id) DESC LIMIT 25`).all(g);
    if (!rows.length) return interaction.reply(eph({ content: 'No entries yet. Use `/rewards add`.' }));
    const lines = rows.map(r => `**${truncate(r.label, 60)}** — ${r.total} total · ⏳ ${r.pending} · ✅ ${r.paid} · ❌ ${r.cancelled}`);
    return interaction.reply(eph({ embeds: [new EmbedBuilder().setColor('#9146FF').setTitle('🏷️ Labels').setDescription(lines.join('\n'))] }));
  }

  if (sub === 'export') {
    const label = interaction.options.getString('label');
    const { where, params } = filterSql(g, { label });
    const rows = db.prepare(`SELECT * FROM rewards WHERE ${where} ORDER BY id`).all(...params);
    if (!rows.length) return interaction.reply(eph({ content: 'Nothing to export.' }));
    const header = ['ID', 'Label', 'User', 'Reward', 'Status', 'Notes', 'Created', 'Updated'];
    const lines = rows.map(r => [r.id, r.label, r.username, r.reward, r.status, r.notes,
      new Date(r.created_at).toISOString(), new Date(r.updated_at).toISOString()].map(csvCell).join(','));
    const file = new AttachmentBuilder(Buffer.from('\uFEFF' + [header.join(','), ...lines].join('\n')), { name: 'rewards.csv' });
    return interaction.reply(eph({ content: `📄 ${rows.length} entries exported.`, files: [file] }));
  }
}

async function autocomplete(interaction) {
  const q = String(interaction.options.getFocused());
  const rows = db.prepare('SELECT DISTINCT label FROM rewards WHERE guild_id = ? AND label LIKE ? ORDER BY label LIMIT 25')
    .all(interaction.guildId, `%${q}%`);
  await interaction.respond(rows.map(r => ({ name: truncate(r.label, 100), value: truncate(r.label, 100) })));
}

const buttons = {
  async rwp(interaction, [sid, dir]) {
    const s = sessions.get(sid);
    if (!s || s.userId !== interaction.user.id) return interaction.reply(eph({ content: '⌛ This list expired. Run `/rewards list` again.' }));
    s.page += Number(dir);
    return interaction.update(listPayload(sid, s));
  },
};

const modals = {
  async rwadd(interaction) {
    if (!requireMod(interaction)) return;
    const r = readRow(interaction);
    if (!r.status) return interaction.reply(eph({ content: '❌ Status must be Pending, Paid or Cancelled.' }));
    const now = Date.now();
    const res = db.prepare(`INSERT INTO rewards (guild_id, label, username, reward, notes, status, created_by, created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(interaction.guildId, r.label, r.username, r.reward, r.notes || null, r.status, interaction.user.id, now, now);
    const row = db.prepare('SELECT * FROM rewards WHERE id = ?').get(res.lastInsertRowid);
    await logToGuild(interaction.client, interaction.guildId, `🎁 <@${interaction.user.id}> added reward #${row.id}: **${r.username}** — ${r.reward} (${r.label}).`);
    return interaction.reply(eph({ content: `✅ Saved as entry #${row.id}.`, embeds: [entryEmbed(row)] }));
  },

  async rwedit(interaction, [id]) {
    if (!requireMod(interaction)) return;
    const r = readRow(interaction);
    if (!r.status) return interaction.reply(eph({ content: '❌ Status must be Pending, Paid or Cancelled.' }));
    const res = db.prepare(`UPDATE rewards SET label = ?, username = ?, reward = ?, notes = ?, status = ?, updated_at = ?
                            WHERE id = ? AND guild_id = ?`)
      .run(r.label, r.username, r.reward, r.notes || null, r.status, Date.now(), id, interaction.guildId);
    if (!res.changes) return interaction.reply(eph({ content: '❌ Entry not found.' }));
    const row = db.prepare('SELECT * FROM rewards WHERE id = ?').get(id);
    await logToGuild(interaction.client, interaction.guildId, `🎁 <@${interaction.user.id}> edited reward entry #${id}.`);
    return interaction.reply(eph({ content: '✅ Updated.', embeds: [entryEmbed(row)] }));
  },
};

module.exports = { data, execute, autocomplete, buttons, modals };
