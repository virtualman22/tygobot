const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
} = require('discord.js');
const { db, getSettings, updateSettings } = require('../db');
const { eph, requireMod, truncate, logToGuild } = require('../utils');
const { createList, refreshMessage, getList } = require('./list');

const ETH_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const DAY = 86_400_000;

// ---------- "Is it Friday?" (in the server's lossback timezone, UTC unless changed) ----------

const validTz = tz => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
const tzOf = guildId => getSettings(guildId).lossback_tz || 'UTC';
const weekdayIn = (tz, ms = Date.now()) => new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: tz }).format(new Date(ms));
const isFriday = tz => weekdayIn(tz) === 'Friday';

/** Start of the next Friday (00:00 in the timezone) as a timestamp. */
function nextFriday(tz) {
  for (let d = 1; d <= 7; d++) {
    const t = Date.now() + d * DAY;
    if (weekdayIn(tz, t) !== 'Friday') continue;
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' })
      .formatToParts(new Date(t)).map(x => [x.type, Number(x.value)]));
    const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
    return Date.UTC(p.year, p.month - 1, p.day) - offset;
  }
  return Date.now() + 7 * DAY;
}

const closedMessage = tz => `⏳ Lossback forms are only open on **Fridays** (${tz}). The next one opens <t:${Math.floor(nextFriday(tz) / 1000)}:F> (<t:${Math.floor(nextFriday(tz) / 1000)}:R>).`;

/** The list that new submissions go to, or null if none is set up (or it was deleted). */
function activeList(guildId) {
  const id = getSettings(guildId).lossback_list_id;
  const l = id ? getList(id) : null;
  return l && l.guild_id === guildId ? l : null;
}

const dateLabel = tz => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz }).format(new Date());

async function spawnList(interaction, target, title) {
  const tz = tzOf(interaction.guildId);
  const id = await createList(target, {
    guildId: interaction.guildId, userId: interaction.user.id, kind: 'lossback',
    title: title || `Lossback — ${dateLabel(tz)}`,
    description: 'All addresses are **USDT (ETH)**. ✅ = paid · ⬜ = waiting. Staff add the loss amount.',
    col1: 'Username', col2: 'USDT ETH Address', col3: 'Loss',
  });
  updateSettings(interaction.guildId, { lossback_list_id: id });
  await logToGuild(interaction.client, interaction.guildId, `💸 <@${interaction.user.id}> started lossback list #${id} in ${target}. New submissions go there now.`);
  return id;
}

// ---------- command ----------

const textTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread];

const data = new SlashCommandBuilder()
  .setName('lossback')
  .setDescription('Weekly lossback form (open on Fridays only)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand(s => s.setName('panel').setDescription('Post the lossback panel (button + form). Creates the staff list on first use')
    .addChannelOption(o => o.setName('list_channel').setDescription('STAFF channel where the list of submissions lives (needed the first time)').addChannelTypes(...textTypes))
    .addChannelOption(o => o.setName('channel').setDescription('Where to post the panel (default: this channel)').addChannelTypes(...textTypes))
    .addStringOption(o => o.setName('message').setDescription('Custom text shown on the panel').setMaxLength(500)))
  .addSubcommand(s => s.setName('newlist').setDescription('Start a fresh empty lossback list (e.g. for a new week); new submissions go to it')
    .addChannelOption(o => o.setName('channel').setDescription('STAFF channel for the list (default: where the current list is)').addChannelTypes(...textTypes))
    .addStringOption(o => o.setName('title').setDescription('List title (default: Lossback — today\'s date)').setMaxLength(100)))
  .addSubcommand(s => s.setName('config').setDescription('Set the code shown on the form and the timezone used for "Friday"')
    .addStringOption(o => o.setName('code').setDescription('Your code, shown on the panel and form (e.g. MYCODE)').setMaxLength(40))
    .addStringOption(o => o.setName('timezone').setDescription('IANA timezone, e.g. UTC, Europe/London, America/New_York (default UTC)').setMaxLength(60)));

function panelPayload(guildId, custom) {
  const s = getSettings(guildId);
  const tz = s.lossback_tz || 'UTC';
  return {
    embeds: [new EmbedBuilder().setColor('#E67E22').setTitle('💸 Lossback')
      .setDescription(custom ?? `Lossback forms are open **every Friday only** (${tz}).\nPress the button and enter your username${s.lossback_code ? ` under code **${s.lossback_code}**` : ''} and your **USDT (ETH)** address. Staff will add your loss and pay you.`)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('lb:submit').setLabel('Submit lossback').setEmoji('💸').setStyle(ButtonStyle.Primary))],
  };
}

