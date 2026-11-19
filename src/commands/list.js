const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, EmbedBuilder, LabelBuilder, AttachmentBuilder,
} = require('discord.js');
const { db } = require('../db');
const { eph, isMod, requireMod, truncate, logToGuild } = require('../utils');
const { siteTag } = require('../sites');
const { notifyLossback, forget } = require('../lossbackNotify');

const PAGE_SIZE = 20;      // entries per page (lossback and form lists use 15: one line per entry, not a table)
const isLB = l => l.kind === 'lossback';
const isForm = l => l.kind === 'form';
const isHunt = l => l.kind === 'hunt';
const psize = l => (isLB(l) || isForm(l) ? 15 : PAGE_SIZE);
const MAX_ENTRIES = 500;   // per list
const COLOR = '#9146FF';

// ---------- community hunt ----------
// A normal list switched to "Community hunt" (button on the list, or /list create community_hunt:true): the columns become
// Username | Amount | Source. Staff press Calculate and enter the starting balance (default: everything put in) and the ending
// balance; the multiplier is end / start and everyone gets back what they put in times it. It recalculates itself when entries change.
// lists.hunt = JSON { start: number|null (null = total put in), end: number|null, prev: [col1, col2, col3] (headers before the switch) }
try { db.exec('ALTER TABLE lists ADD COLUMN hunt TEXT'); } catch { /* already migrated */ }
const HUNT_COLS = ['Username', 'Amount', 'Source'];

