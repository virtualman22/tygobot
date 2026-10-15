const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, EmbedBuilder,
} = require('discord.js');
const { db } = require('../db');
const { eph, isMod, requireMod, truncate, logToGuild } = require('../utils');

const PAGE_SIZE = 20;      // entries per page (lossback lists use 15: two lines per entry)
const isLB = l => l.kind === 'lossback';
const psize = l => (isLB(l) ? 15 : PAGE_SIZE);
const MAX_ENTRIES = 500;   // per list
const COLOR = '#9146FF';

// ---------- helpers ----------

const getList = id => db.prepare('SELECT * FROM lists WHERE id = ?').get(id);
const countEntries = id => db.prepare('SELECT COUNT(*) c FROM list_entries WHERE list_id = ?').get(id).c;
const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Value columns that are switched on for this list (a column with no header is hidden). */
const valueCols = l => [l.col2 && { key: 'value1', head: l.col2 }, l.col3 && { key: 'value2', head: l.col3 }].filter(Boolean);

/** Text that is safe inside a ``` code block and fits a column. */
const cell = (s, n) => truncate(String(s ?? '').replace(/`/g, "'").replace(/\s+/g, ' ').trim(), n);

function table(l, rows, offset) {
  const cols = [
    { head: '#', get: (_, i) => String(offset + i + 1), max: 4, right: true },
    { head: l.col1, get: r => r.name, max: 24 },
    ...valueCols(l).map(c => ({ head: c.head, get: r => r[c.key], max: 16 })),
  ];
  const widths = cols.map(c => Math.min(c.max, Math.max(cell(c.head, c.max).length, ...rows.map((r, i) => cell(c.get(r, i), c.max).length))));
  const pad = (txt, w, right) => (right ? txt.padStart(w) : txt.padEnd(w));
  const line = vals => vals.map((v, i) => pad(cell(v, cols[i].max), widths[i], cols[i].right)).join('  ').trimEnd();
  const out = [line(cols.map(c => c.head)), widths.map(w => '─'.repeat(w)).join('──')];
  rows.forEach((r, i) => out.push(line(cols.map(c => c.get(r, i)))));
  return '```\n' + out.join('\n') + '\n```';
}

/** Lossback lists: two lines per entry so the full address can be read and copied. ✅ = paid. */
function lossbackRows(l, rows, offset) {
  return rows.map((r, i) => {
    const loss = r.value2 ? `**${truncate(r.value2.replace(/\*/g, ''), 40)}**` : '*loss not added yet*';
    const addr = r.value1 ? `\n└ \`${r.value1.replace(/`/g, '')}\`` : '';
    return `${r.dq ? '🚫' : r.paid ? '✅' : '⬜'} **${offset + i + 1}.** ${truncate(r.name.replace(/\*/g, ''), 40)} — ${l.col3 ?? 'Loss'}: ${loss}${addr}`;
  }).join('\n');
}

/** The public list message: an easy-to-read table plus the staff buttons. */
function render(listId) {
  const l = getList(listId);
  if (!l) return null;
  const total = countEntries(l.id);
  const size = psize(l);
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Math.max(l.page ?? 0, 0), pages - 1);
  if (page !== l.page) db.prepare('UPDATE lists SET page = ? WHERE id = ?').run(page, l.id);
  const rows = db.prepare('SELECT * FROM list_entries WHERE list_id = ? ORDER BY id LIMIT ? OFFSET ?').all(l.id, size, page * size);

  const body = rows.length ? (isLB(l) ? lossbackRows(l, rows, page * size) : table(l, rows, page * size)) : '*Nothing here yet.*';
  const embed = new EmbedBuilder().setColor(COLOR).setTitle(truncate(`📋 ${l.title}`, 256))
    .setDescription(truncate(`${l.description ? `${l.description}\n\n` : ''}${body}`, 4000))
    .setFooter({ text: `${total} ${total === 1 ? 'entry' : 'entries'}${pages > 1 ? ` · Page ${page + 1}/${pages}` : ''} · List #${l.id}` })
    .setTimestamp();

  const components = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ls:add:${l.id}`).setLabel('Add').setEmoji('➕').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`ls:bulk:${l.id}`).setLabel('Bulk add').setEmoji('📥').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ls:bedit:${l.id}`).setLabel('Bulk edit').setEmoji('📝').setStyle(ButtonStyle.Secondary).setDisabled(!total),
    new ButtonBuilder().setCustomId(`ls:edit:${l.id}`).setLabel('Edit').setEmoji('✏️').setStyle(ButtonStyle.Primary).setDisabled(!total),
    new ButtonBuilder().setCustomId(`ls:rem:${l.id}`).setLabel('Remove').setEmoji('🗑️').setStyle(ButtonStyle.Danger).setDisabled(!total),
  )];
  const second = [];
  if (isLB(l)) second.push(new ButtonBuilder().setCustomId(`ls:paid:${l.id}`).setLabel('Mark paid').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(!total));
  second.push(new ButtonBuilder().setCustomId(`ls:set:${l.id}`).setLabel('Settings').setEmoji('⚙️').setStyle(ButtonStyle.Secondary));
  if (pages > 1) {
    second.push(
      new ButtonBuilder().setCustomId(`ls:pg:${l.id}:-1`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`ls:pg:${l.id}:1`).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
    );
  }
  components.push(new ActionRowBuilder().addComponents(second));
  return { embeds: [embed], components };
}

