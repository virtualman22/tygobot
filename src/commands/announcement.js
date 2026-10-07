const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, ModalBuilder, TextInputBuilder,
  TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const { db, getSettings } = require('../db');
const { eph, requireMod, parseColor, parseWhen, ts, truncate } = require('../utils');
const { STYLES, normalizeFields, buildPayload, composeMessage, summarize, sendAnnouncement } = require('../announce');

const drafts = new Map(); // draftId -> draft
const newId = () => Math.random().toString(36).slice(2, 10);

const S = TextInputStyle.Short;
const P = TextInputStyle.Paragraph;

// The form shown for each announcement style
const FORMS = {
  text: [
    { id: 'title', label: 'Title (optional)', style: S, max: 256, required: false, ph: '📢 Server update' },
    { id: 'message', label: 'Message — type anything you like', style: P, max: 4000, required: true, ph: 'Write freely. You can use **bold**, *italics*, lists and links.' },
    { id: 'button', label: 'Link button (optional)', style: S, max: 200, required: false, ph: 'Join the event | https://example.com' },
  ],
  plain: [
    { id: 'message', label: 'Message', style: P, max: 1900, required: true, ph: 'Type your message. It is posted as normal text, no embed.' },
  ],
  event: [
    { id: 'title', label: 'Announcement Title', style: S, max: 256, required: true, ph: '🏆 Monthly Community Event' },
    { id: 'introduction', label: 'Introduction', style: P, max: 1000, required: true, ph: 'The event is now live! Compete with the community...' },
    { id: 'standings', label: 'Leaderboard / Main Link', style: S, max: 500, required: false, ph: 'View Live Standings | https://example.com' },
    { id: 'participation', label: 'How to Participate', style: P, max: 1500, required: false, ph: '1. Join the event\n2. Complete the activities\n3. Check your ranking' },
    { id: 'rewards', label: 'Rewards & Rules', style: P, max: 1500, required: false, ph: 'Total Pool: $2,000\nPrizes are paid monthly...\nRules apply.' },
  ],
};

function buildModal(customId, fields) {
  const style = normalizeFields(fields).style;
  const modal = new ModalBuilder().setCustomId(customId).setTitle(`New announcement — ${STYLES[style].split(' (')[0]}`);
  for (const c of FORMS[style]) {
    const input = new TextInputBuilder().setCustomId(c.id).setLabel(c.label).setPlaceholder(c.ph)
      .setStyle(c.style).setMaxLength(c.max).setRequired(c.required);
    if (fields[c.id]) input.setValue(String(fields[c.id]).slice(0, c.max));
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return modal;
}

const readFields = (i, style) => ({ style, ...Object.fromEntries(FORMS[style].map(c => [c.id, i.fields.getTextInputValue(c.id)])) });

function loadTemplate(row) {
  if (row.fields) return normalizeFields(JSON.parse(row.fields));
  return { style: 'event', title: row.title, introduction: row.introduction, standings: row.standings, participation: row.participation, rewards: row.rewards };
}

function previewPayload(id, d) {
  const msg = composeMessage(d.fields, d.color, d.image, null);
  const header = `**Preview** — will post in <#${d.channelId}>${d.roleId ? ` and ping <@&${d.roleId}>` : ''}`;
  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ann:send:${id}`).setLabel('Send').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`ann:schedule:${id}`).setLabel('Schedule').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`ann:edit:${id}`).setLabel('Edit').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ann:save:${id}`).setLabel('Save as template').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ann:cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Danger),
  );
  return {
    content: msg.content ? `${header}\n\n${truncate(msg.content, 1600)}` : header,
    embeds: msg.embeds,
    components: [...msg.components, controls],
    allowedMentions: { parse: [] },
  };
}

const respond = (i, payload) => (i.isFromMessage?.() ? i.update(payload) : i.reply(eph(payload)));

const styleChoices = Object.entries(STYLES).map(([value, name]) => ({ name, value }));

