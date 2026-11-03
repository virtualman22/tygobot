/**
 * memberCard.js — the website member card: Discord avatar, Kick and Stake names, site points and the current leaderboard wager.
 *
 *   Ticket opens  -> the card is posted in the ticket channel (the member and staff see it), with a Refresh button
 *   /card         -> staff pull up anyone's card, privately; staff on the website's staff list also see the staff block
 *
 * Data comes from the site (api_bridge.php action member_card) over the existing link (SITE_URL + BRIDGE_SECRET).
 * Best effort: if the link is off or the site is slow, tickets open exactly as before, just without the card.
 */
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, escapeMarkdown } = require('discord.js');

const bridge = () => require('./bridge');
const money = n => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
const num = n => Math.round(Number(n) || 0).toLocaleString('en-US');
const rel = sec => (sec ? `<t:${Math.floor(sec)}:R>` : '—');
const day = sec => (sec ? `<t:${Math.floor(sec)}:D>` : '—');
const clip = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, n - 1) + '…' : String(s ?? ''));
const safe = s => escapeMarkdown(clip(String(s ?? ''), 80));   // names show exactly as written, never as markdown

/** Asks the site for a card. who = { discord_id } or { query }. Returns the card, { found: false }, or null when the site can't be reached. */
async function fetchCard(who, viewerId) {
  if (!bridge().enabled()) return null;
  try {
    const j = await bridge().api('POST', { action: 'member_card', ...who, viewer_id: viewerId ? String(viewerId) : '' }, '', 20_000);
    return j && j.ok ? j : null;
  } catch { return null; }
}

function leaderboardLine(c) {
  if (c.lb_state === 'unlinked') return 'No Stake account linked';
  if (c.lb_state !== 'ok') return 'Could not reach Stake right now';
  if (!c.lb) return `Not on the board yet${c.season ? ` (${safe(c.season)})` : ''}`;
  return `**${money(c.lb.weighted)}** weighted · rank **#${c.lb.rank}**\n${money(c.lb.wagered)} wagered${c.season ? ` · ${safe(c.season)}` : ''}${c.season_live ? '' : ' (ended)'}`;
}

/** The embed. user = the Discord user (for the live avatar and name); staff = show the staff block when the site sent one. */
function cardEmbed(c, user, { staff = false } = {}) {
  const name = user?.globalName || user?.username || c.username || 'Member';
  const avatar = user?.displayAvatarURL?.({ size: 128 }) || (/^https:\/\/cdn\.discordapp\.com\//.test(c.avatar) ? c.avatar : null);
  const e = new EmbedBuilder().setColor('#9146FF')
    .setAuthor({ name: `${clip(name, 80)} · website member`, iconURL: avatar || undefined })   // author names are plain text in Discord
    .setThumbnail(avatar || null)
    .addFields(
      { name: 'Kick', value: c.kick ? `${safe(c.kick)} ${c.kick_verified ? '✅' : '(not verified)'}` : 'Not linked', inline: true },
      { name: 'Stake', value: c.stake ? safe(c.stake) : 'Not linked', inline: true },
      { name: 'Site points', value: `⭐ **${num(c.points)}**\n${num(c.points_total)} earned all time`, inline: true },
      { name: 'Current leaderboard', value: leaderboardLine(c) },
    )
    .setFooter(c.joined ? { text: 'Website member since' } : null)
    .setTimestamp(c.joined ? c.joined * 1000 : null);
  if (staff && c.staff) {
    const s = c.staff;
    const status = s.frozen ? `🧊 Frozen${s.frozen_reason ? `: ${safe(s.frozen_reason)}` : ''}` : s.held ? '⏸️ Auto-held (possible alt)' : '✅ Active';
    e.addFields(
      { name: '🛡️ Staff only', value: [
        `**Status:** ${status}`,
        `**All-time wagered:** ${c.stake ? (s.all ? `${money(s.all.wagered)} (${money(s.all.weighted)} weighted)` : 'nothing found') : '—'}`,
        `**Moon:** ${s.moon ? safe(s.moon) : 'not linked'} · **Payout wallet:** ${s.wallet ? 'linked' : 'none'}`,
        `**Last seen on the site:** ${rel(s.last_seen)} · **Discord ID:** \`${c.discord_id}\``,
      ].join('\n') },
    );
    if (s.frozen || s.held) e.setColor('#E67E22');
  }
  return e;
}

const notLinkedEmbed = (userId, self) => new EmbedBuilder().setColor('#95A5A6').setTitle('🔗 Not linked to the website yet')
  .setDescription(`${self ? 'You haven\'t' : `<@${userId}> hasn't`} logged in on the website yet, so there is no member card.\nLog in with Discord at ${bridge().SITE}/login.php to link Kick and Stake and start earning points.`);

const refreshRow = userId => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`mc:refresh:${userId}`).setLabel('Refresh card').setEmoji('🔄').setStyle(ButtonStyle.Secondary));

/** Posts the member's card in their new ticket channel. Never throws. */
async function postToTicket(channel, userId, client) {
  if (!bridge().enabled()) return;
  try {
    const user = await client.users.fetch(userId).catch(() => null);
    const c = await fetchCard({ discord_id: String(userId) });
    if (!c) return;                                                        // site unreachable: the ticket works as before
    if (!c.found) return void await channel.send({ embeds: [notLinkedEmbed(userId, true)], allowedMentions: { parse: [] } });
    await channel.send({ embeds: [cardEmbed(c, user)], components: [refreshRow(userId)], allowedMentions: { parse: [] } });
  } catch (e) { console.warn('[member card] could not post:', e.message); }
}

module.exports = { fetchCard, cardEmbed, notLinkedEmbed, refreshRow, postToTicket };