/** Re-draws the public message of a list (used when the change came from a pop-up or menu). */
async function refreshMessage(client, listId) {
  const l = getList(listId);
  const payload = l && render(listId);
  if (!payload || !l.message_id) return false;
  try {
    const ch = await client.channels.fetch(l.channel_id);
    const msg = await ch.messages.fetch(l.message_id);
    await msg.edit(payload);
    return true;
  } catch { return false; }
}

/** After a change: update the list in place if the pop-up came from the list itself, otherwise edit it by link. */
async function applyChange(interaction, listId, okText) {
  const l = getList(listId);
  if (typeof interaction.isFromMessage === 'function' && interaction.isFromMessage() && interaction.message?.id === l?.message_id) {
    return interaction.update(render(listId));
  }
  await refreshMessage(interaction.client, listId);
  return interaction.reply(eph({ content: okText }));
}

const field = (id, label, style, max, required, value, ph) => {
  const t = new TextInputBuilder().setCustomId(id).setLabel(truncate(label, 45)).setStyle(style).setMaxLength(max).setRequired(required);
  if (ph) t.setPlaceholder(truncate(ph, 100));
  if (value) t.setValue(String(value).slice(0, max));
  return new ActionRowBuilder().addComponents(t);
};

/** Add/edit pop-up: one box for the name plus one per value column the list has. */
function entryModal(customId, l, e = {}) {
  const m = new ModalBuilder().setCustomId(customId).setTitle(truncate(e.id ? 'Edit entry' : 'Add entry', 45))
    .addComponents(field('name', l.col1, TextInputStyle.Short, 100, true, e.name));
  if (l.col2) m.addComponents(field('value1', l.col2, TextInputStyle.Short, 100, false, e.value1));
  if (l.col3) m.addComponents(field('value2', l.col3, TextInputStyle.Short, 100, false, e.value2));
  return m;
}

/** The select menu used by Edit and Remove: the entries on the page currently shown. */
function pageRows(l) {
  const size = psize(l);
  const pages = Math.max(1, Math.ceil(countEntries(l.id) / size));
  const page = Math.min(Math.max(l.page ?? 0, 0), pages - 1);
  return { page, rows: db.prepare('SELECT * FROM list_entries WHERE list_id = ? ORDER BY id LIMIT ? OFFSET ?').all(l.id, size, page * size) };
}

function entryPicker(l, kind) {
  const { page, rows } = pageRows(l);
  if (!rows.length) return null;
  const menu = new StringSelectMenuBuilder().setCustomId(`lssel:${kind}:${l.id}`)
    .setPlaceholder({ edit: 'Which entry do you want to edit?', rem: 'Pick the entries to remove…', paid: 'Pick entries to toggle paid / unpaid…' }[kind])
    .addOptions(rows.map((r, i) => {
      const opt = { label: truncate(`${kind === 'paid' ? (r.paid ? '✅ ' : '⬜ ') : ''}${page * psize(l) + i + 1}. ${r.name}`, 100), value: String(r.id) };
      const desc = [r.value1, r.value2].filter(Boolean).join(' · ');
      if (desc) opt.description = truncate(desc, 100);
      return opt;
    }));
  if (kind !== 'edit') menu.setMinValues(1).setMaxValues(rows.length);
  return new ActionRowBuilder().addComponents(menu);
}