/** "$1,250.50", "1250", "€25,5", "25 usd" -> number, or null when there is no number in it. */
function parseAmount(v) {
  let s = String(v ?? '').replace(/[^\d.,-]/g, '');
  if (!/\d/.test(s)) return null;
  if (s.includes(',') && !s.includes('.') && /,\d{1,2}$/.test(s)) s = s.replace(',', '.');   // 25,50 = decimal comma
  s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
/** The currency sign people typed (first one found in the amounts), default $. */
const currencyOf = rows => (rows.map(r => /[$€£]/.exec(r.value1 ?? '')?.[0]).find(Boolean)) || '$';
const fmtMoney = (n, cur = '$') => `${n < 0 ? '-' : ''}${cur}${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
const huntOf = l => (isHunt(l) ? { start: null, end: null, prev: null, ...(parseJson(l.hunt, {}) || {}) } : null);

/** Everything the hunt shows: the total put in, start / end, the multiplier and each entry's return (null until calculated). */
function huntMath(l, rows = null) {
  const h = huntOf(l);
  const all = rows ?? db.prepare('SELECT * FROM list_entries WHERE list_id = ? ORDER BY id').all(l.id);
  const total = Math.round(all.reduce((a, r) => a + (parseAmount(r.value1) ?? 0), 0) * 100) / 100;
  const start = h.start ?? total;
  const mult = h.end != null && start > 0 ? h.end / start : null;
  const back = r => { const a = parseAmount(r.value1); return mult === null || a === null ? null : Math.round(a * mult * 100) / 100; };
  return { h, total, start, end: h.end, mult, back, cur: currencyOf(all), startIsTotal: h.start == null };
}
const multText = m => `x${m >= 100 ? Math.round(m) : m >= 10 ? m.toFixed(1) : m.toFixed(2)}`;

/** The summary above a hunt list. */
function huntIntro(l) {
  const m = huntMath(l);
  const lines = [`🎯 **Community hunt** · ${countEntries(l.id)} ${countEntries(l.id) === 1 ? 'person' : 'people'} put in **${fmtMoney(m.total, m.cur)}**`];
  if (m.mult === null) lines.push(`Starting balance **${fmtMoney(m.start, m.cur)}**${m.startIsTotal ? ' (everything put in)' : ''} · ending balance *not in yet*: staff press **Calculate**`);
  else {
    const up = m.end >= m.start;
    lines.push(`Start **${fmtMoney(m.start, m.cur)}** → End **${fmtMoney(m.end, m.cur)}** · ${up ? '📈' : '📉'} **${multText(m.mult)}**`);
    lines.push(`Every ${fmtMoney(1, m.cur)} put in comes back as **${fmtMoney(Math.round(m.mult * 100) / 100, m.cur)}**.`);
  }
  return lines.join('\n') + '\n\n';
}

/** Hunt table: # · Username · Source · In · Back (Back once calculated). */
function huntTable(l, rows, offset) {
  const m = huntMath(l);
  const cols = [
    { head: '#', get: (_, i) => String(offset + i + 1), max: 4, right: true },
    { head: 'Username', get: r => r.name, max: 20 },
    { head: 'Source', get: r => r.value2 ?? '', max: 12 },
    { head: 'In', get: r => { const a = parseAmount(r.value1); return a === null ? (r.value1 ? `${r.value1}?` : '') : fmtMoney(a, m.cur); }, max: 12, right: true },
    ...(m.mult !== null ? [{ head: 'Back', get: r => { const b = m.back(r); return b === null ? '' : fmtMoney(b, m.cur); }, max: 12, right: true }] : []),
  ];
  const widths = cols.map(c => Math.min(c.max, Math.max(cell(c.head, c.max).length, ...rows.map((r, i) => cell(c.get(r, i), c.max).length))));
  const pad = (txt, w, right) => (right ? txt.padStart(w) : txt.padEnd(w));
  const line = vals => vals.map((v, i) => pad(cell(v, cols[i].max), widths[i], cols[i].right)).join('  ').trimEnd();
  const out = [line(cols.map(c => c.head)), widths.map(w => '─'.repeat(w)).join('──')];
  rows.forEach((r, i) => out.push(line(cols.map(c => c.get(r, i)))));
  return '```\n' + out.join('\n') + '\n```';
}

/** Turns a normal list into a community hunt (or back). Returns the new kind. */
function toggleHunt(l) {
  if (isHunt(l)) {
    const prev = huntOf(l).prev || [l.col1, l.col2, l.col3];
    db.prepare('UPDATE lists SET kind = NULL, col1 = ?, col2 = ?, col3 = ? WHERE id = ?').run(prev[0] || 'Name', prev[1] || null, prev[2] || null, l.id);
    return null;
  }
  const h = { ...(parseJson(l.hunt, {}) || {}), prev: [l.col1, l.col2, l.col3] };
  db.prepare("UPDATE lists SET kind = 'hunt', col1 = ?, col2 = ?, col3 = ?, hunt = ? WHERE id = ?").run(...HUNT_COLS, JSON.stringify(h), l.id);
  return 'hunt';
}

// ---------- helpers ----------

const getList = id => db.prepare('SELECT * FROM lists WHERE id = ?').get(id);
const countEntries = id => db.prepare('SELECT COUNT(*) c FROM list_entries WHERE list_id = ?').get(id).c;
const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Value columns that are switched on for this list (a column with no header is hidden). */
const valueCols = l => [l.col2 && { key: 'value1', head: l.col2 }, l.col3 && { key: 'value2', head: l.col3 }].filter(Boolean);

// Form lists (/form) have up to 5 columns: the form's fields. Answers live in list_entries.data as { fieldKey: value }.
const formOf = l => (isForm(l) ? db.prepare('SELECT * FROM forms WHERE list_id = ?').get(l.id) ?? null : null);
function parseJson(s, fb) { try { return JSON.parse(s) ?? fb; } catch { return fb; } }
const formFields = f => (f ? parseJson(f.fields, []) : []);

/** Column headers, in order: [name, value1?, value2?] for normal lists, the form's fields for form lists. */
const heads = l => (isForm(l) ? formFields(formOf(l)).map(f => f.label) : [l.col1, ...valueCols(l).map(c => c.head)]);

/** One entry's values, in the same order as heads(). */
function valuesOf(l, r, fields = null) {
  if (!isForm(l)) return [r.name, ...valueCols(l).map(c => r[c.key] ?? '')];
  const d = parseJson(r.data, {});
  return (fields ?? formFields(formOf(l))).map(f => d[f.k] ?? '');
}

/** Values (same order as heads()) -> the columns to save. `prev` keeps a form entry's answers to fields not shown. */
function toRow(l, vals, prev = null, fields = null) {
  if (isForm(l)) {
    const d = prev ? parseJson(prev.data, {}) : {};
    (fields ?? formFields(formOf(l))).forEach((f, i) => { if (vals[i]) d[f.k] = vals[i]; else delete d[f.k]; });
    return { name: vals.find(Boolean) || '—', value1: null, value2: null, data: JSON.stringify(d) };
  }
  const row = { name: vals[0], value1: null, value2: null, data: null };
  valueCols(l).forEach((c, j) => { row[c.key] = vals[1 + j] || null; });
  return row;
}

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
    return `${r.dq ? '🚫' : r.paid ? '✅' : '⬜'} **${offset + i + 1}.** ${siteTag(r.site)} · ${truncate(r.name.replace(/\*/g, ''), 40)} — ${l.col3 ?? 'Loss'}: ${loss}${addr}`;
  }).join('\n');
}

/** Form lists: one line per answer, each value in `code` so it is easy to copy, then who sent it and when. */
function formRows(l, rows, offset, fields) {
  return rows.map((r, i) => {
    const vals = valuesOf(l, r, fields).map(v => (v ? `\`${truncate(String(v).replace(/`/g, "'"), 60)}\`` : '—'));
    const who = r.user_id ? ` · by <@${r.user_id}>` : '';
    const when = r.created_at ? ` · <t:${Math.floor(r.created_at / 1000)}:R>` : '';
    return `**${offset + i + 1}.** ${vals.join(' · ')}${who}${when}`;
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

  const form = formOf(l), fields = formFields(form);
  let intro = l.description ? `${l.description}\n\n` : '';
  if (isHunt(l)) intro += huntIntro(l);
  if (isForm(l)) {
    intro = form
      ? `${form.open ? '🟢 **Form open**' : '🔴 **Form closed**'} · ${form.one_per_user ? 'one entry per member (sending again updates it)' : 'members can send it more than once'}\n`
        + `Columns: ${fields.map(f => `**${f.label}**`).join(' · ')}\n\n`
      : '⚠️ The form for this list was deleted.\n\n';
  }
  const body = !rows.length ? '*Nothing here yet.*'
    : isLB(l) ? lossbackRows(l, rows, page * size)
      : isForm(l) ? formRows(l, rows, page * size, fields)
        : isHunt(l) ? huntTable(l, rows, page * size)
          : table(l, rows, page * size);
  const embed = new EmbedBuilder().setColor(isForm(l) && form && !form.open ? '#E67E22' : COLOR).setTitle(truncate(`📋 ${l.title}`, 256))
    .setDescription(truncate(`${intro}${body}`, 4000))
    .setFooter({ text: `${total} ${total === 1 ? 'entry' : 'entries'}${pages > 1 ? ` · Page ${page + 1}/${pages}` : ''} · List #${l.id}${form ? ` · Form #${form.id}` : ''}` })
    .setTimestamp();

  const components = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ls:add:${l.id}`).setLabel('Add').setEmoji('➕').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`ls:bulk:${l.id}`).setLabel('Bulk add').setEmoji('📥').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ls:bedit:${l.id}`).setLabel('Bulk edit').setEmoji('📝').setStyle(ButtonStyle.Secondary).setDisabled(!total),
    new ButtonBuilder().setCustomId(`ls:edit:${l.id}`).setLabel('Edit').setEmoji('✏️').setStyle(ButtonStyle.Primary).setDisabled(!total),
    new ButtonBuilder().setCustomId(`ls:rem:${l.id}`).setLabel('Remove').setEmoji('🗑️').setStyle(ButtonStyle.Danger).setDisabled(!total),
  )];
  const second = [];
  if (isLB(l)) second.push(
    new ButtonBuilder().setCustomId(`ls:paid:${l.id}`).setLabel('Mark paid').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(!total),
    new ButtonBuilder().setCustomId(`ls:dq:${l.id}`).setLabel('Disqualify').setEmoji('🚫').setStyle(ButtonStyle.Danger).setDisabled(!total),
  );
  if (form) second.push(
    new ButtonBuilder().setCustomId(`fm:edit:${form.id}`).setLabel('Edit form').setEmoji('⚙️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`fm:toggle:${form.id}`).setLabel(form.open ? 'Close form' : 'Open form').setEmoji(form.open ? '🔒' : '🔓')
      .setStyle(form.open ? ButtonStyle.Danger : ButtonStyle.Success),
  );
  else if (!isForm(l)) {
    if (isHunt(l)) second.push(new ButtonBuilder().setCustomId(`ls:calc:${l.id}`).setLabel('Calculate').setEmoji('🧮').setStyle(ButtonStyle.Success).setDisabled(!total));
    second.push(new ButtonBuilder().setCustomId(`ls:set:${l.id}`).setLabel('Settings').setEmoji('⚙️').setStyle(ButtonStyle.Secondary));
    if (!isLB(l)) second.push(new ButtonBuilder().setCustomId(`ls:hunt:${l.id}`).setLabel(isHunt(l) ? 'Community hunt: on' : 'Community hunt')
      .setEmoji('🎯').setStyle(isHunt(l) ? ButtonStyle.Primary : ButtonStyle.Secondary));
  }
  if (second.length) components.push(new ActionRowBuilder().addComponents(second));
  // Bottom row (anyone): pages and Copy all
  const nav = [];
  if (pages > 1) nav.push(
    new ButtonBuilder().setCustomId(`ls:pg:${l.id}:-1`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`ls:pg:${l.id}:1`).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
  );
  nav.push(new ButtonBuilder().setCustomId(`ls:copy:${l.id}`).setLabel('Copy all').setEmoji('📄').setStyle(ButtonStyle.Secondary).setDisabled(!total));
  components.push(new ActionRowBuilder().addComponents(nav));
  return { embeds: [embed], components };
}

