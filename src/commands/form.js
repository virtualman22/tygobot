/**
 * /form — custom forms. Staff design one in a pop-up (title + up to 5 fields); the bot creates an empty staff list for it
 * and posts a public panel with a button. Members press the button, fill in the fields, and their answers land on the list.
 *
 * Staff control everything from the list itself: ⚙️ Edit form (same pop-up: title, fields, panel text, button, entries per member)
 * and 🔒 Close / 🔓 Open. Panels update by themselves after every change.
 */
const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle, LabelBuilder,
  StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
} = require('discord.js');
const { db } = require('../db');
const { eph, isMod, requireMod, truncate, logToGuild } = require('../utils');
const { createList, refreshMessage, getList, render, countEntries, MAX_ENTRIES } = require('./list');

const MAX_FIELDS = 5;                 // Discord pop-ups hold 5 boxes
const DEFAULT_BUTTON = 'Fill in the form';
const textTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread];

// ---------- helpers ----------

const getForm = id => db.prepare('SELECT * FROM forms WHERE id = ?').get(Number(id));
const parseJson = (s, fb) => { try { return JSON.parse(s) ?? fb; } catch { return fb; } };
const fieldsOf = f => parseJson(f.fields, []);
const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const listLink = (f, l) => (l?.message_id ? `https://discord.com/channels/${f.guild_id}/${l.channel_id}/${l.message_id}` : null);

/**
 * "Kick username\nComment (optional)" -> [{ k, label, required }].
 * A field keeps its key when its name stays the same, so answers already given stay under the right column after an edit.
 */
function parseFields(text, old = []) {
  const lines = String(text ?? '').split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!lines.length) return { error: 'Add at least one field (one per line).' };
  if (lines.length > MAX_FIELDS) return { error: `A form can have up to ${MAX_FIELDS} fields (you wrote ${lines.length}): Discord pop-ups can't hold more.` };
  let next = Math.max(0, ...old.map(o => Number(String(o.k).slice(1)) || 0)) + 1;
  const taken = new Set(), fields = [];
  for (const line of lines) {
    const optional = /\(optional\)$/i.test(line);
    const label = line.replace(/\s*\(optional\)$/i, '').trim().slice(0, 45);
    if (!label) return { error: 'A field needs a name before "(optional)".' };
    if (fields.some(f => f.label.toLowerCase() === label.toLowerCase())) return { error: `Two fields are called **${label}**. Give each one its own name.` };
    const prev = old.find(o => o.label.toLowerCase() === label.toLowerCase() && !taken.has(o.k));
    const k = prev ? prev.k : `f${next++}`;
    taken.add(k);
    fields.push({ k, label, required: !optional });
  }
  return { fields };
}

/** The pop-up staff use to create or edit a form. */
function configModal(customId, f = null) {
  const fields = f ? fieldsOf(f) : [];
  const text = (id, label, desc, style, max, required, value, ph) => {
    const t = new TextInputBuilder().setCustomId(id).setStyle(style).setMaxLength(max).setRequired(required);
    if (value) t.setValue(String(value).slice(0, max));
    if (ph) t.setPlaceholder(ph);
    const lb = new LabelBuilder().setLabel(label).setTextInputComponent(t);
    if (desc) lb.setDescription(desc);
    return lb;
  };
  const one = !f || Boolean(f.one_per_user);
  const per = new StringSelectMenuBuilder().setCustomId('per').addOptions(
    { label: 'One entry per member', description: 'Sending it again updates their entry', value: 'one', default: one },
    { label: 'Unlimited', description: 'Members can send it as many times as they like', value: 'many', default: !one },
  );
  return new ModalBuilder().setCustomId(customId).setTitle(f ? 'Edit form' : 'New form').addLabelComponents(
    text('title', 'Title', 'Shown on the panel and on the staff list', TextInputStyle.Short, 100, true, f?.title, 'e.g. Kick usernames for the raffle'),
    text('fields', 'What members fill in', `One per line, up to ${MAX_FIELDS}. End a line with (optional) to make it optional.`,
      TextInputStyle.Paragraph, 400, true, fields.map(x => (x.required ? x.label : `${x.label} (optional)`)).join('\n'), 'Kick username\nStake username\nComment (optional)'),
    text('description', 'Text on the panel (optional)', 'Leave empty to list the fields', TextInputStyle.Paragraph, 1000, false, f?.description),
    text('button', 'Button text (optional)', `Default: ${DEFAULT_BUTTON}`, TextInputStyle.Short, 40, false, f?.button),
    new LabelBuilder().setLabel('Entries per member').setStringSelectMenuComponent(per),
  );
}

