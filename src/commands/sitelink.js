const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const { db } = require('../db');
const { eph, isMod } = require('../utils');
const bridge = require('../bridge');

const ch = id => (id ? `<#${id}>` : '*not set*');
const ago = ms => (ms ? `<t:${Math.floor(ms / 1000)}:R>` : '*never*');

const data = new SlashCommandBuilder()
  .setName('sitelink')
  .setDescription('Website link: Guess The Balance + tickets')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(s => s.setName('status').setDescription('Is the bot connected to the website?'))
  .addSubcommand(s => s.setName('test').setDescription('Post a test message in the GTB channel and the site-tickets channel'));

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const st = bridge.state;
  const sync = require('../siteSync').state;
  if (sub === 'status') {
    const open = db.prepare("SELECT COUNT(*) c FROM site_tickets").get().c;
    return interaction.reply(eph({ embeds: [new EmbedBuilder().setColor(bridge.enabled() ? (st.lastError ? '#E74C3C' : '#2ECC71') : '#95A5A6').setTitle('🔗 Website link')
      .addFields(
        { name: 'Connection', value: !bridge.enabled() ? '⚪ Off. Set `SITE_URL` and `BRIDGE_SECRET` on Railway.' : st.lastError ? `🔴 Error: ${st.lastError}` : st.lastOk ? `🟢 Connected, last check ${ago(st.lastOk)}` : '🟡 Starting…' },
        { name: 'Site', value: bridge.SITE || '*SITE_URL not set*', inline: true },
        { name: 'GTB channel', value: ch(bridge.gtbChannelId()), inline: true },
        { name: 'Site tickets channel', value: ch(bridge.ticketChannelId()), inline: true },
        { name: 'Alt alerts channel', value: ch(bridge.altChannelId()), inline: true },
        { name: 'Claim forms', value: require('../siteTickets').siteLoginRequired() ? '🔒 only members who logged in on the website' : 'open to everyone', inline: true },
        { name: 'Handled / dropped', value: `${st.handled} / ${st.dropped}`, inline: true },
        { name: 'Tickets mirrored', value: String(open), inline: true },
        { name: 'Discord tickets on the site', value: process.env.ENABLE_PRIVILEGED_INTENTS === 'true' ? '✅ messages in ticket channels are mirrored both ways' : '⚠️ opening/closing is mirrored, but I can\'t read the messages: set ENABLE_PRIVILEGED_INTENTS=true (and enable Message Content Intent in the Developer Portal)', inline: false },
        { name: 'Payout records on site', value: sync.error ? `🔴 ${sync.error}` : sync.last ? `✅ ${sync.total} records, last sync ${ago(sync.last)}` : '🟡 first sync pending', inline: false },
      )] }));
  }
  if (sub === 'test') {
    const out = [];
    for (const [label, id] of [['GTB channel', bridge.gtbChannelId()], ['Site tickets channel', bridge.ticketChannelId()]]) {
      const c = id ? await interaction.client.channels.fetch(id).catch(() => null) : null;
      if (!c) { out.push(`❌ ${label}: not set or I can't see it`); continue; }
      try { await c.send(`✅ Website link test from <@${interaction.user.id}>.`); out.push(`✅ ${label}: ${c}`); }
      catch (e) { out.push(`❌ ${label}: ${c} — ${e.message}`); }
    }
    return interaction.reply(eph({ content: out.join('\n') }));
  }
}

// ───────── buttons + modals on the mirrored ticket cards ─────────
const noStaff = i => i.reply(eph({ content: '❌ You need the Manage Messages permission (or the mod role) to handle tickets.' }));

async function relay(interaction, body, okText) {
  await interaction.deferReply({ flags: 64 });
  let j;
  try { j = await bridge.api('POST', { ...body, discord_id: interaction.user.id }); }
  catch (e) { return interaction.editReply(`❌ Could not reach the website: ${e.message}`); }
  return interaction.editReply(j.ok ? okText : `❌ ${j.error || 'The website refused that.'}`);
}

const buttons = {
  async sl(interaction, [action, id]) {
    if (!isMod(interaction)) return noStaff(interaction);
    if (action === 'reply' || action === 'note') {
      const note = action === 'note';
      return interaction.showModal(new ModalBuilder().setCustomId(`sl:${action}:${id}`).setTitle(note ? 'Internal note (staff only)' : 'Reply to the member')
        .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('text').setLabel(note ? 'Note' : 'Message').setStyle(TextInputStyle.Paragraph)
          .setMaxLength(1500).setRequired(true).setPlaceholder(note ? 'Only staff can see this' : 'This is sent to the member on the website'))));
    }
    if (action === 'claim') return relay(interaction, { action: 'ticket_claim', ticket_id: id }, '✅ You claimed this ticket.');
    if (action === 'close') return relay(interaction, { action: 'ticket_close', ticket_id: id }, '✅ Ticket closed.');
    if (action === 'reopen') return relay(interaction, { action: 'ticket_reopen', ticket_id: id }, '✅ Ticket reopened.');
  },
};

const modals = {
  async sl(interaction, [action, id]) {
    if (!isMod(interaction)) return noStaff(interaction);
    const text = interaction.fields.getTextInputValue('text').trim();
    if (!text) return interaction.reply(eph({ content: '❌ Write something first.' }));
    return relay(interaction, { action: 'ticket_reply', ticket_id: id, text, note: action === 'note' },
      action === 'note' ? '📝 Note saved (staff only). It shows up in the thread in a few seconds.' : '✅ Sent to the member. It shows up in the thread in a few seconds.');
  },
};

module.exports = { data, execute, buttons, modals };
