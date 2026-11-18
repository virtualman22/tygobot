const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle, TextDisplayBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
} = require('discord.js');
const { db, getSettings, updateSettings } = require('../db');
const { eph, requireMod, truncate, logToGuild, ts } = require('../utils');
const { createList, refreshMessage, getList } = require('./list');
const { SITES, siteOf, siteLabel, ETH_ADDRESS, WALLET_RULE, walletNotice, BAD_ADDRESS, siteButtons } = require('../sites');

// ---------- when the form is open ----------
// Set on the website (Ticket desk > Lossbacks, sent as "lossback.config" events) or with /lossback config:
//   days (default Friday), opens–closes as HH:MM in the lossback timezone (default 08:00–20:00 UTC+1),
//   mode: auto = follow the schedule · open = open now until staff switch back · closed = closed whatever the schedule says.
// The bot reports what it runs back to the site (reportToSite), so the Ticket desk always shows the real state.
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
/** minutes since midnight <-> "HH:MM" */
const hm = min => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const parseHM = v => { const m = /^(\d{1,2}):([0-5]\d)$/.exec(String(v ?? '').trim()); if (!m) return null; const t = Number(m[1]) * 60 + Number(m[2]); return t <= 1440 ? t : null; };
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** How far tz is ahead of UTC at time t, in ms. */
function tzOffset(tz, t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(t)).map(x => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}
/** Wall-clock time (year, month 0-11, day, minutes since midnight) in tz -> timestamp. */
function zoned(tz, y, mo, d, min) {
  const guess = Date.UTC(y, mo, d, 0, min);
  return guess - tzOffset(tz, guess - tzOffset(tz, guess));
}

/** The schedule as set: { tz, days: [0-6], openMin, closeMin, mode }. */
function lbConfig(guildId) {
  const s = getSettings(guildId);
  const openMin = parseHM(s.lossback_open_at) ?? (s.lossback_open_hour ?? DEFAULT_OPEN) * 60;
  const closeMin = parseHM(s.lossback_close_at) ?? (s.lossback_close_hour ?? DEFAULT_CLOSE) * 60;
  const days = [...new Set(String(s.lossback_days ?? '5').split(',').map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))];
  return { tz: s.lossback_tz || DEFAULT_TZ, days: days.length ? days : [5], openMin, closeMin: closeMin > openMin ? closeMin : openMin + 60,
           mode: ['open', 'closed'].includes(s.lossback_mode) ? s.lossback_mode : 'auto' };
}

/**
 * The current form window, or the next one: { open, manual, start, end, next, tz, days, openMin, closeMin, mode } (ms).
 * manual = staff switched it open / closed by hand: start / end are null then, "next" is still the next scheduled window.
 */
function lbWindow(guildId, now = Date.now()) {
  const c = lbConfig(guildId);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: c.tz, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date(now)).map(x => [x.type, Number(x.value)]));
  let next = null;
  for (let d = -1; d <= 8 && !next; d++) {
    const day = new Date(Date.UTC(p.year, p.month - 1, p.day + d));
    if (!c.days.includes(day.getUTCDay())) continue;
    const start = zoned(c.tz, day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), c.openMin);
    const end = zoned(c.tz, day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), c.closeMin);
    if (now < end) next = { start, end };
  }
  if (c.mode === 'open') return { ...c, open: true, manual: true, start: null, end: null, next };
  if (c.mode === 'closed') return { ...c, open: false, manual: true, start: null, end: null, next };
  return { ...c, open: now >= next.start, manual: false, start: next.start, end: next.end, next };
}

const daysText = days => {
  const d = [...days].sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b)).map(x => DAY_NAMES[x]);
  return d.length === 7 ? 'every day' : `every ${d.length > 1 ? d.slice(0, -1).join(', ') + ' and ' + d.at(-1) : d[0]}`;
};
const scheduleText = w => `**${daysText(w.days)} ${hm(w.openMin)}–${hm(w.closeMin)} ${tzLabel(w.tz)}**`;
/** One line for the panel / replies: open until …, or next opens … */
const windowLine = w => (w.manual
  ? (w.open ? '🟢 **Open now** · until staff close it' : '🔴 **Closed** · staff will open it again')
  : w.open
    ? `🟢 **Open now** · closes ${ts(w.end, 'F')} (${ts(w.end, 'R')})`
    : `🔴 **Closed** · next opens ${ts(w.start, 'F')} (${ts(w.start, 'R')}) and closes ${ts(w.end, 't')}`);
const closedMessage = w => (w.manual
  ? '⏳ Lossback forms are closed right now. Staff will open them again, keep an eye on the announcements.'
  : `⏳ Lossback forms are closed right now. They are open ${scheduleText(w)}.\nNext form: opens ${ts(w.start, 'F')} (${ts(w.start, 'R')}) and closes ${ts(w.end, 't')}.`);