async function execute(interaction) {
  if (!requireMod(interaction)) return;
  const sub = interaction.options.getSubcommand();
  const g = interaction.guildId;

  if (sub === 'config') {
    const code = interaction.options.getString('code');
    const tz = interaction.options.getString('timezone');
    if (tz && !validTz(tz.trim())) return interaction.reply(eph({ content: '❌ Unknown timezone. Use an IANA name like `UTC`, `Europe/London`, `Africa/Tunis` or `America/New_York`.' }));
    if (code == null && tz == null) {
      const s = getSettings(g);
      return interaction.reply(eph({ content: `Code: **${s.lossback_code || 'not set'}** · Timezone: **${s.lossback_tz || 'UTC'}** · Open now: **${isFriday(s.lossback_tz || 'UTC') ? 'yes (Friday)' : 'no'}**` }));
    }
    updateSettings(g, { ...(code != null && { lossback_code: code.trim() || null }), ...(tz != null && { lossback_tz: tz.trim() }) });
    return interaction.reply(eph({ content: '✅ Saved. Re-post the panel with `/lossback panel` to show the new text.' }));
  }

  if (sub === 'newlist') {
    const cur = activeList(g);
    const target = interaction.options.getChannel('channel') ?? (cur && await interaction.client.channels.fetch(cur.channel_id).catch(() => null));
    if (!target) return interaction.reply(eph({ content: '❌ Pick a staff channel for the list with the `channel` option.' }));
    try {
      const id = await spawnList(interaction, target, interaction.options.getString('title'));
      return interaction.reply(eph({ content: `✅ New lossback list #${id} posted in ${target}. New submissions go there now.` }));
    } catch (e) {
      return interaction.reply(eph({ content: `❌ Couldn't post the list: ${e.message}` }));
    }
  }

  if (sub === 'panel') {
    let note = '';
    if (!activeList(g)) {
      const listChannel = interaction.options.getChannel('list_channel');
      if (!listChannel) return interaction.reply(eph({ content: '⚠️ No lossback list yet. Run it again with `list_channel:#your-staff-channel` — that\'s where submissions (usernames + addresses) will be listed, so keep it staff-only.' }));
      try { const id = await spawnList(interaction, listChannel, null); note = ` Staff list #${id} created in ${listChannel}.`; }
      catch (e) { return interaction.reply(eph({ content: `❌ Couldn't post the list: ${e.message}` })); }
    }
    const target = interaction.options.getChannel('channel') ?? interaction.channel;
    try { await target.send(panelPayload(g, interaction.options.getString('message'))); }
    catch (e) { return interaction.reply(eph({ content: `❌ Couldn't post the panel there: ${e.message}` })); }
    return interaction.reply(eph({ content: `✅ Lossback panel posted in ${target}.${note}` }));
  }
}

// ---------- the member's button + form ----------

const buttons = {
  async lb(interaction, [action]) {
    if (action !== 'submit') return;
    const g = interaction.guildId;
    const tz = tzOf(g);
    if (!isFriday(tz)) return interaction.reply(eph({ content: closedMessage(tz) }));
    const l = activeList(g);
    if (!l) return interaction.reply(eph({ content: '❌ Lossback isn\'t set up yet. Please tell a mod.' }));
    const mine = db.prepare('SELECT 1 FROM list_entries WHERE list_id = ? AND user_id = ? AND COALESCE(paid, 0) = 0').get(l.id, interaction.user.id);
    if (mine) return interaction.reply(eph({ content: '✅ You already have a lossback submission waiting for staff. You can submit again once it has been paid.' }));

    const code = getSettings(g).lossback_code;
    const input = (id, label, ph, max) => new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId(id).setLabel(truncate(label, 45)).setPlaceholder(ph).setStyle(TextInputStyle.Short).setMaxLength(max).setRequired(true));
    return interaction.showModal(new ModalBuilder().setCustomId('lbform').setTitle('Lossback').addComponents(
      input('username', code ? `Username under code ${code}` : 'Your username', 'Your exact username', 80),
      input('address', 'USDT ETH address', '0x… (USDT on Ethereum / ERC-20) — double check it', 60),
    ));
  },
};

const modals = {
  async lbform(interaction) {
    const g = interaction.guildId;
    const tz = tzOf(g);
    if (!isFriday(tz)) return interaction.reply(eph({ content: closedMessage(tz) }));
    const l = activeList(g);
    if (!l) return interaction.reply(eph({ content: '❌ Lossback isn\'t set up yet. Please tell a mod.' }));

    const username = interaction.fields.getTextInputValue('username').replace(/\s+/g, ' ').trim();
    const address = interaction.fields.getTextInputValue('address').trim();
    if (!ETH_ADDRESS.test(address)) {
      return interaction.reply(eph({ content: '❌ That doesn\'t look like a valid **USDT ETH** address. It must start with `0x` followed by 40 characters (letters a–f and numbers). Please press the button and try again.' }));
    }
    if (db.prepare('SELECT 1 FROM list_entries WHERE list_id = ? AND user_id = ? AND COALESCE(paid, 0) = 0').get(l.id, interaction.user.id)) {
      return interaction.reply(eph({ content: '✅ You already have a lossback submission waiting for staff.' }));
    }
    db.prepare('INSERT INTO list_entries (list_id, name, value1, value2, user_id) VALUES (?, ?, ?, NULL, ?)').run(l.id, username, address, interaction.user.id);
    await refreshMessage(interaction.client, l.id);
    await logToGuild(interaction.client, g, `💸 <@${interaction.user.id}> submitted lossback as **${username}** (list #${l.id}).`);
    return interaction.reply(eph({ content: '✅ Your lossback was submitted. Staff will add your loss amount and pay you.' }));
  },
};

module.exports = { data, execute, buttons, modals };