/** Reads the config pop-up. Returns { error } or the values to save. */
function readConfig(interaction, old = []) {
  const t = id => interaction.fields.getTextInputValue(id);
  const parsed = parseFields(t('fields'), old);
  if (parsed.error) return { error: `❌ ${parsed.error}\n\nWhat you wrote, so you can copy it:\n\`\`\`\n${t('fields').replace(/`/g, "'")}\n\`\`\`` };
  return {
    title: clean(t('title'), 100) || 'Form',
    description: t('description').trim().slice(0, 1000) || null,
    button: clean(t('button'), 40) || null,
    one_per_user: (interaction.fields.getStringSelectValues('per')[0] ?? 'one') === 'one' ? 1 : 0,
    fields: parsed.fields,
  };
}

/** The public panel: the form's text, open / closed, and the button. */
function panelPayload(f) {
  const fields = fieldsOf(f);
  const intro = f.description || `Press **${f.button || DEFAULT_BUTTON}** and fill in: ${fields.map(x => `**${x.label}**${x.required ? '' : ' (optional)'}`).join(', ')}.`;
  const note = f.one_per_user ? '\n*One entry per member: sending it again updates yours.*' : '';
  return {
    embeds: [new EmbedBuilder().setColor(f.open ? '#2ECC71' : '#E67E22').setTitle(truncate(`📝 ${f.title}`, 256))
      .setDescription(truncate(`${intro}${note}\n\n${f.open ? '🟢 **Open**' : '🔴 **Closed** right now'}`, 4000))],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`fm:fill:${f.id}`).setLabel(f.button || DEFAULT_BUTTON).setEmoji('📝').setStyle(ButtonStyle.Primary).setDisabled(!f.open))],
  };
}

async function postPanel(f, channel) {
  const msg = await channel.send(panelPayload(f));
  db.prepare('INSERT OR REPLACE INTO form_panels (message_id, channel_id, guild_id, form_id) VALUES (?, ?, ?, ?)').run(msg.id, channel.id, f.guild_id, f.id);
  return msg;
}

/** Re-draws every posted panel of a form (after an edit or open / close). Forgets panels that were deleted. */
async function refreshPanels(client, formId) {
  const f = getForm(formId);
  if (!f) return;
  for (const p of db.prepare('SELECT * FROM form_panels WHERE form_id = ?').all(f.id)) {
    try {
      const msg = await (await client.channels.fetch(p.channel_id)).messages.fetch(p.message_id);
      await msg.edit(panelPayload(f));
    } catch (e) {
      if ([10003, 10008, 50001].includes(e.code)) db.prepare('DELETE FROM form_panels WHERE message_id = ?').run(p.message_id);
      else console.warn('[form] panel refresh failed:', e.message);
    }
  }
}

/** Deletes a form and its panel messages, and its list too when withList is true. */
async function deleteForm(client, f, withList = true) {
  for (const p of db.prepare('SELECT * FROM form_panels WHERE form_id = ?').all(f.id)) {
    try { await (await (await client.channels.fetch(p.channel_id)).messages.fetch(p.message_id)).delete(); } catch { /* already gone */ }
  }
  db.prepare('DELETE FROM form_panels WHERE form_id = ?').run(f.id);
  db.prepare('DELETE FROM forms WHERE id = ?').run(f.id);
  const l = f.list_id && getList(f.list_id);
  if (!l) return;
  if (withList) {
    db.prepare('DELETE FROM list_entries WHERE list_id = ?').run(l.id);
    db.prepare('DELETE FROM lists WHERE id = ?').run(l.id);
    try { await (await (await client.channels.fetch(l.channel_id)).messages.fetch(l.message_id)).delete(); } catch { /* already gone */ }
  } else {
    await refreshMessage(client, l.id);
  }
}

/** Can the bot post an embed in this channel? */
function canPost(channel, guild) {
  const perms = channel?.permissionsFor?.(guild.members.me);
  return Boolean(perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]));
}

// ---------- command ----------

const pickForm = o => o.setName('form').setDescription('Which form').setRequired(true).setAutocomplete(true);

