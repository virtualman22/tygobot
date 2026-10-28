/**
 * transcripts.js — the complete history of every Discord ticket channel, copied to the website (Ticket desk > TRANSCRIPTS).
 *
 * Every message goes: the member, staff AND the bot (panel text, claim forms, payment notes), with the author's avatar, name and the
 * exact time it was posted. Image attachments are saved by the site, because Discord's attachment links expire after about a day.
 *
 *   a few seconds after any message in a ticket channel   -> that channel's new messages
 *   every 5 minutes                                        -> every open ticket channel (catches what was missed while the bot was offline)
 *   Close ticket (before the channel is deleted)           -> one last sync, marked closed
 *
 * Only messages after the last one sent are fetched (remembered per channel); sending one twice is harmless (the site keys them by message id).
 * Needs the Message Content intent, like the ticket mirror: without it members' text arrives empty (bot messages and attachments still come through).
 */
const { db } = require('./db');
const { isStaffMember } = require('./utils');

db.exec('CREATE TABLE IF NOT EXISTS transcript_sync (channel_id TEXT PRIMARY KEY, last_id TEXT, at INTEGER)');

const EVERY_MS = 5 * 60_000;
const BATCH = 50;
const bridge = () => require('./bridge');
const isTicket = ch => String(ch?.topic ?? '').startsWith('ticket:');
const relays = new Map();      // message id -> { name, uid }: lines the bot posted for a staff member who wrote on the website
const pending = new Map();     // channel id -> debounce timer
const running = new Map();     // channel id -> the sync in progress (syncs of one channel run one after another)
let timer = null;

function markRelay(messageId, name, uid) {
  relays.set(messageId, { name, uid: uid ? String(uid) : '' });
  if (relays.size > 2000) relays.delete(relays.keys().next().value);
}