const data = new SlashCommandBuilder()
  .setName('announcement')
  .setDescription('Create and manage community announcements')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand(s => s.setName('create').setDescription('Write a new announcement (you get a preview first)')
    .addStringOption(o => o.setName('style').setDescription('Layout (default: free text)').addChoices(...styleChoices))
    .addChannelOption(o => o.setName('channel').setDescription('Where to post (default: announcement channel from /setup)')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addRoleOption(o => o.setName('ping').setDescription('Role to ping'))
    .addStringOption(o => o.setName('color').setDescription('Hex color, e.g. #FF8800'))
    .addAttachmentOption(o => o.setName('image').setDescription('Image to attach'))
    .addStringOption(o => o.setName('template').setDescription('Start from a saved template').setAutocomplete(true)))
  .addSubcommand(s => s.setName('edit').setDescription('Edit a posted announcement')
    .addStringOption(o => o.setName('message_id').setDescription('ID of the announcement message').setRequired(true)))
  .addSubcommand(s => s.setName('delete').setDescription('Delete a posted announcement')
    .addStringOption(o => o.setName('message_id').setDescription('ID of the announcement message').setRequired(true)))
  .addSubcommand(s => s.setName('scheduled').setDescription('List scheduled announcements'))
  .addSubcommand(s => s.setName('cancel-scheduled').setDescription('Cancel a scheduled announcement')
    .addIntegerOption(o => o.setName('id').setDescription('Schedule ID').setRequired(true)))
  .addSubcommand(s => s.setName('templates').setDescription('List saved templates'))
  .addSubcommand(s => s.setName('template-delete').setDescription('Delete a template')
    .addStringOption(o => o.setName('name').setDescription('Template name').setRequired(true).setAutocomplete(true)));

async function execute(interaction) {
  if (!requireMod(interaction)) return;
  const sub = interaction.options.getSubcommand();
  const g = interaction.guildId;

  if (sub === 'create') {
    const settings = getSettings(g);
    let fields = { style: interaction.options.getString('style') ?? 'text' };
    const tplName = interaction.options.getString('template');
    if (tplName) {
      const tpl = db.prepare('SELECT * FROM templates WHERE guild_id = ? AND name = ? COLLATE NOCASE').get(g, tplName);
      if (!tpl) return interaction.reply(eph({ content: `❌ No template named **${tplName}**.` }));
      fields = loadTemplate(tpl);
    }
    const id = newId();
    drafts.set(id, {
      userId: interaction.user.id,
      guildId: g,
      fields,
      channelId: interaction.options.getChannel('channel')?.id ?? settings.announce_channel ?? interaction.channelId,
      roleId: interaction.options.getRole('ping')?.id,
      color: parseColor(interaction.options.getString('color')),
      image: interaction.options.getAttachment('image')?.url,
    });
    setTimeout(() => drafts.delete(id), 30 * 60_000).unref();
    return interaction.showModal(buildModal(`annmodal:${id}`, fields));
  }

  if (sub === 'edit') {
    const mid = interaction.options.getString('message_id').trim();
    const row = db.prepare('SELECT * FROM announcements WHERE guild_id = ? AND message_id = ?').get(g, mid);
    if (!row) return interaction.reply(eph({ content: '❌ I have no announcement with that message ID. (Right-click the message → Copy Message ID.)' }));
    return interaction.showModal(buildModal(`annedit:${mid}`, normalizeFields(JSON.parse(row.data).fields)));
  }

  if (sub === 'delete') {
    const mid = interaction.options.getString('message_id').trim();
    const row = db.prepare('SELECT * FROM announcements WHERE guild_id = ? AND message_id = ?').get(g, mid);
    if (!row) return interaction.reply(eph({ content: '❌ I have no announcement with that message ID.' }));
    try {
      const ch = await interaction.client.channels.fetch(row.channel_id);
      await (await ch.messages.fetch(mid)).delete();
    } catch { /* message may already be gone */ }
    db.prepare('DELETE FROM announcements WHERE message_id = ?').run(mid);
    return interaction.reply(eph({ content: '🗑️ Announcement deleted.' }));
  }

  if (sub === 'scheduled') {
    const rows = db.prepare('SELECT * FROM scheduled WHERE guild_id = ? ORDER BY send_at').all(g);
    if (!rows.length) return interaction.reply(eph({ content: 'Nothing scheduled.' }));
    const lines = rows.map(r => `**#${r.id}** · ${ts(r.send_at)} · <#${r.channel_id}> · ${r.repeat_mode} · ${summarize(JSON.parse(r.fields))}`);
    return interaction.reply(eph({ content: lines.join('\n') }));
  }

  if (sub === 'cancel-scheduled') {
    const res = db.prepare('DELETE FROM scheduled WHERE id = ? AND guild_id = ?').run(interaction.options.getInteger('id'), g);
    return interaction.reply(eph({ content: res.changes ? '✅ Cancelled.' : '❌ No scheduled announcement with that ID.' }));
  }

  if (sub === 'templates') {
    const rows = db.prepare('SELECT * FROM templates WHERE guild_id = ? ORDER BY name').all(g);
    if (!rows.length) return interaction.reply(eph({ content: 'No templates yet. Click **Save as template** on any preview.' }));
    return interaction.reply(eph({ content: rows.map(r => {
      const f = loadTemplate(r);
      return `• **${r.name}** — ${STYLES[f.style].split(' (')[0]}: ${summarize(f)}`;
    }).join('\n') }));
  }

  if (sub === 'template-delete') {
    const res = db.prepare('DELETE FROM templates WHERE guild_id = ? AND name = ? COLLATE NOCASE').run(g, interaction.options.getString('name'));
    return interaction.reply(eph({ content: res.changes ? '🗑️ Template deleted.' : '❌ Template not found.' }));
  }
}

async function autocomplete(interaction) {
  const focused = String(interaction.options.getFocused());
  const rows = db.prepare('SELECT name FROM templates WHERE guild_id = ? AND name LIKE ? ORDER BY name LIMIT 25')
    .all(interaction.guildId, `%${focused}%`);
  await interaction.respond(rows.map(r => ({ name: r.name, value: r.name })));
}

const getDraft = (interaction, id) => {
  const d = drafts.get(id);
  if (!d || d.userId !== interaction.user.id) {
    interaction.reply(eph({ content: '⌛ This draft expired. Run `/announcement create` again.' }));
    return null;
  }
  return d;
};

const buttons = {
  async ann(interaction, [action, id]) {
    const d = getDraft(interaction, id);
    if (!d) return;

    if (action === 'send') {
      await interaction.deferUpdate();
      try {
        await sendAnnouncement(interaction.client, { ...d, authorId: interaction.user.id });
        drafts.delete(id);
        await interaction.editReply({ content: `✅ Announcement sent in <#${d.channelId}>.`, embeds: [], components: [] });
      } catch (e) {
        await interaction.followUp(eph({ content: `❌ Couldn't send: ${e.message}\nCheck that I can view and send messages in that channel.` }));
      }
    }
    if (action === 'edit') return interaction.showModal(buildModal(`annmodal:${id}`, d.fields));

    if (action === 'schedule') {
      const modal = new ModalBuilder().setCustomId(`annsched:${id}`).setTitle('Schedule announcement')
        .addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('when').setLabel('When (UTC time)')
            .setPlaceholder('2026-11-01 18:00   or   +90m / +2h / +1d').setStyle(S).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('repeat').setLabel('Repeat (none / daily / weekly / monthly)')
            .setPlaceholder('none').setStyle(S).setRequired(false)),
        );
      return interaction.showModal(modal);
    }

    if (action === 'save') {
      const modal = new ModalBuilder().setCustomId(`annsave:${id}`).setTitle('Save as template')
        .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Template name')
          .setPlaceholder('Monthly Event').setStyle(S).setMaxLength(50).setRequired(true)));
      return interaction.showModal(modal);
    }

    if (action === 'cancel') {
      drafts.delete(id);
      return interaction.update({ content: 'Draft cancelled.', embeds: [], components: [] });
    }
  },
};