/** Posts a new list message and saves it. Used by /list create and by the lossback system. Throws if it can't post. */
async function createList(target, { guildId, title, description = null, col1 = 'Name', col2 = null, col3 = null, kind = null, userId = null }) {
  const res = db.prepare(`INSERT INTO lists (guild_id, channel_id, title, description, col1, col2, col3, kind, created_by, created_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(guildId, target.id, clean(title, 100), description, col1, col2, col3, kind, userId, Date.now());
  const id = Number(res.lastInsertRowid);
  try {
    const msg = await target.send(render(id));
    db.prepare('UPDATE lists SET message_id = ? WHERE id = ?').run(msg.id, id);
  } catch (e) {
    db.prepare('DELETE FROM lists WHERE id = ?').run(id);
    throw e;
  }
  return id;
}

// ---------- command ----------

const data = new SlashCommandBuilder()
  .setName('list')
  .setDescription('Make and manage custom lists that everyone can read')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand(s => s.setName('create').setDescription('Spawn a new empty list in a channel')
    .addStringOption(o => o.setName('title').setDescription('What the list is for, e.g. Top Wagerers').setRequired(true).setMaxLength(100))
    .addStringOption(o => o.setName('value1').setDescription('Header of the first value column (e.g. Amount). Leave out for none').setMaxLength(30))
    .addStringOption(o => o.setName('value2').setDescription('Header of the second value column (e.g. Status). Leave out for none').setMaxLength(30))
    .addStringOption(o => o.setName('name_header').setDescription('Header of the names column (default: Name)').setMaxLength(30))
    .addStringOption(o => o.setName('description').setDescription('Text shown above the list').setMaxLength(500))
    .addChannelOption(o => o.setName('channel').setDescription('Where to post it (default: this channel)')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread)))
  .addSubcommand(s => s.setName('all').setDescription('Show every list in this server with a link to it'))
  .addSubcommand(s => s.setName('delete').setDescription('Delete a list and its message')
    .addStringOption(o => o.setName('list').setDescription('Which list').setRequired(true).setAutocomplete(true)));

async function execute(interaction) {
  if (!requireMod(interaction)) return;
  const sub = interaction.options.getSubcommand();
  const g = interaction.guildId;

  if (sub === 'create') {
    const target = interaction.options.getChannel('channel') ?? interaction.channel;
    let id;
    try {
      id = await createList(target, {
        guildId: g, userId: interaction.user.id, title: interaction.options.getString('title'),
        description: interaction.options.getString('description')?.trim() || null,
        col1: clean(interaction.options.getString('name_header'), 30) || 'Name',
        col2: clean(interaction.options.getString('value1'), 30) || null,
        col3: clean(interaction.options.getString('value2'), 30) || null,
      });
    } catch (e) {
      return interaction.reply(eph({ content: `❌ Couldn't post the list there: ${e.message}` }));
    }
    await logToGuild(interaction.client, g, `📋 <@${interaction.user.id}> created list **${clean(interaction.options.getString('title'), 100)}** (#${id}) in ${target}.`);
    return interaction.reply(eph({ content: `✅ List posted in ${target}. Use its **Add** button to fill it, or **Settings** to rename it and change the columns.` }));
  }

  if (sub === 'all') {
    const rows = db.prepare('SELECT l.*, (SELECT COUNT(*) FROM list_entries e WHERE e.list_id = l.id) n FROM lists l WHERE guild_id = ? ORDER BY id DESC LIMIT 25').all(g);
    if (!rows.length) return interaction.reply(eph({ content: 'No lists yet. Make one with `/list create`.' }));
    const lines = rows.map(l => `\`#${l.id}\` **${truncate(l.title, 60)}** — ${l.n} ${l.n === 1 ? 'entry' : 'entries'} · ` +
      (l.message_id ? `[open](https://discord.com/channels/${g}/${l.channel_id}/${l.message_id})` : '*no message*'));
    return interaction.reply(eph({ embeds: [new EmbedBuilder().setColor(COLOR).setTitle('📋 Lists').setDescription(lines.join('\n'))] }));
  }

  if (sub === 'delete') {
    const l = db.prepare('SELECT * FROM lists WHERE id = ? AND guild_id = ?').get(Number(interaction.options.getString('list')), g);
    if (!l) return interaction.reply(eph({ content: '❌ List not found.' }));
    db.prepare('DELETE FROM list_entries WHERE list_id = ?').run(l.id);
    db.prepare('DELETE FROM lists WHERE id = ?').run(l.id);
    try { await (await (await interaction.client.channels.fetch(l.channel_id)).messages.fetch(l.message_id)).delete(); } catch { /* already gone */ }
    await logToGuild(interaction.client, g, `📋 <@${interaction.user.id}> deleted list **${l.title}** (#${l.id}).`);
    return interaction.reply(eph({ content: `🗑️ List **${l.title}** deleted.` }));
  }
}