const data = new SlashCommandBuilder()
  .setName('form')
  .setDescription('Custom forms: a button members fill in, answers collected in a staff list')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand(s => s.setName('create').setDescription('Design a new form in a pop-up. Creates its empty list and posts the button')
    .addChannelOption(o => o.setName('list_channel').setDescription('STAFF channel where the answers are listed').setRequired(true).addChannelTypes(...textTypes))
    .addChannelOption(o => o.setName('channel').setDescription('Where to post the button for members (default: this channel)').addChannelTypes(...textTypes)))
  .addSubcommand(s => s.setName('panel').setDescription('Post the button of an existing form again (in another channel, or after it was deleted)')
    .addStringOption(pickForm)
    .addChannelOption(o => o.setName('channel').setDescription('Where to post it (default: this channel)').addChannelTypes(...textTypes)))
  .addSubcommand(s => s.setName('all').setDescription('Show every form with its list'))
  .addSubcommand(s => s.setName('delete').setDescription('Delete a form, its buttons and its list of answers')
    .addStringOption(pickForm));

async function execute(interaction) {
  if (!requireMod(interaction)) return;
  const sub = interaction.options.getSubcommand();
  const g = interaction.guildId;

  if (sub === 'create') {
    const listCh = interaction.options.getChannel('list_channel');
    const panelCh = interaction.options.getChannel('channel') ?? interaction.channel;
    for (const ch of [listCh, panelCh]) {
      if (!canPost(ch, interaction.guild)) return interaction.reply(eph({ content: `❌ I can't post in ${ch}. Give me View Channel, Send Messages and Embed Links there first.` }));
    }
    return interaction.showModal(configModal(`fmcfg:new:${listCh.id}:${panelCh.id}`));
  }

  if (sub === 'all') {
    const rows = db.prepare('SELECT * FROM forms WHERE guild_id = ? ORDER BY id DESC LIMIT 25').all(g);
    if (!rows.length) return interaction.reply(eph({ content: 'No forms yet. Make one with `/form create`.' }));
    const lines = rows.map(f => {
      const l = f.list_id && getList(f.list_id);
      const link = listLink(f, l);
      const panels = db.prepare('SELECT COUNT(*) c FROM form_panels WHERE form_id = ?').get(f.id).c;
      return `\`#${f.id}\` **${truncate(f.title, 60)}** — ${f.open ? '🟢 open' : '🔴 closed'} · ${l ? countEntries(l.id) : 0} answers · ${panels} ${panels === 1 ? 'button' : 'buttons'}${link ? ` · [list](${link})` : ''}`;
    });
    return interaction.reply(eph({ embeds: [new EmbedBuilder().setColor('#9146FF').setTitle('📝 Forms').setDescription(lines.join('\n'))] }));
  }

  const f = getForm(interaction.options.getString('form'));
  if (!f || f.guild_id !== g) return interaction.reply(eph({ content: '❌ Form not found.' }));

  if (sub === 'panel') {
    const target = interaction.options.getChannel('channel') ?? interaction.channel;
    try { await postPanel(f, target); } catch (e) { return interaction.reply(eph({ content: `❌ Couldn't post there: ${e.message}` })); }
    return interaction.reply(eph({ content: `✅ Button for **${f.title}** posted in ${target}.` }));
  }

  if (sub === 'delete') {
    await interaction.deferReply(eph());
    await deleteForm(interaction.client, f, true);
    await logToGuild(interaction.client, g, `📝 <@${interaction.user.id}> deleted form **${f.title}** (#${f.id}) with its list and buttons.`);
    return interaction.editReply({ content: `🗑️ Form **${f.title}** deleted, with its list and buttons.` });
  }
}

async function autocomplete(interaction) {
  const q = String(interaction.options.getFocused());
  const rows = db.prepare('SELECT id, title, open FROM forms WHERE guild_id = ? AND title LIKE ? ORDER BY id DESC LIMIT 25').all(interaction.guildId, `%${q}%`);
  await interaction.respond(rows.map(r => ({ name: truncate(`#${r.id} ${r.title}${r.open ? '' : ' (closed)'}`, 100), value: String(r.id) })));
}

// ---------- buttons: fm:fill (members), fm:edit and fm:toggle (staff, on the list) ----------

const myEntry = (f, userId) => db.prepare('SELECT * FROM list_entries WHERE list_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1').get(f.list_id, userId);