/** "You can submit a new lossback form …" for the DMs (lossbackNotify.js). */
const againLine = w => (!w ? 'You can submit a new lossback form when the next one opens.'
  : w.manual ? (w.open ? 'You can submit a new lossback form now.' : 'You can submit a new lossback form when staff open it again.')
  : w.open ? `You can submit a new lossback form until ${ts(w.end, 'F')} (${ts(w.end, 'R')}).`
  : `You can submit a new lossback form when it opens ${ts(w.start, 'F')} (${ts(w.start, 'R')}).`);

/** The list that new submissions go to, or null if none is set up (or it was deleted). */
function activeList(guildId) {
  const id = getSettings(guildId).lossback_list_id;
  const l = id ? getList(id) : null;
  return l && l.guild_id === guildId ? l : null;
}

const dateLabel = tz => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz }).format(new Date());

async function spawnList(interaction, target, title) {
  return createLossbackList(interaction.client, interaction.guildId, target, title, interaction.user.id);
}
/** A fresh, empty staff list; new submissions go to it. how = ' from the website' etc. for the log. */
async function createLossbackList(client, guildId, target, title, userId, how = '') {
  const tz = lbWindow(guildId).tz;
  const id = await createList(target, {
    guildId, userId, kind: 'lossback',
    title: title || `Lossback — ${dateLabel(tz)}`,
    description: 'All addresses are members\' **personal USDT (ETH)** wallets. ✅ = paid · ⬜ = waiting. Staff add the loss amount.',
    col1: 'Username', col2: 'USDT ETH Address', col3: 'Loss',
  });
  updateSettings(guildId, { lossback_list_id: id });
  await logToGuild(client, guildId, `💸 ${userId ? `<@${userId}>` : 'Staff'} started lossback list #${id} in ${target}${how}. New submissions go there now.`);
  reportToSite(client, guildId).catch(() => {});
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
  .addSubcommand(s => s.setName('config').setDescription('Code shown on the form, and when it is open (Fridays, default 08:00–20:00 UTC+1)')
    .addStringOption(o => o.setName('code').setDescription('Your Stake code, shown on the panel and form (e.g. MYCODE)').setMaxLength(40))
    .addStringOption(o => o.setName('timezone').setDescription('UTC+1 (default), UTC, or an IANA name like Europe/Amsterdam (follows summer time)').setMaxLength(60))
    .addIntegerOption(o => o.setName('opens').setDescription('Hour the form opens on Friday, 0–23 (default 8)').setMinValue(0).setMaxValue(23))
    .addIntegerOption(o => o.setName('closes').setDescription('Hour the form closes on Friday, 1–24 (default 20)').setMinValue(1).setMaxValue(24)));

/** The code members play under (set with /lossback config). */
const codeOf = s => s.lossback_code || null;

/** Lossback buttons, one per site. */
const lossbackButtons = () => siteButtons(site => `lb:submit:${site}`, site => `${SITES[site].label} lossback`);

function panelPayload(guildId, custom) {
  const s = getSettings(guildId);
  const w = lbWindow(guildId);
  const code = codeOf(s);
  return {
    embeds: [new EmbedBuilder().setColor(w.open ? '#2ECC71' : '#E67E22').setTitle('💸 Lossback')
      .setDescription(`${custom ?? `Lossback forms are open ${scheduleText(w)}. The times below are in your own timezone.\nPress **Stake lossback** and enter your Stake username${code ? ` (code **${code}**)` : ''} and your **personal USDT (ETH)** wallet. Staff will add your loss and pay you.`}\n\n${windowLine(w)}\n\n💳 ${WALLET_RULE}`)],
    components: [lossbackButtons()],
  };
}

// Posted panels are remembered so the bot can switch them between "Open now" and "Closed" by itself (refreshPanels, every 30 s from the scheduler)
db.exec('CREATE TABLE IF NOT EXISTS lossback_panels (message_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, guild_id TEXT NOT NULL, custom TEXT, state TEXT)');
const stateOf = w => `${w.open ? 'open' : 'closed'}:${w.manual ? 'manual' : `${w.start}:${w.end}`}:${w.days.join('')}:${w.openMin}-${w.closeMin}:${w.tz}`;

async function refreshPanels(client, guildId = null, force = false) {
  reportIfChanged(client).catch(() => {});
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
    const tzRaw = interaction.options.getString('timezone');
    const opens = interaction.options.getInteger('opens');
    const closes = interaction.options.getInteger('closes');
    const tz = tzRaw == null ? null : normTz(tzRaw);
    if (tzRaw != null && !tz) return interaction.reply(eph({ content: '❌ Unknown timezone. Use `UTC+1`, `UTC`, or an IANA name like `Europe/Amsterdam`, `Europe/London` or `America/New_York`.' }));
    const cur = lbConfig(g);
    const o = opens != null ? opens * 60 : cur.openMin, c = closes != null ? closes * 60 : cur.closeMin;
    if (o >= c) return interaction.reply(eph({ content: `❌ The form must open before it closes (you'd get ${hm(o)}–${hm(c)}).` }));
    const summary = () => {
      const s = getSettings(g), w = lbWindow(g);
      return `Stake code: **${s.lossback_code || 'not set'}**\nSchedule: ${scheduleText(w)}${w.manual ? ` (switched ${w.open ? 'open' : 'closed'} by hand on the website)` : ''}\n${windowLine(w)}\nDays, times and the on/off switch can also be set on the website: Ticket desk > Lossbacks.`;
    };
    if (code == null && tz == null && opens == null && closes == null) return interaction.reply(eph({ content: summary() }));
    updateSettings(g, {
      ...(code != null && { lossback_code: code.trim() || null }), ...(tz != null && { lossback_tz: tz }),
      ...(opens != null && { lossback_open_hour: opens, lossback_open_at: hm(opens * 60) }), ...(closes != null && { lossback_close_hour: closes, lossback_close_at: hm(closes * 60) }),
    });
    await interaction.deferReply(eph());
    await refreshPanels(interaction.client, g, true);
    reportToSite(interaction.client, g).catch(() => {});
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
    const site = siteOf(siteStr);                                                       // old panels (no site, or a removed one) -> Stake
    if (waitingEntry(l.id, interaction.user.id, site)) return interaction.reply(eph({ content: `✅ You already have a **${siteLabel(site)}** lossback submission waiting for staff. You can submit again once it has been paid.\n${windowLine(w)}` }));

    const code = codeOf(getSettings(g));
    const prof = await require('../siteTickets').profileOf(interaction.user.id);        // Stake username + wallet linked on the website (empty if none / site slow)
    const input = (id, label, ph, max, value) => {
      const t = new TextInputBuilder().setCustomId(id).setLabel(truncate(label, 45)).setPlaceholder(ph).setStyle(TextInputStyle.Short).setMaxLength(max).setRequired(true);
      if (value) t.setValue(String(value).slice(0, max));
      return new ActionRowBuilder().addComponents(t);
    };
    const name = SITES[site].label;
    return interaction.showModal(new ModalBuilder().setCustomId(`lbform:${site}`).setTitle(`${name} lossback`)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(w.end ? `⏰ This form closes ${ts(w.end, 'F')} (${ts(w.end, 'R')}).` : '⏰ This form is open until staff close it.'), walletNotice())
      .addComponents(
        input('username', code ? `${name} username under code ${code}` : `Your ${name} username`, `Your exact ${name} username`, 80, prof?.stake_username),
        input('address', 'Your PERSONAL USDT (ETH) wallet', '0x… your own wallet. NOT a Stake deposit address', 60, prof?.eth_address),
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
    reportToSite(interaction.client, g).catch(() => {});
    return interaction.reply(eph({ content: `✅ Your **${siteLabel(site)}** lossback was submitted ${ts(Date.now(), 'F')}. Staff will add your loss amount and pay you.${closesAt ? `\nThis form closes ${ts(closesAt, 'F')} (${ts(closesAt, 'R')}).` : ''}` }));
  },
};

// ---------- the website: settings from the Ticket desk, and what the bot runs reported back ----------

const guildOf = client => process.env.GUILD_ID || client.guilds.cache.first()?.id || null;
const sec = ms => (ms ? Math.floor(ms / 1000) : null);
let lastReport = { at: 0, sig: '' };

/** Tells the site what the form runs right now: schedule, open / closed, the list submissions go to. extra.error = a problem to show there. */
async function reportToSite(client, guildId = null, extra = {}) {
  const bridge = require('../bridge');
  if (!bridge.enabled()) return;
  const g = guildId || guildOf(client);
  if (!g) return;
  const s = getSettings(g), w = lbWindow(g), l = activeList(g);
  let list = null;
  if (l) {
    const n = db.prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN COALESCE(paid, 0) = 0 AND COALESCE(dq, 0) = 0 THEN 1 ELSE 0 END) AS w FROM list_entries WHERE list_id = ?').get(l.id);
    const ch = client.channels.cache.get(l.channel_id) ?? await client.channels.fetch(l.channel_id).catch(() => null);
    list = { id: l.id, title: l.title, channel: ch?.name || '', entries: n.n || 0, waiting: n.w || 0, created_at: sec(l.created_at) };
  }
  const panels = db.prepare('SELECT COUNT(*) AS n FROM lossback_panels WHERE guild_id = ?').get(g).n;
  const body = {
    action: 'lossback_state', rev: s.lossback_rev || 0, panels, list,
    settings: { days: w.days, open: hm(w.openMin), close: hm(w.closeMin), tz: w.tz, code: s.lossback_code || '', mode: w.mode },
    window: { open: w.open, manual: w.manual, start: sec(w.start), end: sec(w.end) }, ...extra,
  };
  const j = await bridge.api('POST', body);
  if (!j.ok) throw new Error(j.error || 'the site refused the lossback report');
  lastReport = { at: Date.now(), sig: stateOf(w) + `:${s.lossback_rev || 0}:${list?.id}:${list?.entries}:${list?.waiting}` };
}
/** From the scheduler (every 30 s, via refreshPanels): report when something changed, and at least every 5 minutes. */
async function reportIfChanged(client) {
  const g = guildOf(client);
  if (!g || !require('../bridge').enabled()) return;
  const s = getSettings(g), w = lbWindow(g), l = activeList(g);
  const n = l ? db.prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN COALESCE(paid, 0) = 0 AND COALESCE(dq, 0) = 0 THEN 1 ELSE 0 END) AS w FROM list_entries WHERE list_id = ?').get(l.id) : null;
  const sig = stateOf(w) + `:${s.lossback_rev || 0}:${l?.id}:${n?.n || 0}:${n?.w || 0}`;
  if (sig === lastReport.sig && Date.now() - lastReport.at < 300_000) return;
  await reportToSite(client, g);
}