async function autocomplete(interaction) {
  const q = String(interaction.options.getFocused());
  const rows = db.prepare('SELECT id, title FROM lists WHERE guild_id = ? AND title LIKE ? ORDER BY id DESC LIMIT 25').all(interaction.guildId, `%${q}%`);
  await interaction.respond(rows.map(r => ({ name: truncate(`#${r.id} ${r.title}`, 100), value: String(r.id) })));
}

// ---------- buttons ----------

const buttons = {
  async ls(interaction, [action, idStr, dir]) {
    const l = getList(Number(idStr));
    if (!l) return interaction.reply(eph({ content: '❌ This list no longer exists.' }));

    // ◀ ▶ are open to everyone (viewing only)
    if (action === 'pg') {
      db.prepare('UPDATE lists SET page = MAX(0, page + ?) WHERE id = ?').run(Number(dir), l.id);
      return interaction.update(render(l.id));
    }

    if (!isMod(interaction)) return interaction.reply(eph({ content: '❌ Only staff can change this list.' }));

    if (action === 'add') return interaction.showModal(entryModal(`lsadd:${l.id}`, l));

    if (action === 'bulk') {
      const cols = [l.col1, l.col2, l.col3].filter(Boolean);
      return interaction.showModal(new ModalBuilder().setCustomId(`lsbulk:${l.id}`).setTitle('Bulk add entries').addComponents(
        field('lines', `One per line: ${cols.join(' | ')}`, TextInputStyle.Paragraph, 4000, true, null,
          `${['Alice', '$25', 'Paid'].slice(0, cols.length).join(' | ')}\n${['Bob', '$10', 'Pending'].slice(0, cols.length).join(' | ')}`)));
    }

    if (action === 'bedit') {
      const { page, rows } = pageRows(l);
      const keys = valueCols(l).map(c => c.key);
      const lines = [];
      let len = 0;
      for (const r of rows) {
        const line = [r.name, ...keys.map(k => r[k] ?? '')].map(x => String(x).replace(/\|/g, '/')).join(' | ');
        if (len + line.length + 1 > 3900) break;
        lines.push(line); len += line.length + 1;
      }
      const heads = [l.col1, ...valueCols(l).map(c => c.head)].join(' | ');
      return interaction.showModal(new ModalBuilder().setCustomId(`lsbedit:${l.id}:${page}:${lines.length}`).setTitle(`Bulk edit (page ${page + 1})`).addComponents(
        field('lines', truncate(`${heads} — keep the line order`, 45), TextInputStyle.Paragraph, 4000, true, lines.join('\n'))));
    }

    if (action === 'edit' || action === 'rem' || action === 'paid') {
      if (action === 'paid' && !isLB(l)) return interaction.reply(eph({ content: 'Paid marks are only on lossback lists.' }));
      const picker = entryPicker(l, action);
      if (!picker) return interaction.reply(eph({ content: 'The list is empty.' }));
      const total = countEntries(l.id);
      const more = total > psize(l) ? '\n*(Shows the page currently displayed — use ◀ ▶ on the list to reach other entries.)*' : '';
      return interaction.reply(eph({
        content: { edit: '✏️ Pick the entry to edit:', rem: '🗑️ Pick one or more entries to remove:', paid: '✅ Pick the entries to mark as paid (picking a paid one marks it unpaid again):' }[action] + more,
        components: [picker],
      }));
    }

    if (action === 'set') {
      return interaction.showModal(new ModalBuilder().setCustomId(`lsset:${l.id}`).setTitle('List settings').addComponents(
        field('title', 'Title', TextInputStyle.Short, 100, true, l.title),
        field('description', 'Text shown above the list (optional)', TextInputStyle.Paragraph, 500, false, l.description),
        field('col1', 'Names column header', TextInputStyle.Short, 30, true, l.col1),
        field('col2', 'First value column header (empty = none)', TextInputStyle.Short, 30, false, l.col2),
        field('col3', 'Second value column header (empty = none)', TextInputStyle.Short, 30, false, l.col3),
      ));
    }
  },
};