const buttons = {
  async fm(interaction, [action, idStr]) {
    const f = getForm(idStr);
    if (!f) return interaction.reply(eph({ content: '❌ This form no longer exists.' }));

    if (action === 'fill') {
      if (!f.open) return interaction.reply(eph({ content: `🔴 **${f.title}** is closed right now.` }));
      const l = f.list_id && getList(f.list_id);
      if (!l) return interaction.reply(eph({ content: '❌ This form isn\'t set up properly (its list is gone). Please tell a mod.' }));
      const prev = f.one_per_user ? myEntry(f, interaction.user.id) : null;
      if (!prev && countEntries(l.id) >= MAX_ENTRIES) return interaction.reply(eph({ content: '❌ This form is full. Please tell a mod.' }));
      const d = prev ? parseJson(prev.data, {}) : {};
      const m = new ModalBuilder().setCustomId(`fmsub:${f.id}`).setTitle(truncate(f.title, 45));
      for (const [i, x] of fieldsOf(f).entries()) {
        const t = new TextInputBuilder().setCustomId(`v_${x.k}`).setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(x.required);
        if (d[x.k]) t.setValue(String(d[x.k]).slice(0, 100));
        const lb = new LabelBuilder().setLabel(x.label).setTextInputComponent(t);
        if (prev && i === 0) lb.setDescription('You already sent this form: change anything and send it again to update it');
        m.addLabelComponents(lb);
      }
      return interaction.showModal(m);
    }

    if (!isMod(interaction)) return interaction.reply(eph({ content: '❌ Only staff can change this form.' }));

    if (action === 'edit') return interaction.showModal(configModal(`fmcfg:edit:${f.id}`, f));

    if (action === 'toggle') {
      db.prepare('UPDATE forms SET open = 1 - open WHERE id = ?').run(f.id);
      const open = !f.open;
      await logToGuild(interaction.client, f.guild_id, `📝 <@${interaction.user.id}> ${open ? 'opened' : 'closed'} form **${f.title}** (#${f.id}).`);
      const l = f.list_id && getList(f.list_id);
      if (l && interaction.message?.id === l.message_id) await interaction.update(render(l.id));
      else { if (l) await refreshMessage(interaction.client, l.id); await interaction.reply(eph({ content: `✅ **${f.title}** is now ${open ? 'open' : 'closed'}.` })); }
      return refreshPanels(interaction.client, f.id);
    }
  },
};

// ---------- pop-ups ----------