// ---------- Copy all ----------

const COPY_BOX_MAX = 4000;     // a Discord text box holds 4000 characters

/** Every entry as plain text, one per line, columns split by " | " (the same format Bulk add reads). */
function copyText(l) {
  const fields = formFields(formOf(l));
  const flat = v => String(v ?? '').replace(/\s+/g, ' ').trim();
  const status = r => (r.dq ? 'disqualified' : r.paid ? 'paid' : 'waiting');
  const rows = db.prepare('SELECT * FROM list_entries WHERE list_id = ? ORDER BY id').all(l.id);
  const m = isHunt(l) ? huntMath(l, rows) : null;
  const back = r => { const b = m && m.back(r); return b == null ? [] : [fmtMoney(b, m.cur)]; };
  return rows
    .map(r => [...valuesOf(l, r, fields).map(flat), ...(isLB(l) ? [status(r)] : []), ...back(r)].join(' | ').replace(/( \| )+$/, ''))
    .join('\n');
}

/** Copy all: a pop-up with every entry in a text box (easy to select and copy), or a .txt file when the list is too long for it. */
async function copyAll(interaction, l) {
  const text = copyText(l);
  if (!text) return interaction.reply(eph({ content: 'The list is empty.' }));
  const cols = [...heads(l), ...(isLB(l) ? ['Status'] : []), ...(isHunt(l) && huntMath(l).mult !== null ? ['Back'] : [])].join(' | ');
  if (text.length <= COPY_BOX_MAX) {
    const box = new TextInputBuilder().setCustomId('text').setStyle(TextInputStyle.Paragraph).setMaxLength(COPY_BOX_MAX).setRequired(false).setValue(text);
    return interaction.showModal(new ModalBuilder().setCustomId(`lscopy:${l.id}`).setTitle(truncate(`Copy: ${l.title}`, 45)).addLabelComponents(
      new LabelBuilder().setLabel(truncate(`${countEntries(l.id)} entries · select all and copy`, 45))
        .setDescription(truncate(`One per line: ${cols}. Ctrl+A then Ctrl+C on PC.`, 100)).setTextInputComponent(box)));
  }
  const name = `${String(l.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'list'}-${l.id}.txt`;
  return interaction.reply(eph({
    content: `📄 **${l.title}** is too long for a text box, so here it is as a file (one entry per line: ${cols}).`,
    files: [new AttachmentBuilder(Buffer.from(text, 'utf8'), { name })],
  }));
}

