/**
 * bridge.js — links the website to this bot.
 *
 * The website writes events (api_bridge.php). This file polls them every few seconds with the shared secret, posts them to
 * Discord, and only then tells the site "done" (ack). If the bot is offline or redeploys nothing is lost or posted twice:
 * the site remembers how far the bot got.
 *
 *   Guess The Balance (site)  ->  every guess, guessing opened/closed, final result + ranking  ->  GTB channel
 *   Site tickets              ->  one thread per ticket (staff-only channel), full chat mirrored, buttons to reply/claim/close
 *
 * Needs (Railway variables):  SITE_URL, BRIDGE_SECRET   (same secret as 'bridge_secret' in the site's config.local.php)
 * Optional:                   BRIDGE_POLL_MS (4000), GTB_GUESS_MODE=live|close (live), GTB_CHANNEL_ID, SITE_TICKETS_CHANNEL_ID
 * Channels are normally set in Discord with  /setup set gtb_channel:#...  and  site_tickets_channel:#...
 */
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { db, getSettings } = require('./db');

const SITE = (process.env.SITE_URL || '').replace(/\/+$/, '').replace(/^(?!https?:\/\/)(?=.)/, 'https://');
const SECRET = process.env.BRIDGE_SECRET || '';
const POLL_MS = Math.max(2000, Number(process.env.BRIDGE_POLL_MS) || 4000);
const GUESS_MODE = process.env.GTB_GUESS_MODE === 'close' ? 'close' : 'live';
const MAX_TRIES = 5;

const enabled = () => Boolean(SITE && SECRET);
const state = { started: false, lastOk: 0, lastError: null, lastErrorAt: 0, handled: 0, dropped: 0, head: 0 };
const tries = new Map();
let running = false;
let timer = null;
let clientRef = null;
let cmdTouched = false;                 // a website command changed a record: send it back to the site right after this poll

const money = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
const clip = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, n - 1) + '…' : String(s ?? ''));
const noPing = { parse: [] };
const medals = ['🥇', '🥈', '🥉'];