// ---------- select menus (Edit / Remove pickers) ----------

const selects = {
  async lssel(interaction, [kind, idStr]) {
    if (!isMod(interaction)) return interaction.reply(eph({ content: '❌ Only staff can change this list.' }));
    const l = getList(Number(idStr));
    if (!l) return interaction.update({ content: '❌ This list no longer exists.', components: [] });

    if (kind === 'edit') {
      const e = db.prepare('SELECT * FROM list_entries WHERE id = ? AND list_id = ?').get(Number(interaction.values[0]), l.id);
      if (!e) return interaction.update({ content: '❌ That entry no longer exists.', components: [] });
      return interaction.showModal(entryModal(`lsedit:${l.id}:${e.id}`, l, e));
    }

    if (kind === 'paid') {
      const ids = interaction.values.map(Number);
      const q = `list_id = ? AND id IN (${ids.map(() => '?').join(',')})`;
      const before = db.prepare(`SELECT name, paid FROM list_entries WHERE ${q}`).all(l.id, ...ids);
      db.prepare(`UPDATE list_entries SET paid = 1 - COALESCE(paid, 0) WHERE ${q}`).run(l.id, ...ids);
      await refreshMessage(interaction.client, l.id);
      await logToGuild(interaction.client, interaction.guildId, `✅ <@${interaction.user.id}> toggled paid on ${before.map(b => `**${b.name}** (${b.paid ? 'now unpaid' : 'now paid'})`).join(', ')} in list **${l.title}**.`);
      return interaction.update({ content: `✅ Updated ${before.length} ${before.length === 1 ? 'entry' : 'entries'}.`, components: [] });
    }

    if (kind === 'rem') {
      const ids = interaction.values.map(Number);
      const res = db.prepare(`DELETE FROM list_entries WHERE list_id = ? AND id IN (${ids.map(() => '?').join(',')})`).run(l.id, ...ids);
      await refreshMessage(interaction.client, l.id);
      await logToGuild(interaction.client, interaction.guildId, `📋 <@${interaction.user.id}> removed ${res.changes} ${res.changes === 1 ? 'entry' : 'entries'} from list **${l.title}** (#${l.id}).`);
      return interaction.update({ content: `🗑️ Removed ${res.changes} ${res.changes === 1 ? 'entry' : 'entries'}.`, components: [] });
    }
  },
};

// ---------- pop-ups ----------