const modals = {
  // Create (fmcfg:new:<listChannel>:<panelChannel>) or edit (fmcfg:edit:<formId>) a form
  async fmcfg(interaction, [mode, a, b]) {
    if (!requireMod(interaction)) return;
    const g = interaction.guildId;

    if (mode === 'edit') {
      const f = getForm(a);
      if (!f) return interaction.reply(eph({ content: '❌ This form no longer exists.' }));
      const v = readConfig(interaction, fieldsOf(f));
      if (v.error) return interaction.reply(eph({ content: v.error }));
      db.prepare('UPDATE forms SET title = ?, description = ?, button = ?, one_per_user = ?, fields = ? WHERE id = ?')
        .run(v.title, v.description, v.button, v.one_per_user, JSON.stringify(v.fields), f.id);
      if (f.list_id) db.prepare('UPDATE lists SET title = ?, col1 = ? WHERE id = ?').run(v.title, v.fields[0].label.slice(0, 30), f.list_id);
      await logToGuild(interaction.client, g, `📝 <@${interaction.user.id}> edited form **${v.title}** (#${f.id}).`);
      const l = f.list_id && getList(f.list_id);
      if (l && interaction.isFromMessage() && interaction.message?.id === l.message_id) await interaction.update(render(l.id));
      else { if (l) await refreshMessage(interaction.client, l.id); await interaction.reply(eph({ content: `✅ Form **${v.title}** saved. Its buttons update by themselves.` })); }
      return refreshPanels(interaction.client, f.id);
    }

    // new form
    const v = readConfig(interaction);
    if (v.error) return interaction.reply(eph({ content: v.error }));
    await interaction.deferReply(eph());
    const fetch = id => interaction.client.channels.fetch(id).catch(() => null);
    const [listCh, panelCh] = [await fetch(a), await fetch(b)];
    if (!listCh || !panelCh) return interaction.editReply({ content: '❌ I can\'t find one of the channels any more. Run `/form create` again.' });

    const res = db.prepare('INSERT INTO forms (guild_id, title, description, fields, button, one_per_user, open, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)')
      .run(g, v.title, v.description, JSON.stringify(v.fields), v.button, v.one_per_user, interaction.user.id, Date.now());
    const formId = Number(res.lastInsertRowid);
    let listId;
    try {
      listId = await createList(listCh, { guildId: g, userId: interaction.user.id, kind: 'form', title: v.title, col1: v.fields[0].label.slice(0, 30) });
    } catch (e) {
      db.prepare('DELETE FROM forms WHERE id = ?').run(formId);
      return interaction.editReply({ content: `❌ Couldn't post the list in ${listCh}: ${e.message}` });
    }
    db.prepare('UPDATE forms SET list_id = ? WHERE id = ?').run(listId, formId);
    await refreshMessage(interaction.client, listId);          // the list was drawn before it knew its form

    let panelNote;
    try { await postPanel(getForm(formId), panelCh); panelNote = `the button is in ${panelCh}`; }
    catch (e) { panelNote = `⚠️ couldn't post the button in ${panelCh} (${e.message}). Use \`/form panel\` to post it somewhere else`; }
    await logToGuild(interaction.client, g, `📝 <@${interaction.user.id}> created form **${v.title}** (#${formId}): list in ${listCh}, button in ${panelCh}.`);
    return interaction.editReply({ content: `✅ Form **${v.title}** created. The empty list is in ${listCh} and ${panelNote}.\nChange the title or fields any time with **Edit form** on the list; **Close form** stops new answers.` });
  },

  // A member sends the form (fmsub:<formId>)
  async fmsub(interaction, [idStr]) {
    const f = getForm(idStr);
    if (!f) return interaction.reply(eph({ content: '❌ This form no longer exists.' }));
    if (!f.open) return interaction.reply(eph({ content: `🔴 **${f.title}** was closed before you sent it. Nothing was saved.` }));
    const l = f.list_id && getList(f.list_id);
    if (!l) return interaction.reply(eph({ content: '❌ This form isn\'t set up properly (its list is gone). Please tell a mod.' }));

    const fields = fieldsOf(f);
    const has = id => interaction.fields.fields.has(id);
    // Fields added by staff while the pop-up was open aren't in it: a required one missing means the member must try again
    if (fields.some(x => x.required && !has(`v_${x.k}`))) return interaction.reply(eph({ content: '⚠️ Staff changed this form while you were filling it in. Please press the button again.' }));
    const answers = Object.fromEntries(fields.filter(x => has(`v_${x.k}`)).map(x => [x.k, clean(interaction.fields.getTextInputValue(`v_${x.k}`), 100)]).filter(([, val]) => val));
    if (!Object.keys(answers).length) return interaction.reply(eph({ content: '❌ You didn\'t fill anything in, so nothing was saved.' }));

    const vals = fields.map(x => answers[x.k] || '');
    const name = vals.find(Boolean);
    const prev = f.one_per_user ? myEntry(f, interaction.user.id) : null;
    if (prev) {
      const d = { ...parseJson(prev.data, {}), ...answers };
      for (const x of fields) if (!answers[x.k]) delete d[x.k];          // emptied optional field
      db.prepare('UPDATE list_entries SET name = ?, data = ? WHERE id = ?').run(name, JSON.stringify(d), prev.id);
    } else {
      if (countEntries(l.id) >= MAX_ENTRIES) return interaction.reply(eph({ content: '❌ This form is full. Please tell a mod.' }));
      db.prepare('INSERT INTO list_entries (list_id, name, user_id, data) VALUES (?, ?, ?, ?)').run(l.id, name, interaction.user.id, JSON.stringify(answers));
    }
    await refreshMessage(interaction.client, l.id);
    const summary = fields.filter(x => answers[x.k]).map(x => `**${x.label}:** ${answers[x.k]}`).join('\n');
    return interaction.reply(eph({ content: `✅ ${prev ? 'Your answer was updated' : 'Sent'}: **${f.title}**\n${summary}${f.one_per_user ? '\n\nPress the button again any time to change it.' : ''}` }));
  },
};

module.exports = { data, execute, autocomplete, buttons, modals, deleteForm };
