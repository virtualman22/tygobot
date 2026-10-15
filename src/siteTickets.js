/**
 * siteTickets.js — the bot's own Discord ticket channels (the panel buttons) <-> the website's ticket desk.
 *
 *   Discord -> site   a ticket channel opens           => a site ticket appears (marked DISCORD)
 *                     anyone writes in the channel     => the message shows in the site ticket (staff or member)
 *                     the channel is closed / deleted  => the site ticket is closed
 *   Site -> Discord   staff reply / claim / close on the site  => posted in the channel ("name: …")
 *                     staff "open a Discord ticket for a member" => the channel is created here, same as the panel button
 *   Forms             /profile lookup so claim + lossback forms open pre-filled with the Stake username and wallet linked on the site
 *
 * Reading what people write needs the Message Content intent (ENABLE_PRIVILEGED_INTENTS=true on Railway + the switch in the Developer Portal).
 * Everything here is best effort: if the site is down the Discord side keeps working exactly as before.
 */
const { getSettings } = require('./db');
const { isStaffMember } = require('./utils');

const bridge = () => require('./bridge');
const enabled = () => bridge().enabled();
const ticketInfo = topic => { const [tag, userId, cat] = String(topic ?? '').split(':'); return tag === 'ticket' ? { userId, cat } : null; };
const gid = client => process.env.GUILD_ID || client?.guilds?.cache?.first()?.id || null;

// ───────────── forms: autofill from the site profile ─────────────
const profiles = new Map();
/** Stake username / Kick name / wallet the member linked on the website. Never slows a form by more than 1.5 s; null if unknown. */
async function profileOf(userId) {
  if (!enabled() || !userId) return null;
  const hit = profiles.get(userId);
  if (hit && Date.now() - hit.at < 60_000) return hit.p;
  try {
    const j = await bridge().api('POST', { action: 'profile', discord_id: String(userId) }, '', 1500);
    const p = j.ok && j.found ? { stake_username: j.stake_username || '', kick_username: j.kick_username || '', eth_address: j.eth_address || '' } : null;
    profiles.set(userId, { at: Date.now(), p });
    if (profiles.size > 500) profiles.delete(profiles.keys().next().value);
    return p;
  } catch { return null; }
}

// ───────────── Discord -> site ─────────────
async function mirrorOpen(channel, userId, username, cat, by = '', req = '') {
  if (!enabled()) return null;
  return bridge().api('POST', { action: 'dc_ticket_open', channel_id: channel.id, user_id: String(userId), username: username || '', category: cat, by, req });
}

async function mirrorMessage(message) {
  if (!enabled()) return;
  const info = ticketInfo(message.channel.topic);
  if (!info) return;
  let text = message.content || '';
  const files = [...message.attachments.values()].map(a => a.url);
  if (files.length) text += `${text ? '\n' : ''}${files.map(u => `📎 ${u}`).join('\n')}`;
  if (!text.trim()) return;
  const body = {
    action: 'dc_ticket_msg', channel_id: message.channel.id, author_id: message.author.id,
    author_name: message.member?.displayName || message.author.username, staff: isStaffMember(message.member, message.guildId), text,
  };
  let j = await bridge().api('POST', body);
  if (!j.ok && /No site ticket/i.test(j.error || '')) {             // the channel is older than the link: create its site ticket now, then retry once
    const owner = await message.client.users.fetch(info.userId).catch(() => null);
    await mirrorOpen(message.channel, info.userId, owner?.username || '', info.cat);
    j = await bridge().api('POST', body);
  }
  if (!j.ok) console.warn('[site tickets] message not mirrored:', j.error);
}

async function mirrorState(channelId, closed, by) {
  if (!enabled()) return;
  await bridge().api('POST', { action: 'dc_ticket_state', channel_id: channelId, closed, by });
}

// ───────────── site -> Discord ─────────────
/** ticket.msg / ticket.state of a ticket that lives in a Discord channel. */
async function onDcTicket(client, ev) {
  const d = ev.data;
  if (ev.src === 'discord') return;                                       // it came from the channel itself
  const ch = await client.channels.fetch(d.dc_channel).catch(() => null);
  if (!ch?.send) { bridge().state.dropped++; return; }                    // channel is gone
  if (ev.type === 'ticket.msg') {
    if (d.from !== 'staff' && d.from !== 'user') return;                  // internal notes and system lines stay on the site
    await ch.send({ content: `**${d.name}**: ${d.text}`.slice(0, 1990), allowedMentions: { parse: [] } });
  } else if (ev.type === 'ticket.state') {
    if (d.status === 'closed') await ch.send({ content: '🔒 This ticket was closed from the website. A mod can delete the channel with **Close ticket**.', allowedMentions: { parse: [] } });
    else if (d.assigned_name) await ch.send({ content: `🙋 **${d.assigned_name}** is handling this ticket (from the website).`, allowedMentions: { parse: [] } });
  }
}

/** Staff pressed "open a Discord ticket for a member" on the site. */
async function onDcOpen(client, ev, api) {
  const d = ev.data;
  const fail = async msg => { await api('POST', { action: 'dc_open_result', req: d.req, error: msg }).catch(() => {}); };
  const { openTicketChannel, CATEGORIES } = require('./commands/ticket');
  if (!CATEGORIES[d.category]) return fail('Unknown ticket category.');
  const g = gid(client);
  const guild = g && (client.guilds.cache.get(g) || await client.guilds.fetch(g).catch(() => null));
  if (!guild) return fail('The bot is not in the server.');
  const member = await guild.members.fetch(String(d.uid)).catch(() => null);
  if (!member) return fail('That person is not in the Discord server (or the ID is wrong).');
  let r;
  try { r = await openTicketChannel(client, guild, member.id, member.user.username, d.category); }
  catch (e) { return fail(`Discord refused: ${e.message}`); }
  const channel = r.channel ?? r.existing;
  const j = await mirrorOpen(channel, member.id, member.user.username, d.category, d.by_name || '', d.req);
  if (!j?.ok) return fail(j?.error || 'The site could not register the ticket.');
  if (d.text) {                                                           // optional first message, shown in the channel and recorded on the site ticket
    await channel.send({ content: `**${d.by_name || 'Staff'}**: ${d.text}`.slice(0, 1990), allowedMentions: { parse: [] } }).catch(() => {});
    await api('POST', { action: 'dc_ticket_msg', channel_id: channel.id, author_id: d.by, author_name: d.by_name || 'Staff', staff: true, text: d.text }).catch(() => {});
  }
}

module.exports = { profileOf, mirrorOpen, mirrorMessage, mirrorState, onDcTicket, onDcOpen };