/** <@id>, <@&role>, <#channel>, <t:…> -> readable text. */
function readable(text, guild) {
  return String(text ?? '')
    .replace(/<@!?(\d+)>/g, (m, id) => { const mem = guild?.members.cache.get(id); const u = mem?.user ?? guild?.client.users.cache.get(id); return u ? `@${mem?.displayName || u.globalName || u.username}` : m; })
    .replace(/<@&(\d+)>/g, (m, id) => { const r = guild?.roles.cache.get(id); return r ? `@${r.name}` : m; })
    .replace(/<#(\d+)>/g, (m, id) => { const c = guild?.channels.cache.get(id); return c ? `#${c.name}` : m; })
    .replace(/<t:(\d+)(?::[a-zA-Z])?>/g, (m, s) => `${new Date(Number(s) * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`);
}

const embedText = (e, guild) => [e.author?.name, e.title, e.description, ...(e.fields ?? []).map(f => `${f.name}: ${f.value}`), e.footer?.text]
  .filter(Boolean).map(s => readable(s, guild)).join('\n');

/** One message in the shape api_bridge.php (dc_transcript) expects. */
function pack(m) {
  const relay = m.author.id === m.client.user.id ? relays.get(m.id) : null;
  let text = readable(m.content, m.guild);
  if (relay) text = text.replace(/^\*\*[^*]+\*\*: /, '');               // "**name**: text" -> the name is shown as the author instead
  return {
    id: m.id, t: m.createdTimestamp, edited: m.editedTimestamp || null,
    a: relay ? relay.uid : m.author.id, u: relay ? '' : m.author.username,
    n: relay ? relay.name : (m.member?.displayName || m.author.globalName || m.author.username),
    av: relay ? '' : (m.member ?? m.author).displayAvatarURL({ extension: 'png', size: 64 }),
    bot: m.author.bot && !relay, staff: Boolean(relay) || (!m.author.bot && isStaffMember(m.member, m.guildId)), via: relay ? 'website' : '',
    text, embeds: m.embeds.map(e => embedText(e, m.guild)).filter(Boolean),
    files: [...m.attachments.values()].map(a => ({ id: a.id, name: a.name, url: a.url, type: a.contentType || '', size: a.size })),
  };
}

async function doSync(channel, closed) {
  const [, userId, cat] = String(channel.topic).split(':');
  const meta = { channel_id: channel.id, channel_name: channel.name, user_id: userId, category: cat, opened_at: channel.createdTimestamp };
  const send = async (messages, last) => {
    const j = await bridge().api('POST', { action: 'dc_transcript', ...meta, closed: closed && last, messages }, '', 25_000);
    if (!j.ok) throw new Error(j.error || 'the site refused the transcript');
  };
  let after = db.prepare('SELECT last_id FROM transcript_sync WHERE channel_id = ?').get(channel.id)?.last_id || '0';
  for (;;) {
    const got = await channel.messages.fetch({ after, limit: 100, cache: false });
    const msgs = [...got.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    const end = got.size < 100;
    const packed = msgs.map(pack).filter(m => m.text || m.embeds.length || m.files.length);
    for (let i = 0; i < packed.length; i += BATCH) await send(packed.slice(i, i + BATCH), end && i + BATCH >= packed.length);
    if (end && !packed.length && closed) await send([], true);
    if (msgs.length) {
      after = msgs[msgs.length - 1].id;
      db.prepare('INSERT INTO transcript_sync (channel_id, last_id, at) VALUES (?, ?, ?) ON CONFLICT(channel_id) DO UPDATE SET last_id = excluded.last_id, at = excluded.at')
        .run(channel.id, after, Date.now());
    }
    if (end) break;
  }
}

/** Sends the channel's messages the site doesn't have yet. closed: the ticket is being closed (last sync). */
function syncChannel(channel, { closed = false } = {}) {
  if (!bridge().enabled() || !isTicket(channel) || !channel.messages) return Promise.resolve();
  const run = (running.get(channel.id) ?? Promise.resolve()).catch(() => {}).then(() => doSync(channel, closed));
  running.set(channel.id, run);
  run.catch(() => {}).finally(() => { if (running.get(channel.id) === run) running.delete(channel.id); });
  return run;
}

/** A message was posted in a channel: sync it a few seconds later (one sync for a burst of messages). */
function touch(channel) {
  if (!bridge().enabled() || !isTicket(channel)) return;
  clearTimeout(pending.get(channel.id));
  pending.set(channel.id, setTimeout(() => {
    pending.delete(channel.id);
    syncChannel(channel).catch(e => console.warn(`[transcripts] #${channel.name}:`, e.message));
  }, 4000));
}

/** Close ticket pressed: last sync before the channel is deleted. Never throws (the channel is deleted either way). */
async function closeChannel(channel) {
  clearTimeout(pending.get(channel.id)); pending.delete(channel.id);
  await syncChannel(channel, { closed: true }).catch(e => console.warn(`[transcripts] #${channel.name} (closing):`, e.message));
  db.prepare('DELETE FROM transcript_sync WHERE channel_id = ?').run(channel.id);
}

/** The channel is already gone (deleted by hand): nothing left to fetch, just mark the transcript closed. */
async function markDeleted(channel) {
  clearTimeout(pending.get(channel.id)); pending.delete(channel.id);
  db.prepare('DELETE FROM transcript_sync WHERE channel_id = ?').run(channel.id);
  if (!bridge().enabled()) return;
  await bridge().api('POST', { action: 'dc_transcript', channel_id: channel.id, closed: true, messages: [] }).catch(() => {});
}

async function sweep(client) {
  for (const guild of client.guilds.cache.values()) {
    for (const ch of guild.channels.cache.values()) {
      if (isTicket(ch)) await syncChannel(ch).catch(e => console.warn(`[transcripts] #${ch.name}:`, e.message));
    }
  }
}

function start(client) {
  if (timer) return;
  setTimeout(() => sweep(client), 25_000);
  timer = setInterval(() => sweep(client), EVERY_MS);
}

module.exports = { start, touch, syncChannel, closeChannel, markDeleted, markRelay };