/** Bridge events from the website: lossback.config (schedule / code / mode) and lossback.newlist. */
async function onSiteEvent(client, ev) {
  const d = ev.data || {};
  const g = guildOf(client);
  if (!g) throw new Error('the bot is not in a server yet');
  const who = d.by ? `<@${d.by}>` : (d.by_name || 'Staff');

  if (ev.type === 'lossback.config') {
    const days = [...new Set((Array.isArray(d.days) ? d.days : []).map(Number).filter(x => Number.isInteger(x) && x >= 0 && x <= 6))];
    const o = parseHM(d.open), c = parseHM(d.close), tz = normTz(String(d.tz || ''));
    const mode = ['auto', 'open', 'closed'].includes(d.mode) ? d.mode : 'auto';
    if (!days.length || o == null || c == null || o >= c || o >= 1440 || !tz) {
      updateSettings(g, { lossback_rev: Number(d.rev) || 0 });
      return reportToSite(client, g, { error: 'The bot could not use the last change from the website (invalid days, times or timezone). Nothing was changed.' });
    }
    const before = lbWindow(g);
    updateSettings(g, { lossback_days: days.join(','), lossback_open_at: hm(o), lossback_close_at: hm(c), lossback_tz: tz,
      lossback_code: String(d.code ?? '').trim() || null, lossback_mode: mode, lossback_rev: Number(d.rev) || 0 });
    const w = lbWindow(g);
    const what = before.mode !== w.mode
      ? (w.mode === 'open' ? 'opened the lossback form by hand' : w.mode === 'closed' ? 'closed the lossback form by hand' : 'put the lossback form back on its schedule')
      : 'changed the lossback schedule';
    await logToGuild(client, g, `🗓️ ${who} ${what} on the website. Schedule: ${scheduleText(w)}. ${windowLine(w)}`);
    await refreshPanels(client, g, true);
    return reportToSite(client, g);
  }

  if (ev.type === 'lossback.newlist') {
    db.exec('CREATE TABLE IF NOT EXISTS bot_flags (key TEXT PRIMARY KEY, at INTEGER)');
    const flag = `lbnew:${ev.seq}`;
    if (db.prepare('SELECT 1 FROM bot_flags WHERE key = ?').get(flag)) return;      // already done (event replayed after a restart)
    const cur = activeList(g);
    const target = cur && await client.channels.fetch(cur.channel_id).catch(() => null);
    if (!target) return reportToSite(client, g, { error: cur ? 'Could not start a new list: the current list\'s channel is gone. Use /lossback newlist in Discord.' : 'No lossback list yet: post the panel with /lossback panel in Discord first.' });
    await createLossbackList(client, g, target, String(d.title || '').trim() || null, d.by || null, ' from the website');
    db.prepare('INSERT OR REPLACE INTO bot_flags (key, at) VALUES (?, ?)').run(flag, Date.now());
  }
}

module.exports = { data, execute, buttons, modals, lbWindow, windowLine, againLine, refreshPanels, reportToSite, onSiteEvent };