const modals = {
  async annmodal(interaction, [id]) {
    const d = getDraft(interaction, id);
    if (!d) return;
    d.fields = readFields(interaction, normalizeFields(d.fields).style);
    return respond(interaction, previewPayload(id, d));
  },

  async annsched(interaction, [id]) {
    const d = getDraft(interaction, id);
    if (!d) return;
    const when = parseWhen(interaction.fields.getTextInputValue('when'));
    if (!when) return interaction.reply(eph({ content: '❌ Invalid time. Use `YYYY-MM-DD HH:mm` (UTC) or `+90m`, `+2h`, `+1d` — and it must be in the future.' }));
    const repeat = (interaction.fields.getTextInputValue('repeat') || 'none').trim().toLowerCase();
    if (!['none', 'daily', 'weekly', 'monthly'].includes(repeat)) return interaction.reply(eph({ content: '❌ Repeat must be none, daily, weekly or monthly.' }));

    db.prepare(`INSERT INTO scheduled (guild_id, channel_id, role_id, color, image, fields, send_at, repeat_mode, author_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(d.guildId, d.channelId, d.roleId ?? null, d.color, d.image ?? null, JSON.stringify(d.fields), when, repeat, d.userId);
    drafts.delete(id);
    return respond(interaction, { content: `🗓️ Scheduled for ${ts(when)} in <#${d.channelId}> (${repeat}).`, embeds: [], components: [] });
  },

  async annsave(interaction, [id]) {
    const d = getDraft(interaction, id);
    if (!d) return;
    const name = interaction.fields.getTextInputValue('name').trim();
    db.prepare(`INSERT INTO templates (guild_id, name, title, fields) VALUES (?, ?, ?, ?)
                ON CONFLICT (guild_id, name) DO UPDATE SET title = excluded.title, fields = excluded.fields`)
      .run(d.guildId, name, summarize(d.fields), JSON.stringify(d.fields));
    return interaction.reply(eph({ content: `💾 Saved template **${name}**. Use it with \`/announcement create template:${name}\`.` }));
  },

  async annedit(interaction, [mid]) {
    const row = db.prepare('SELECT * FROM announcements WHERE guild_id = ? AND message_id = ?').get(interaction.guildId, mid);
    if (!row) return interaction.reply(eph({ content: '❌ Announcement not found.' }));
    const old = JSON.parse(row.data);
    const fields = readFields(interaction, normalizeFields(old.fields).style);
    try {
      const ch = await interaction.client.channels.fetch(row.channel_id);
      const msg = await ch.messages.fetch(mid);
      await msg.edit({ ...composeMessage(fields, old.color, old.image, old.roleId), allowedMentions: { parse: [] } });
    } catch (e) {
      return interaction.reply(eph({ content: `❌ Couldn't edit the message: ${e.message}` }));
    }
    db.prepare('UPDATE announcements SET data = ? WHERE message_id = ?').run(JSON.stringify({ ...old, fields }), mid);
    return interaction.reply(eph({ content: '✅ Announcement updated.' }));
  },
};

module.exports = { data, execute, autocomplete, buttons, modals };