// ───────────── talking to the site ─────────────
async function api(method, body, query = '', timeoutMs = 10_000) {
  const res = await fetch(`${SITE}/api_bridge.php${query}`, {
    method,
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await res.json().catch(() => null);
  if (!j) throw new Error(`the site answered HTTP ${res.status} (not JSON). Check SITE_URL.`);
  return j;
}

// ───────────── where things go ─────────────
function guildId() { return process.env.GUILD_ID || clientRef?.guilds.cache.first()?.id || null; }
function cfg() { const g = guildId(); return g ? getSettings(g) : {}; }
const gtbChannelId = () => cfg().gtb_channel || process.env.GTB_CHANNEL_ID || null;
const ticketChannelId = () => cfg().site_tickets_channel || process.env.SITE_TICKETS_CHANNEL_ID || null;

async function channelOf(id) {
  if (!id) return null;
  return clientRef.channels.fetch(id).catch(() => null);
}

// ───────────── Guess The Balance ─────────────
async function onGtb(ev) {
  const d = ev.data;
  const ch = await channelOf(gtbChannelId());
  if (!ch) { state.dropped++; warn('GTB event skipped: no GTB channel set. Use /setup set gtb_channel:#channel'); return; }

  if (ev.type === 'gtb.created') {
    return ch.send({ embeds: [new EmbedBuilder().setColor('#2ECC71').setTitle(`💰 Guess The Balance — ${clip(d.hunt, 80)}`)
      .setDescription('A new bonus hunt just started. Guessing opens soon, keep an eye on this channel.')
      .addFields({ name: 'Start balance', value: `**${money(d.start_balance)}**`, inline: true })] });
  }

  if (ev.type === 'gtb.guessing') {
    if (d.open) {
      return ch.send({ embeds: [new EmbedBuilder().setColor('#2ECC71').setTitle('🟢 Guessing is OPEN')
        .setDescription(`**${clip(d.hunt, 80)}**\nGuess the final balance on the website: ${SITE}\n⚠️ One guess per person.`)] });
    }
    await ch.send({ embeds: [new EmbedBuilder().setColor('#E74C3C').setTitle('🔒 Guessing closed')
      .setDescription(`**${clip(d.hunt, 80)}**\nNo more guesses. **${d.count}** ${d.count === 1 ? 'guess is' : 'guesses are'} locked in. Good luck everyone!`)] });
    if (GUESS_MODE === 'close') {
      const rows = db.prepare('SELECT * FROM site_gtb_guesses WHERE hunt_id = ? ORDER BY ts').all(d.hunt_id);
      await sendList(ch, `🎯 All guesses (${rows.length})`, rows.map((r, i) => `${i + 1}. **${clip(r.name, 40)}** — ${money(r.guess)}`));
    }
    return;
  }

  if (ev.type === 'gtb.guess') {
    db.prepare('INSERT OR REPLACE INTO site_gtb_guesses (hunt_id, discord_id, name, guess, ts) VALUES (?, ?, ?, ?, ?)')
      .run(d.hunt_id, d.discord_id, d.name, d.guess, ev.t * 1000);
    if (GUESS_MODE !== 'live') return;
    return ch.send({ content: `🎯 **${clip(d.name, 40)}** guessed **${money(d.guess)}** · guess #${d.count}`, allowedMentions: noPing });
  }

  if (ev.type === 'gtb.finished') {
    const r = d.ranked ?? [];
    const dir = x => (x.diff === 0 ? 'exact!' : x.guess > d.final_balance ? 'over' : 'under');
    const top = r.slice(0, 3);
    const embed = new EmbedBuilder().setColor('#F1C40F').setTitle(`🏁 GTB result — ${clip(d.hunt, 80)}`)
      .addFields({ name: 'Final balance', value: `**${money(d.final_balance)}**`, inline: true }, { name: 'Start balance', value: money(d.start_balance), inline: true })
      .setDescription(top.length ? top.map((x, i) => `${medals[i]} **${clip(x.name, 40)}** (<@${x.discord_id}>) — guessed **${money(x.guess)}** · off by **${money(x.diff)}** (${dir(x)})`).join('\n') : '*Nobody entered this one.*')
      .setFooter({ text: `${d.total} total ${d.total === 1 ? 'entry' : 'entries'}` });
    if (top[0]) embed.addFields({ name: 'Winner', value: `🎉 <@${top[0].discord_id}>` });
    await ch.send({ embeds: [embed], allowedMentions: { users: top.map(x => String(x.discord_id)) } });
    if (r.length > 3) {
      const lines = r.slice(3).map((x, i) => `${i + 4}. **${clip(x.name, 40)}** — ${money(x.guess)} · off by ${money(x.diff)}`);
      if (d.total > r.length) lines.push(`…and ${d.total - r.length} more`);
      await sendList(ch, '📋 Full ranking', lines);
    }
    db.prepare('DELETE FROM site_gtb_guesses WHERE hunt_id = ?').run(d.hunt_id);
  }
}

/** Sends a long list as one or more embeds (Discord caps an embed description at 4096 characters). */
async function sendList(ch, title, lines) {
  if (!lines.length) return;
  let buf = [], len = 0, part = 0;
  const flush = async () => {
    if (!buf.length) return;
    await ch.send({ embeds: [new EmbedBuilder().setColor('#9146FF').setTitle(part ? `${title} (cont.)` : title).setDescription(buf.join('\n'))], allowedMentions: noPing });
    buf = []; len = 0; part++;
  };
  for (const l of lines) {
    if (len + l.length + 1 > 3800) await flush();
    buf.push(l); len += l.length + 1;
  }
  await flush();
}

// ───────────── Site tickets <-> Discord threads ─────────────
const ticketRow = id => db.prepare('SELECT * FROM site_tickets WHERE ticket_id = ?').get(id);

function cardEmbed(i) {
  const closed = i.status === 'closed';
  const e = new EmbedBuilder().setColor(closed ? '#95A5A6' : i.assigned_name ? '#9146FF' : '#F1C40F')
    .setTitle(`🎫 #${i.num} · ${clip(i.category_label, 60)}`)
    .addFields(
      { name: 'Member', value: `<@${i.uid}> (${clip(i.name, 40)})`, inline: true },
      { name: 'Stake', value: clip(i.stake, 60) || '*not linked*', inline: true },
      { name: 'Kick', value: clip(i.kick, 60) || '*not linked*', inline: true },
      { name: 'Status', value: closed ? '🔒 Closed' : i.assigned_name ? `🟣 In progress — ${clip(i.assigned_name, 40)}` : '🟡 Unclaimed', inline: true },
    )
    .setFooter({ text: 'Website ticket. Replies sent with the buttons below reach the member on the site.' });
  if (i.giveaway) e.addFields({ name: 'Giveaway', value: clip(i.giveaway, 200), inline: true });
  if (i.pending > 0) e.addFields({ name: 'To pay', value: `${i.pending} reward${i.pending > 1 ? 's' : ''} waiting`, inline: true });
  return e;
}

function cardButtons(i, id) {
  const b = (action, label, style, emoji) => new ButtonBuilder().setCustomId(`sl:${action}:${id}`).setLabel(label).setStyle(style).setEmoji(emoji);
  const row = new ActionRowBuilder();
  if (i.status === 'closed') row.addComponents(b('reopen', 'Reopen', ButtonStyle.Success, '🔓'));
  else {
    row.addComponents(b('reply', 'Reply to member', ButtonStyle.Primary, '💬'), b('note', 'Internal note', ButtonStyle.Secondary, '📝'));
    if (!i.assigned_name) row.addComponents(b('claim', 'Claim', ButtonStyle.Success, '✋'));
    row.addComponents(b('close', 'Close', ButtonStyle.Danger, '🔒'));
  }
  row.addComponents(new ButtonBuilder().setLabel('Open on site').setStyle(ButtonStyle.Link).setURL(`${SITE}/admin_tickets.php`));
  return [row];
}

async function onTicket(ev) {
  const d = ev.data;
  if (d.dc_channel) return require('./siteTickets').onDcTicket(clientRef, ev);     // a Discord ticket channel mirrored on the site: talk in that channel, no thread

  if (ev.type === 'ticket.created') {
    const ch = await channelOf(ticketChannelId());
    if (!ch?.threads) { state.dropped++; warn('Ticket event skipped: no site-tickets channel set. Use /setup set site_tickets_channel:#staff-channel'); return; }
    let row = ticketRow(d.ticket_id);
    const info = { num: d.num, uid: d.uid, name: d.name, stake: d.stake, kick: d.kick, category_label: d.category_label, giveaway: d.giveaway, status: 'open', assigned_name: null, pending: 0 };
    if (!row) {
      const mod = cfg().mod_role;
      const card = await ch.send({
        content: mod ? `<@&${mod}> new website ticket` : undefined,
        embeds: [cardEmbed(info)], components: cardButtons(info, d.ticket_id),
        allowedMentions: { roles: mod ? [mod] : [] },
      });
      db.prepare('INSERT INTO site_tickets (ticket_id, num, channel_id, thread_id, card_id, info) VALUES (?, ?, ?, NULL, ?, ?)')
        .run(d.ticket_id, d.num, ch.id, card.id, JSON.stringify(info));
      row = ticketRow(d.ticket_id);
    }
    if (!row.thread_id) {
      const card = await ch.messages.fetch(row.card_id);
      const thread = await card.startThread({ name: clip(`#${d.num} · ${d.name} · ${d.category_label}`, 100), autoArchiveDuration: 10080 });
      db.prepare('UPDATE site_tickets SET thread_id = ? WHERE ticket_id = ?').run(thread.id, d.ticket_id);
    }
    return;
  }

  const row = ticketRow(d.ticket_id);
  if (!row) return;                                   // ticket was opened before the bridge was switched on: nothing to mirror into
  const info = JSON.parse(row.info);

  if (ev.type === 'ticket.msg') {
    const thread = await channelOf(row.thread_id);
    if (!thread) return;
    if (thread.archived) await thread.setArchived(false).catch(() => {});
    const who = clip(d.name, 40);
    const text = d.from === 'user' ? `💬 **${who}** (member)\n${d.text}`
      : d.from === 'staff' ? `🛡️ **${who}** (staff → member)\n${d.text}`
      : d.from === 'note' ? `📝 **Internal note · ${who}** (not shown to the member)\n${d.text}`
      : `ℹ️ ${d.text}`;
    for (let i = 0; i < text.length; i += 1900) await thread.send({ content: text.slice(i, i + 1900), allowedMentions: noPing });
    return;
  }

  if (ev.type === 'ticket.state') {
    info.status = d.status; info.assigned_name = d.assigned_name; info.pending = d.pending;
    db.prepare('UPDATE site_tickets SET info = ? WHERE ticket_id = ?').run(JSON.stringify(info), d.ticket_id);
    const ch = await channelOf(row.channel_id);
    const card = ch ? await ch.messages.fetch(row.card_id).catch(() => null) : null;
    if (card) await card.edit({ embeds: [cardEmbed(info)], components: cardButtons(info, d.ticket_id) }).catch(e => warn('card edit failed: ' + e.message));
    const thread = await channelOf(row.thread_id);
    if (thread) await thread.setArchived(d.status === 'closed').catch(() => {});
    return;
  }

  if (ev.type === 'ticket.deleted') {
    const thread = await channelOf(row.thread_id);
    if (thread) await thread.delete('Ticket deleted on the website').catch(() => {});
    const ch = await channelOf(row.channel_id);
    const card = ch ? await ch.messages.fetch(row.card_id).catch(() => null) : null;
    if (card) await card.delete().catch(() => {});
    db.prepare('DELETE FROM site_tickets WHERE ticket_id = ?').run(d.ticket_id);
  }
}

// ───────────── the poll loop ─────────────
const lastWarn = new Map();
function warn(msg) {
  const now = Date.now();
  if (now - (lastWarn.get(msg) ?? 0) < 600_000) return;     // same warning at most every 10 minutes
  lastWarn.set(msg, now);
  console.warn('[site bridge]', msg);
}

async function handle(ev) {
  if (ev.type === 'ticket.dc_open') return require('./siteTickets').onDcOpen(clientRef, ev, api);
  if (ev.type === 'record.cmd') { const k = await require('./siteCmd').handle(clientRef, ev, api); if (k.length) cmdTouched = true; return; }
  if (ev.type.startsWith('gtb.')) return onGtb(ev);
  if (ev.type.startsWith('ticket.')) return onTicket(ev);
}

/** Sends changed records to the site now (not in a minute). If a sync is already running, tries again shortly. */
function kickSync(n = 0) {
  const sync = require('./siteSync');
  if (sync.state.running && n < 5) return setTimeout(() => kickSync(n + 1), 2500);
  sync.syncOnce(clientRef, api).catch(() => {});
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const j = await api('GET', null, '?action=events&consumer=bot&limit=50');
    if (!j.ok) throw new Error(j.error || 'the site refused the request');
    state.head = j.head ?? state.head;
    let ackTo = 0;
    for (const ev of j.events) {
      try { await handle(ev); state.handled++; ackTo = ev.seq; tries.delete(ev.seq); }
      catch (e) {
        const n = (tries.get(ev.seq) ?? 0) + 1;
        tries.set(ev.seq, n);
        console.error(`[site bridge] ${ev.type} #${ev.seq} failed (try ${n}/${MAX_TRIES}):`, e.message);
        if (n >= MAX_TRIES) { state.dropped++; ackTo = ev.seq; tries.delete(ev.seq); continue; }   // give up on one poisoned event instead of blocking everything
        break;                                                                                    // keep order: retry this one on the next tick
      }
    }
    if (ackTo) await api('POST', { action: 'ack', consumer: 'bot', seq: ackTo });
    if (cmdTouched) { cmdTouched = false; kickSync(); }
    state.lastOk = Date.now(); state.lastError = null;
  } catch (e) {
    state.lastError = e.message; state.lastErrorAt = Date.now();
    warn('poll failed: ' + e.message);
  } finally { running = false; }
}

function start(client) {
  clientRef = client;
  if (!enabled()) { console.log('[site bridge] off (set SITE_URL and BRIDGE_SECRET to link the website)'); return; }
  if (timer) return;
  state.started = true;
  console.log(`[site bridge] on: polling ${SITE} every ${POLL_MS / 1000}s, guesses posted ${GUESS_MODE === 'live' ? 'live' : 'when guessing closes'}`);
  tick();
  timer = setInterval(tick, POLL_MS);
  require('./siteSync').start(client, api);     // claim forms, rewards tracker and lossbacks -> website (old ones too)
}

module.exports = { start, tick, api, enabled, state, cardEmbed, handle, SITE, gtbChannelId, ticketChannelId, _setClient: c => { clientRef = c; } };
