const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle, TextDisplayBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
} = require('discord.js');
const { db, getSettings, updateSettings } = require('../db');
const { eph, requireMod, truncate, logToGuild, ts } = require('../utils');
const { createList, refreshMessage, getList } = require('./list');
const { SITES, siteOf, siteLabel, ETH_ADDRESS, WALLET_RULE, walletNotice, BAD_ADDRESS, siteButtons } = require('../sites');

// ---------- when the form is open: every Friday, opens–closes in the lossback timezone (default 08:00–20:00 UTC+1) ----------
// Times are shown with Discord timestamps (<t:…>), so everyone sees them in their own timezone.

const DEFAULT_TZ = 'Etc/GMT-1';                      // fixed UTC+1 (IANA writes the sign the other way round)
const DEFAULT_OPEN = 8, DEFAULT_CLOSE = 20;
const GRACE_MS = 3 * 60_000;                          // a form opened just before closing time can still be sent for 3 minutes

const validTz = tz => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
/** "UTC+1", "GMT-5", "UTC" -> fixed-offset zone; anything else must be an IANA name (Europe/Amsterdam follows summer time). null = unknown. */
function normTz(raw) {
  const tz = raw.trim();
  if (/^(UTC|GMT)$/i.test(tz)) return 'UTC';
  const m = /^(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::00)?$/i.exec(tz);
  const out = m ? (Number(m[2]) === 0 ? 'UTC' : `Etc/GMT${m[1] === '+' ? '-' : '+'}${Number(m[2])}`) : tz;
  return validTz(out) ? out : null;
}
/** Etc/GMT-1 -> "UTC+1" for display. */
const tzLabel = tz => { const m = /^Etc\/GMT([+-])(\d+)$/.exec(tz); return m ? `UTC${m[1] === '-' ? '+' : '-'}${m[2]}` : tz; };
const hh = h => `${String(h).padStart(2, '0')}:00`;

/** How far tz is ahead of UTC at time t, in ms. */
function tzOffset(tz, t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(t)).map(x => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}
/** Wall-clock time (year, month 0-11, day, hour) in tz -> timestamp. */
function zoned(tz, y, mo, d, h) {
  const guess = Date.UTC(y, mo, d, h);
  return guess - tzOffset(tz, guess - tzOffset(tz, guess));
}

/** The current form window, or the next one: { open, start, end, tz, opens, closes } (ms). */
function lbWindow(guildId, now = Date.now()) {
  const s = getSettings(guildId);
  const tz = s.lossback_tz || DEFAULT_TZ;
  const opens = s.lossback_open_hour ?? DEFAULT_OPEN, closes = s.lossback_close_hour ?? DEFAULT_CLOSE;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date(now)).map(x => [x.type, Number(x.value)]));
  for (let d = 0; d <= 8; d++) {
    const day = new Date(Date.UTC(p.year, p.month - 1, p.day + d));
    if (day.getUTCDay() !== 5) continue;                                   // Friday
    const start = zoned(tz, day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), opens);
    const end = zoned(tz, day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), closes);
    if (now < end) return { open: now >= start, start, end, tz, opens, closes };
  }
}

const scheduleText = w => `every **Friday ${hh(w.opens)}–${hh(w.closes)} ${tzLabel(w.tz)}**`;
/** One line for the panel / replies: open until …, or next opens … */
const windowLine = w => (w.open
  ? `🟢 **Open now** · closes ${ts(w.end, 'F')} (${ts(w.end, 'R')})`
  : `🔴 **Closed** · next opens ${ts(w.start, 'F')} (${ts(w.start, 'R')}) and closes ${ts(w.end, 't')}`);
const closedMessage = w => `⏳ Lossback forms are closed right now. They are open ${scheduleText(w)}.\nNext form: opens ${ts(w.start, 'F')} (${ts(w.start, 'R')}) and closes ${ts(w.end, 't')}.`;

/** The list that new submissions go to, or null if none is set up (or it was deleted). */
function activeList(guildId) {
  const id = getSettings(guildId).lossback_list_id;
  const l = id ? getList(id) : null;
  return l && l.guild_id === guildId ? l : null;
}

const dateLabel = tz => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz }).format(new Date());