const modals = {
  async lsadd(interaction, [idStr]) {
    if (!requireMod(interaction)) return;
    const l = getList(Number(idStr));
    if (!l) return interaction.reply(eph({ content: '❌ This list no longer exists.' }));
    if (countEntries(l.id) >= MAX_ENTRIES) return interaction.reply(eph({ content: `❌ A list can hold up to ${MAX_ENTRIES} entries.` }));
    const v = id => (interaction.fields.fields.has(id) ? clean(interaction.fields.getTextInputValue(id), 100) : '');
    db.prepare('INSERT INTO list_entries (list_id, name, value1, value2) VALUES (?, ?, ?, ?)').run(l.id, v('name'), v('value1') || null, v('value2') || null);
    return applyChange(interaction, l.id, `✅ Added **${v('name')}**.`);
  },

  async lsedit(interaction, [idStr, entryId]) {
    if (!requireMod(interaction)) return;
    const l = getList(Number(idStr));
    if (!l) return interaction.reply(eph({ content: '❌ This list no longer exists.' }));
    const v = id => (interaction.fields.fields.has(id) ? clean(interaction.fields.getTextInputValue(id), 100) : '');
    const res = db.prepare('UPDATE list_entries SET name = ?, value1 = ?, value2 = ? WHERE id = ? AND list_id = ?')
      .run(v('name'), v('value1') || null, v('value2') || null, Number(entryId), l.id);
    if (!res.changes) return interaction.reply(eph({ content: '❌ That entry no longer exists.' }));
    return applyChange(interaction, l.id, `✅ Updated **${v('name')}**.`);
  },

  async lsbulk(interaction, [idStr]) {
    if (!requireMod(interaction)) return;
    const l = getList(Number(idStr));
    if (!l) return interaction.reply(eph({ content: '❌ This list no longer exists.' }));
    const room = MAX_ENTRIES - countEntries(l.id);
    const parsed = interaction.fields.getTextInputValue('lines').split('\n')
      .map(line => line.split('|').map(p => clean(p, 100)))
      .filter(parts => parts[0]);
    const entries = parsed.slice(0, Math.max(0, room));
    const add = db.prepare('INSERT INTO list_entries (list_id, name, value1, value2) VALUES (?, ?, ?, ?)');
    db.transaction(() => { for (const [name, v1, v2] of entries) add.run(l.id, name, v1 || null, v2 || null); })();
    const skipped = parsed.length - entries.length;
    return applyChange(interaction, l.id, `✅ Added ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}${skipped ? ` (${skipped} skipped: the list is full)` : ''}.`);
  },

  // Edits the entries on one page from a text box: line N = entry N of that page. Extra lines are added; missing lines change nothing.
  async lsbedit(interaction, [idStr, pageStr, nStr]) {
    if (!requireMod(interaction)) return;
    const l = getList(Number(idStr));
    if (!l) return interaction.reply(eph({ content: '❌ This list no longer exists.' }));
    const size = psize(l);
    const rows = db.prepare('SELECT * FROM list_entries WHERE list_id = ? ORDER BY id LIMIT ? OFFSET ?').all(l.id, Number(nStr), Number(pageStr) * size);
    const keys = valueCols(l).map(c => c.key);
    const lines = interaction.fields.getTextInputValue('lines').split('\n').map(line => line.split('|').map(p => clean(p, 100)));
    const upd = db.prepare('UPDATE list_entries SET name = ?, value1 = ?, value2 = ? WHERE id = ?');
    const ins = db.prepare('INSERT INTO list_entries (list_id, name, value1, value2) VALUES (?, ?, ?, ?)');
    const vals = parts => ({ value1: null, value2: null, ...Object.fromEntries(keys.map((k, j) => [k, parts[1 + j] || null])) });
    let changed = 0, added = 0, room = MAX_ENTRIES - countEntries(l.id);
    db.transaction(() => {
      lines.forEach((parts, i) => {
        if (!parts[0]) return;
        const v = vals(parts);
        if (i < rows.length) {
          const r = rows[i];
          if (r.name !== parts[0] || (r.value1 ?? null) !== v.value1 || (r.value2 ?? null) !== v.value2) { upd.run(parts[0], v.value1, v.value2, r.id); changed++; }
        } else if (room > 0) { ins.run(l.id, parts[0], v.value1, v.value2); added++; room--; }
      });
    })();
    return applyChange(interaction, l.id, `✅ Bulk edit saved: ${changed} updated, ${added} added.`);
  },

  async lsset(interaction, [idStr]) {
    if (!requireMod(interaction)) return;
    const l = getList(Number(idStr));
    if (!l) return interaction.reply(eph({ content: '❌ This list no longer exists.' }));
    const t = id => interaction.fields.getTextInputValue(id).trim();
    db.prepare('UPDATE lists SET title = ?, description = ?, col1 = ?, col2 = ?, col3 = ? WHERE id = ?')
      .run(clean(t('title'), 100), t('description') || null, clean(t('col1'), 30) || 'Name', clean(t('col2'), 30) || null, clean(t('col2'), 30) ? clean(t('col3'), 30) || null : null, l.id);
    return applyChange(interaction, l.id, '✅ List settings saved.');
  },
};

module.exports = { data, execute, autocomplete, buttons, selects, modals, createList, refreshMessage, getList, render, countEntries };