// Lists posted before a new button existed are re-drawn once when the bot starts, so they get it too.
const LIST_UI_VERSION = 3;     // 2 = Copy all · 3 = Community hunt button
try { db.exec('ALTER TABLE lists ADD COLUMN ui_v INTEGER DEFAULT 0'); } catch { /* already migrated */ }
async function upgradeLists(client) {
  const rows = db.prepare('SELECT id FROM lists WHERE message_id IS NOT NULL AND COALESCE(ui_v, 0) < ?').all(LIST_UI_VERSION);
  for (const { id } of rows) {
    await refreshMessage(client, id);
    db.prepare('UPDATE lists SET ui_v = ? WHERE id = ?').run(LIST_UI_VERSION, id);
    await new Promise(r => setTimeout(r, 1500));     // go easy on Discord's rate limits
  }
  if (rows.length) console.log(`[list] re-drew ${rows.length} posted lists with the new buttons.`);
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

/** Add/edit pop-up: one box per column (c0 = names column, or the form's first field). */
function entryModal(customId, l, e = null) {
  const vals = e ? valuesOf(l, e) : [];
  const m = new ModalBuilder().setCustomId(customId).setTitle(truncate(e ? 'Edit entry' : 'Add entry', 45));
  heads(l).slice(0, 5).forEach((h, i) => m.addComponents(field(`c${i}`, h, TextInputStyle.Short, 100, !isForm(l) && i === 0, vals[i])));
  return m;
}

/** The values typed in an add / edit pop-up, in column order. */
const modalValues = (interaction, l) => heads(l).slice(0, 5).map((_, i) => (interaction.fields.fields.has(`c${i}`) ? clean(interaction.fields.getTextInputValue(`c${i}`), 100) : ''));

/** The select menu used by Edit and Remove: the entries on the page currently shown. */
function pageRows(l) {
  const size = psize(l);
  const pages = Math.max(1, Math.ceil(countEntries(l.id) / size));
  const page = Math.min(Math.max(l.page ?? 0, 0), pages - 1);
  return { page, rows: db.prepare('SELECT * FROM list_entries WHERE list_id = ? ORDER BY id LIMIT ? OFFSET ?').all(l.id, size, page * size) };
}

function entryPicker(l, kind) {
  const { page, rows: all } = pageRows(l);
  const rows = kind === 'dq' ? all.filter(r => !r.paid) : all;          // a paid lossback can't be disqualified
  if (!rows.length) return null;
  const mark = r => (kind === 'paid' ? (r.paid ? '✅ ' : '⬜ ') : kind === 'dq' ? (r.dq ? '🚫 ' : '⬜ ') : '');
  const menu = new StringSelectMenuBuilder().setCustomId(`lssel:${kind}:${l.id}`)
    .setPlaceholder({ edit: 'Which entry do you want to edit?', rem: 'Pick the entries to remove…', paid: 'Pick entries to toggle paid / unpaid…', dq: 'Which entry do you want to disqualify?' }[kind])
    .addOptions(rows.map(r => {
      const [first, ...rest] = valuesOf(l, r);
      const opt = { label: truncate(`${mark(r)}${page * psize(l) + all.indexOf(r) + 1}. ${first || r.name}`, 100), value: String(r.id) };
      const desc = rest.filter(Boolean).join(' · ');
      if (desc) opt.description = truncate(desc, 100);
      return opt;
    }));
  if (kind !== 'edit' && kind !== 'dq') menu.setMinValues(1).setMaxValues(rows.length);
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
    .addBooleanOption(o => o.setName('community_hunt').setDescription('Community hunt: Username | Amount | Source, and a Calculate button for everyone\'s return'))
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
    const hunt = interaction.options.getBoolean('community_hunt') === true;
    let id;
    try {
      id = await createList(target, {
        guildId: g, userId: interaction.user.id, title: interaction.options.getString('title'),
        description: interaction.options.getString('description')?.trim() || null,
        col1: hunt ? HUNT_COLS[0] : clean(interaction.options.getString('name_header'), 30) || 'Name',
        col2: hunt ? HUNT_COLS[1] : clean(interaction.options.getString('value1'), 30) || null,
        col3: hunt ? HUNT_COLS[2] : clean(interaction.options.getString('value2'), 30) || null,
        kind: hunt ? 'hunt' : null,
      });
    } catch (e) {
      return interaction.reply(eph({ content: `❌ Couldn't post the list there: ${e.message}` }));
    }
    await logToGuild(interaction.client, g, `📋 <@${interaction.user.id}> created list **${clean(interaction.options.getString('title'), 100)}** (#${id}) in ${target}.`);
    return interaction.reply(eph({ content: hunt
      ? `✅ Community hunt posted in ${target}. **Add** or **Bulk add** people (\`Username | Amount | Source\`), then press **Calculate** with the starting and ending balance.`
      : `✅ List posted in ${target}. Use its **Add** button to fill it, or **Settings** to rename it and change the columns.` }));
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
    await interaction.deferReply(eph());
    const form = formOf(l);
    if (form) await require('./form').deleteForm(interaction.client, form, false);   // its panels go too; the list is deleted below
    db.prepare('DELETE FROM list_entries WHERE list_id = ?').run(l.id);
    db.prepare('DELETE FROM lists WHERE id = ?').run(l.id);
    try { await (await (await interaction.client.channels.fetch(l.channel_id)).messages.fetch(l.message_id)).delete(); } catch { /* already gone */ }
    await logToGuild(interaction.client, g, `📋 <@${interaction.user.id}> deleted list **${l.title}** (#${l.id})${form ? ' and its form' : ''}.`);
    return interaction.editReply({ content: `🗑️ List **${l.title}** deleted${form ? ', with its form and panel buttons' : ''}.` });
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

    // Copy all is open to everyone too: it only shows what the list already shows
    if (action === 'copy') return copyAll(interaction, l);

    if (!isMod(interaction)) return interaction.reply(eph({ content: '❌ Only staff can change this list.' }));
    if (isForm(l) && !formOf(l)) return interaction.reply(eph({ content: '❌ The form for this list was deleted. Delete the list with `/list delete`.' }));

    if (action === 'add') return interaction.showModal(entryModal(`lsadd:${l.id}`, l));

    if (action === 'hunt') {
      if (isLB(l) || isForm(l)) return interaction.reply(eph({ content: 'Lossback and form lists can\'t be a community hunt.' }));
      const on = toggleHunt(l) === 'hunt';
      await logToGuild(interaction.client, interaction.guildId, `🎯 <@${interaction.user.id}> switched community hunt ${on ? 'on' : 'off'} for list **${l.title}** (#${l.id}).`);
      return interaction.update(render(l.id));
    }

    if (action === 'calc') {
      if (!isHunt(l)) return interaction.reply(eph({ content: 'Switch **Community hunt** on first.' }));
      const m = huntMath(l);
      const amt = n => (n == null ? null : String(Math.round(n * 100) / 100));
      return interaction.showModal(new ModalBuilder().setCustomId(`lscalc:${l.id}`).setTitle('Calculate the community hunt').addComponents(
        field('start', truncate(`Starting balance (everyone put in ${fmtMoney(m.total, m.cur)})`, 45), TextInputStyle.Short, 20, false, amt(m.startIsTotal ? null : m.start), `Empty = ${amt(m.total)} (the total put in)`),
        field('end', 'Ending balance', TextInputStyle.Short, 20, true, amt(m.end), 'What the hunt ended with, e.g. 1840.50'),
      ));
    }

    if (action === 'bulk') {
      const cols = heads(l);
      return interaction.showModal(new ModalBuilder().setCustomId(`lsbulk:${l.id}`).setTitle('Bulk add entries').addComponents(
        field('lines', `One per line: ${cols.join(' | ')}`, TextInputStyle.Paragraph, 4000, true, null,
          `${['Alice', '$25', 'Paid'].slice(0, cols.length).join(' | ')}\n${['Bob', '$10', 'Pending'].slice(0, cols.length).join(' | ')}`)));
    }

    if (action === 'bedit') {
      const { page, rows } = pageRows(l);
      const lines = [];
      let len = 0;
      for (const r of rows) {
        const line = valuesOf(l, r).map(x => String(x).replace(/\|/g, '/')).join(' | ');
        if (len + line.length + 1 > 3900) break;
        lines.push(line); len += line.length + 1;
      }
      return interaction.showModal(new ModalBuilder().setCustomId(`lsbedit:${l.id}:${page}:${lines.length}`).setTitle(`Bulk edit (page ${page + 1})`).addComponents(
        field('lines', truncate(`${heads(l).join(' | ')} — keep the line order`, 45), TextInputStyle.Paragraph, 4000, true, lines.join('\n'))));
    }

    if (action === 'edit' || action === 'rem' || action === 'paid' || action === 'dq') {
      if ((action === 'paid' || action === 'dq') && !isLB(l)) return interaction.reply(eph({ content: 'Paid marks and disqualifying are only on lossback lists.' }));
      const picker = entryPicker(l, action);
      if (!picker) return interaction.reply(eph({ content: action === 'dq' ? 'Nothing to disqualify on this page (paid entries can\'t be disqualified).' : 'The list is empty.' }));
      const total = countEntries(l.id);
      const more = total > psize(l) ? '\n*(Shows the page currently displayed — use ◀ ▶ on the list to reach other entries.)*' : '';
      return interaction.reply(eph({
        content: { edit: '✏️ Pick the entry to edit:', rem: '🗑️ Pick one or more entries to remove:', paid: '✅ Pick the entries to mark as paid (picking a paid one marks it unpaid again). The member gets a DM when it is paid.', dq: '🚫 Pick the entry to disqualify. You can give a reason; the member gets a DM. (Picking a 🚫 one removes the disqualification.)' }[action] + more,
        components: [picker],
      }));
    }

    if (action === 'set') {
      if (isForm(l)) return interaction.reply(eph({ content: 'This list belongs to a form: use its **Edit form** button to change the title and fields.' }));
      if (isHunt(l)) return interaction.showModal(new ModalBuilder().setCustomId(`lsset:${l.id}`).setTitle('Community hunt settings').addComponents(
        field('title', 'Title', TextInputStyle.Short, 100, true, l.title),
        field('description', 'Text shown above the list (optional)', TextInputStyle.Paragraph, 500, false, l.description),
      ));
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
      const before = db.prepare(`SELECT * FROM list_entries WHERE ${q}`).all(l.id, ...ids);
      db.prepare(`UPDATE list_entries SET paid = 1 - COALESCE(paid, 0) WHERE ${q}`).run(l.id, ...ids);
      await refreshMessage(interaction.client, l.id);
      for (const e of before) if (!e.paid) notifyLossback(interaction.client, e, 'paid').catch(() => {});   // don't make staff wait on the DMs
      await logToGuild(interaction.client, interaction.guildId, `✅ <@${interaction.user.id}> toggled paid on ${before.map(b => `**${b.name}** (${b.paid ? 'now unpaid' : 'now paid'})`).join(', ')} in list **${l.title}**.`);
      return interaction.update({ content: `✅ Updated ${before.length} ${before.length === 1 ? 'entry' : 'entries'}.`, components: [] });
    }

    if (kind === 'dq') {
      const e = db.prepare('SELECT * FROM list_entries WHERE id = ? AND list_id = ?').get(Number(interaction.values[0]), l.id);
      if (!e) return interaction.update({ content: '❌ That entry no longer exists.', components: [] });
      if (e.paid) return interaction.update({ content: '❌ That lossback is already paid, so it can\'t be disqualified.', components: [] });
      if (e.dq) {                                                       // undo
        db.prepare('UPDATE list_entries SET dq = 0, dq_reason = NULL WHERE id = ?').run(e.id);
        forget(e.id, 'dq');
        await refreshMessage(interaction.client, l.id);
        await logToGuild(interaction.client, interaction.guildId, `↩️ <@${interaction.user.id}> removed the disqualification of **${e.name}** in list **${l.title}**.`);
        return interaction.update({ content: `↩️ **${e.name}** is no longer disqualified.`, components: [] });
      }
      return interaction.showModal(new ModalBuilder().setCustomId(`lsdq:${l.id}:${e.id}`).setTitle(truncate(`Disqualify ${e.name}`, 45))
        .addComponents(field('reason', 'Reason (sent to the member)', TextInputStyle.Paragraph, 200, false, null, 'e.g. Wager was below the minimum / played on another code')));
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
  // "Submit" on the Copy all pop-up: nothing to save
  async lscopy(interaction) { return interaction.deferUpdate().catch(() => interaction.reply(eph({ content: '👍' }))); },

  async lsadd(interaction, [idStr]) {
    if (!requireMod(interaction)) return;
    const l = getList(Number(idStr));
    if (!l) return interaction.reply(eph({ content: '❌ This list no longer exists.' }));
    if (countEntries(l.id) >= MAX_ENTRIES) return interaction.reply(eph({ content: `❌ A list can hold up to ${MAX_ENTRIES} entries.` }));
    const vals = modalValues(interaction, l);
    if (!vals.some(Boolean)) return interaction.reply(eph({ content: '❌ Fill in at least one box.' }));
    const r = toRow(l, vals);
    db.prepare('INSERT INTO list_entries (list_id, name, value1, value2, data) VALUES (?, ?, ?, ?, ?)').run(l.id, r.name, r.value1, r.value2, r.data);
    return applyChange(interaction, l.id, `✅ Added **${r.name}**.`);
  },

  async lsedit(interaction, [idStr, entryId]) {
    if (!requireMod(interaction)) return;
    const l = getList(Number(idStr));
    if (!l) return interaction.reply(eph({ content: '❌ This list no longer exists.' }));
    const e = db.prepare('SELECT * FROM list_entries WHERE id = ? AND list_id = ?').get(Number(entryId), l.id);
    if (!e) return interaction.reply(eph({ content: '❌ That entry no longer exists.' }));
    const vals = modalValues(interaction, l);
    if (!vals.some(Boolean)) return interaction.reply(eph({ content: '❌ Fill in at least one box (use **Remove** to delete an entry).' }));
    const r = toRow(l, vals, e);
    db.prepare('UPDATE list_entries SET name = ?, value1 = ?, value2 = ?, data = ? WHERE id = ?').run(r.name, r.value1, r.value2, r.data, e.id);
    return applyChange(interaction, l.id, `✅ Updated **${r.name}**.`);
  },

  async lsbulk(interaction, [idStr]) {
    if (!requireMod(interaction)) return;
    const l = getList(Number(idStr));
    if (!l) return interaction.reply(eph({ content: '❌ This list no longer exists.' }));
    const room = MAX_ENTRIES - countEntries(l.id);
    const parsed = interaction.fields.getTextInputValue('lines').split('\n')
      .map(line => line.split('|').map(p => clean(p, 100)))
      .filter(parts => (isForm(l) ? parts.some(Boolean) : parts[0]));
    const entries = parsed.slice(0, Math.max(0, room));
    const add = db.prepare('INSERT INTO list_entries (list_id, name, value1, value2, data) VALUES (?, ?, ?, ?, ?)');
    const fields = formFields(formOf(l));
    db.transaction(() => { for (const parts of entries) { const r = toRow(l, parts, null, fields); add.run(l.id, r.name, r.value1, r.value2, r.data); } })();
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
    const fields = formFields(formOf(l));
    const width = heads(l).length;
    const lines = interaction.fields.getTextInputValue('lines').split('\n').map(line => line.split('|').map(p => clean(p, 100)));
    const upd = db.prepare('UPDATE list_entries SET name = ?, value1 = ?, value2 = ?, data = ? WHERE id = ?');
    const ins = db.prepare('INSERT INTO list_entries (list_id, name, value1, value2, data) VALUES (?, ?, ?, ?, ?)');
    const same = (a, b) => Array.from({ length: width }, (_, j) => (a[j] || '') === (b[j] || '')).every(Boolean);
    let changed = 0, added = 0, room = MAX_ENTRIES - countEntries(l.id);
    db.transaction(() => {
      lines.forEach((parts, i) => {
        if (isForm(l) ? !parts.some(Boolean) : !parts[0]) return;
        if (i < rows.length) {
          const old = rows[i];
          if (!same(valuesOf(l, old, fields), parts)) { const r = toRow(l, parts, old, fields); upd.run(r.name, r.value1, r.value2, r.data, old.id); changed++; }
        } else if (room > 0) { const r = toRow(l, parts, null, fields); ins.run(l.id, r.name, r.value1, r.value2, r.data); added++; room--; }
      });
    })();
    return applyChange(interaction, l.id, `✅ Bulk edit saved: ${changed} updated, ${added} added.`);
  },

  async lsdq(interaction, [idStr, entryId]) {
    if (!requireMod(interaction)) return;
    const l = getList(Number(idStr));
    const done = content => (interaction.isFromMessage() ? interaction.update({ content, components: [] }) : interaction.reply(eph({ content })));
    if (!l) return done('❌ This list no longer exists.');
    const e = db.prepare('SELECT * FROM list_entries WHERE id = ? AND list_id = ?').get(Number(entryId), l.id);
    if (!e) return done('❌ That entry no longer exists.');
    if (e.paid) return done('❌ That lossback is already paid, so it can\'t be disqualified.');
    if (e.dq) return done(`🚫 **${e.name}** is already disqualified.`);
    const reason = clean(interaction.fields.getTextInputValue('reason'), 200);
    db.prepare('UPDATE list_entries SET dq = 1, dq_reason = ? WHERE id = ?').run(reason || null, e.id);
    await refreshMessage(interaction.client, l.id);
    await logToGuild(interaction.client, interaction.guildId, `🚫 <@${interaction.user.id}> disqualified lossback **${e.name}** in list **${l.title}**${reason ? `: ${reason}` : ''}.`);
    await done(`🚫 **${e.name}** is disqualified.${e.user_id ? ' Sending them a DM…' : ' (No Discord account on this entry, so nobody to DM.)'}`);
    if (e.user_id) {
      const sent = await notifyLossback(interaction.client, e, 'dq', reason);
      if (!sent) await interaction.followUp(eph({ content: '📭 I couldn\'t DM them (DMs closed?). It\'s noted in the log channel.' })).catch(() => {});
    }
  },

  async lscalc(interaction, [idStr]) {
    if (!requireMod(interaction)) return;
    const l = getList(Number(idStr));
    if (!l || !isHunt(l)) return interaction.reply(eph({ content: '❌ This community hunt no longer exists.' }));
    const rawStart = interaction.fields.getTextInputValue('start').trim(), rawEnd = interaction.fields.getTextInputValue('end').trim();
    const start = rawStart === '' ? null : parseAmount(rawStart), end = parseAmount(rawEnd);
    if (rawStart !== '' && (start === null || start <= 0)) return interaction.reply(eph({ content: '❌ The starting balance must be a number above 0 (or leave it empty to use the total put in).' }));
    if (end === null || end < 0) return interaction.reply(eph({ content: '❌ The ending balance must be a number (0 or more).' }));
    const h = { ...huntOf(l), start, end };
    db.prepare('UPDATE lists SET hunt = ? WHERE id = ?').run(JSON.stringify(h), l.id);
    const m = huntMath(getList(l.id));
    if (!(m.start > 0)) return interaction.reply(eph({ content: '❌ Nobody has an amount yet, so there is nothing to divide. Add the amounts, or enter a starting balance.' }));
    await logToGuild(interaction.client, interaction.guildId, `🧮 <@${interaction.user.id}> calculated community hunt **${l.title}**: ${fmtMoney(m.start, m.cur)} → ${fmtMoney(m.end, m.cur)} (${multText(m.mult)}).`);
    return applyChange(interaction, l.id, `✅ Calculated: ${fmtMoney(m.start, m.cur)} → ${fmtMoney(m.end, m.cur)} · **${multText(m.mult)}**. Everyone's return is on the list.`);
  },

  async lsset(interaction, [idStr]) {
    if (!requireMod(interaction)) return;
    const l = getList(Number(idStr));
    if (!l) return interaction.reply(eph({ content: '❌ This list no longer exists.' }));
    const t = id => interaction.fields.getTextInputValue(id).trim();
    if (isHunt(l)) {                                                    // the hunt's columns stay Username | Amount | Source
      db.prepare('UPDATE lists SET title = ?, description = ? WHERE id = ?').run(clean(t('title'), 100), t('description') || null, l.id);
      return applyChange(interaction, l.id, '✅ Community hunt settings saved.');
    }
    db.prepare('UPDATE lists SET title = ?, description = ?, col1 = ?, col2 = ?, col3 = ? WHERE id = ?')
      .run(clean(t('title'), 100), t('description') || null, clean(t('col1'), 30) || 'Name', clean(t('col2'), 30) || null, clean(t('col2'), 30) ? clean(t('col3'), 30) || null : null, l.id);
    return applyChange(interaction, l.id, '✅ List settings saved.');
  },
};

module.exports = { data, execute, autocomplete, buttons, selects, modals, createList, refreshMessage, getList, render, countEntries, MAX_ENTRIES, upgradeLists };