async function spawnList(interaction, target, title) {
  const tz = lbWindow(interaction.guildId).tz;
  const id = await createList(target, {
    guildId: interaction.guildId, userId: interaction.user.id, kind: 'lossback',
    title: title || `Lossback — ${dateLabel(tz)}`,
    description: 'All addresses are members\' **personal USDT (ETH)** wallets. 🟢 Stake · 🌙 Moon. ✅ = paid · ⬜ = waiting. Staff add the loss amount.',
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
  .addSubcommand(s => s.setName('config').setDescription('Codes shown on the form, and when it is open (Fridays, default 08:00–20:00 UTC+1)')
    .addStringOption(o => o.setName('code').setDescription('Your Stake code, shown on the panel and form (e.g. MYCODE)').setMaxLength(40))
    .addStringOption(o => o.setName('moon_code').setDescription('Your Moon code, shown on the panel and form').setMaxLength(40))
    .addStringOption(o => o.setName('timezone').setDescription('UTC+1 (default), UTC, or an IANA name like Europe/Amsterdam (follows summer time)').setMaxLength(60))
    .addIntegerOption(o => o.setName('opens').setDescription('Hour the form opens on Friday, 0–23 (default 8)').setMinValue(0).setMaxValue(23))
    .addIntegerOption(o => o.setName('closes').setDescription('Hour the form closes on Friday, 1–24 (default 20)').setMinValue(1).setMaxValue(24)));

/** The code members play under on each site (set with /lossback config). */
const codeOf = (s, site) => (site === 'moon' ? s.lossback_code_moon : s.lossback_code) || null;

/** Lossback buttons, one per site. */
const lossbackButtons = () => siteButtons(site => `lb:submit:${site}`, site => `${SITES[site].label} lossback`);

function panelPayload(guildId, custom) {
  const s = getSettings(guildId);
  const w = lbWindow(guildId);
  const codes = Object.keys(SITES).map(site => codeOf(s, site) && `${SITES[site].label} code **${codeOf(s, site)}**`).filter(Boolean).join(' · ');
  return {
    embeds: [new EmbedBuilder().setColor(w.open ? '#2ECC71' : '#E67E22').setTitle('💸 Lossback')
      .setDescription(`${custom ?? `Lossback forms are open ${scheduleText(w)}. The times below are in your own timezone.\nPress **Stake lossback** or **Moon lossback** (the site you played on) and enter your username${codes ? ` (${codes})` : ''} and your **personal USDT (ETH)** wallet. Staff will add your loss and pay you.`}\n\n${windowLine(w)}\n\n💳 ${WALLET_RULE}`)],
    components: [lossbackButtons()],
  };
}

// Posted panels are remembered so the bot can switch them between "Open now" and "Closed" by itself (refreshPanels, every 30 s from the scheduler)
db.exec('CREATE TABLE IF NOT EXISTS lossback_panels (message_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, guild_id TEXT NOT NULL, custom TEXT, state TEXT)');
const stateOf = w => `${w.open ? 'open' : 'closed'}:${w.start}:${w.end}`;

async function refreshPanels(client, guildId = null, force = false) {
  const rows = db.prepare(`SELECT * FROM lossback_panels${guildId ? ' WHERE guild_id = ?' : ''}`).all(...(guildId ? [guildId] : []));
  for (const p of rows) {
    const state = stateOf(lbWindow(p.guild_id));
    if (!force && state === p.state) continue;
    try {
      const ch = await client.channels.fetch(p.channel_id);
      const msg = await ch.messages.fetch(p.message_id);
      await msg.edit(panelPayload(p.guild_id, p.custom ?? undefined));
      db.prepare('UPDATE lossback_panels SET state = ? WHERE message_id = ?').run(state, p.message_id);
    } catch (e) {
      if ([10003, 10008, 50001].includes(e.code)) db.prepare('DELETE FROM lossback_panels WHERE message_id = ?').run(p.message_id);   // channel / message gone, or no access
      else console.warn('[lossback] panel refresh failed:', e.message);
    }
  }
}

/** A member's waiting (not paid, not disqualified) submission on this list for this site. */
const waitingEntry = (listId, userId, site) => db.prepare("SELECT 1 FROM list_entries WHERE list_id = ? AND user_id = ? AND COALESCE(site, 'stake') = ? AND COALESCE(paid, 0) = 0 AND COALESCE(dq, 0) = 0")
  .get(listId, userId, site);

async function execute(interaction) {
  if (!requireMod(interaction)) return;
  const sub = interaction.options.getSubcommand();
  const g = interaction.guildId;

  if (sub === 'config') {
    const code = interaction.options.getString('code');
    const moonCode = interaction.options.getString('moon_code');
    const tzRaw = interaction.options.getString('timezone');
    const opens = interaction.options.getInteger('opens');
    const closes = interaction.options.getInteger('closes');
    const tz = tzRaw == null ? null : normTz(tzRaw);
    if (tzRaw != null && !tz) return interaction.reply(eph({ content: '❌ Unknown timezone. Use `UTC+1`, `UTC`, or an IANA name like `Europe/Amsterdam`, `Europe/London` or `America/New_York`.' }));
    const cur = getSettings(g);
    const o = opens ?? cur.lossback_open_hour ?? DEFAULT_OPEN, c = closes ?? cur.lossback_close_hour ?? DEFAULT_CLOSE;
    if (o >= c) return interaction.reply(eph({ content: `❌ The form must open before it closes (you'd get ${hh(o)}–${hh(c)}).` }));
    const summary = () => {
      const s = getSettings(g), w = lbWindow(g);
      return `Stake code: **${s.lossback_code || 'not set'}** · Moon code: **${s.lossback_code_moon || 'not set'}**\nOpen ${scheduleText(w)}\n${windowLine(w)}`;
    };
    if (code == null && moonCode == null && tz == null && opens == null && closes == null) return interaction.reply(eph({ content: summary() }));
    updateSettings(g, {
      ...(code != null && { lossback_code: code.trim() || null }), ...(moonCode != null && { lossback_code_moon: moonCode.trim() || null }), ...(tz != null && { lossback_tz: tz }),
      ...(opens != null && { lossback_open_hour: opens }), ...(closes != null && { lossback_close_hour: closes }),
    });
    await interaction.deferReply(eph());
    await refreshPanels(interaction.client, g, true);
    return interaction.editReply({ content: `✅ Saved. Panels posted with \`/lossback panel\` update by themselves.\n${summary()}` });
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
    const custom = interaction.options.getString('message');
    try {
      const msg = await target.send(panelPayload(g, custom ?? undefined));
      db.prepare('INSERT OR REPLACE INTO lossback_panels (message_id, channel_id, guild_id, custom, state) VALUES (?, ?, ?, ?, ?)').run(msg.id, target.id, g, custom, stateOf(lbWindow(g)));
    } catch (e) { return interaction.reply(eph({ content: `❌ Couldn't post the panel there: ${e.message}` })); }
    return interaction.reply(eph({ content: `✅ Lossback panel posted in ${target}.${note}` }));
  }
}

// ---------- the member's button + form ----------

const buttons = {
  async lb(interaction, [action, siteStr]) {
    if (action !== 'submit') return;
    const g = interaction.guildId;
    const w = lbWindow(g);
    if (!w.open) return interaction.reply(eph({ content: closedMessage(w) }));
    const l = activeList(g);
    if (!l) return interaction.reply(eph({ content: '❌ Lossback isn\'t set up yet. Please tell a mod.' }));
    // Panels posted before Moon existed have one button without a site: ask which one first
    if (!SITES[siteStr]) return interaction.reply(eph({ content: 'Which site did you play on?', components: [lossbackButtons()] }));
    const site = siteStr;
    if (waitingEntry(l.id, interaction.user.id, site)) return interaction.reply(eph({ content: `✅ You already have a **${siteLabel(site)}** lossback submission waiting for staff. You can submit again once it has been paid.\n${windowLine(w)}` }));

    const code = codeOf(getSettings(g), site);
    const prof = await require('../siteTickets').profileOf(interaction.user.id);        // Stake / Moon username + wallet linked on the website (empty if none / site slow)
    const input = (id, label, ph, max, value) => {
      const t = new TextInputBuilder().setCustomId(id).setLabel(truncate(label, 45)).setPlaceholder(ph).setStyle(TextInputStyle.Short).setMaxLength(max).setRequired(true);
      if (value) t.setValue(String(value).slice(0, max));
      return new ActionRowBuilder().addComponents(t);
    };
    const name = SITES[site].label;
    return interaction.showModal(new ModalBuilder().setCustomId(`lbform:${site}`).setTitle(`${name} lossback`)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`⏰ This form closes ${ts(w.end, 'F')} (${ts(w.end, 'R')}).`), walletNotice())
      .addComponents(
        input('username', code ? `${name} username under code ${code}` : `Your ${name} username`, `Your exact ${name} username`, 80, site === 'moon' ? prof?.moon_username : prof?.stake_username),
        input('address', 'Your PERSONAL USDT (ETH) wallet', '0x… your own wallet. NOT a Stake or Moon deposit address', 60, prof?.eth_address),
      ));
  },
};

const modals = {
  async lbform(interaction, [siteStr]) {
    const site = siteOf(siteStr);
    const g = interaction.guildId;
    const w = lbWindow(g), late = lbWindow(g, Date.now() - GRACE_MS);    // "late": the window that was open a few minutes ago
    if (!w.open && !late.open) return interaction.reply(eph({ content: closedMessage(w) }));
    const closesAt = w.open ? w.end : late.end;
    const l = activeList(g);
    if (!l) return interaction.reply(eph({ content: '❌ Lossback isn\'t set up yet. Please tell a mod.' }));

    const username = interaction.fields.getTextInputValue('username').replace(/\s+/g, ' ').trim();
    const address = interaction.fields.getTextInputValue('address').trim();
    if (!ETH_ADDRESS.test(address)) return interaction.reply(eph({ content: BAD_ADDRESS }));
    if (waitingEntry(l.id, interaction.user.id, site)) {
      return interaction.reply(eph({ content: `✅ You already have a **${siteLabel(site)}** lossback submission waiting for staff.` }));
    }
    db.prepare('INSERT INTO list_entries (list_id, name, value1, value2, user_id, site) VALUES (?, ?, ?, NULL, ?, ?)').run(l.id, username, address, interaction.user.id, site);
    await refreshMessage(interaction.client, l.id);
    await logToGuild(interaction.client, g, `💸 <@${interaction.user.id}> submitted a **${siteLabel(site)}** lossback as **${username}** (list #${l.id}).`);
    return interaction.reply(eph({ content: `✅ Your **${siteLabel(site)}** lossback was submitted ${ts(Date.now(), 'F')}. Staff will add your loss amount and pay you.\nThis week's form closes ${ts(closesAt, 'F')} (${ts(closesAt, 'R')}).` }));
  },
};

module.exports = { data, execute, buttons, modals, lbWindow, windowLine, refreshPanels };
