/**
 * referrals.js — the referral program's Discord side. The website keeps the data (referrals_lib.php); the bot never stores
 * referrals itself, so both always agree. This file handles the site's ref.* events (src/bridge.js):
 *   ref.referral       -> a staff card per referral (Verify / Void / Restore), kept up to date
 *   ref.reward         -> a staff card per reward (Mark paid / Void), a shout-out in the public referral channel, a DM to the referrer
 *   ref.reward_state   -> the reward card is updated; the referrer gets a DM when it is paid
 * Channels: /setup set referral_channel:#public referral_staff_channel:#staff (both optional; without them only the DMs are sent).
 * The /referral command (commands/referral.js) and the buttons talk to the site through bridge.api().
 */
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { db, getSettings } = require('./db');

db.exec('CREATE TABLE IF NOT EXISTS ref_cards (key TEXT PRIMARY KEY, channel_id TEXT, message_id TEXT, status TEXT)');

const money = n => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const clip = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, n - 1) + '…' : String(s ?? ''));
const t = (sec, style = 'f') => (sec ? `<t:${Math.floor(sec)}:${style}>` : '—');
const site = () => (process.env.SITE_URL || '').replace(/\/+$/, '').replace(/^(?!https?:\/\/)(?=.)/, 'https://');
const STATUS = { pending: '⏳ Waiting for Stake verification', active: '✅ Active', void: '🚫 Void' };
const RW_STATUS = { pending: '⏳ To pay', paid: '✅ Paid', void: '🚫 Void' };

let clientRef = null;
function cfg() {
  const g = process.env.GUILD_ID || clientRef?.guilds.cache.first()?.id;
  return g ? getSettings(g) : {};
}

const lastWarn = new Map();
function warn(msg) {
  if (Date.now() - (lastWarn.get(msg) ?? 0) < 600_000) return;
  lastWarn.set(msg, Date.now());
  console.warn('[referrals]', msg);
}

// ───────────── texts shared with /referral ─────────────
const who = (id, name) => (id ? `<@${id}>${name ? ` (${clip(name, 40)})` : ''}` : clip(name, 40) || '—');

/** What a reward is for, in one line. */
function rewardWhat(x, referee = '') {
  const of = referee ? ` · ${clip(referee, 40)}` : '';
  if (x.type === 'ladder') {
    const extra = Number(x.amount) < Number(x.tier_amount) ? ` (+${money(x.amount)} on top of the earlier steps)` : '';
    return `${x.referral_id ? 'Hit' : 'Referrals together hit'} **${money(x.tier)}** weighted wager → ${money(x.tier_amount)} step${extra}${of}`;
  }
  if (x.type === 'lb_cut') return `${Math.round(Number(x.amount) / Number(x.prize) * 100)}% of a **${money(x.prize)}** leaderboard prize (rank #${x.rank})${of}`;
  return `${clip(x.note, 150)}${of}`;
}

function siteButton(page) {
  return site() ? [new ButtonBuilder().setLabel('Open on site').setStyle(ButtonStyle.Link).setURL(`${site()}/${page}`)] : [];
}

function referralCard(r, by = '') {
  const e = new EmbedBuilder().setColor(r.status === 'active' ? '#2ECC71' : r.status === 'void' ? '#E74C3C' : '#F1C40F')
    .setTitle(`🤝 Referral #${r.id}`)
    .addFields(
      { name: 'Referrer', value: who(r.referrer_id, r.referrer_name), inline: true },
      { name: 'Referee', value: who(r.referee_id, r.referee_name), inline: true },
      { name: 'Stake', value: `\`${clip(r.stake, 40)}\``, inline: true },
      { name: 'Status', value: `${STATUS[r.status] ?? r.status}${r.status === 'void' && r.void_reason ? `\n${clip(r.void_reason, 200)}` : ''}${r.status === 'active' && r.verified_by ? ` by ${clip(r.verified_by, 40)}` : ''}`, inline: true },
      { name: 'Counts from', value: t(r.since, 'D'), inline: true },
      { name: 'Registered', value: `${t(r.created_at, 'R')} by ${clip(r.created_by, 40) || '?'}${r.source === 'discord' ? ' (Discord)' : ' (website)'}`, inline: true },
    );
  if (r.note) e.addFields({ name: 'Note', value: clip(r.note, 500) });
  if (by) e.setFooter({ text: `Last change by ${by}` });
  const b = (action, label, style, emoji) => new ButtonBuilder().setCustomId(`rf:${action}:${r.id}`).setLabel(label).setStyle(style).setEmoji(emoji);
  const row = new ActionRowBuilder();
  if (r.status === 'pending') row.addComponents(b('verify', 'Verified by Stake', ButtonStyle.Success, '✅'));
  if (r.status !== 'void') row.addComponents(b('void', 'Void', ButtonStyle.Danger, '🚫'));
  else row.addComponents(b('restore', 'Restore', ButtonStyle.Secondary, '↩️'));
  row.addComponents(...siteButton('admin_referrals.php'));
  return { embeds: [e], components: [row], allowedMentions: { parse: [] } };
}

function rewardCard(d, by = '') {
  const x = d.reward;
  const e = new EmbedBuilder().setColor(x.status === 'paid' ? '#2ECC71' : x.status === 'void' ? '#95A5A6' : '#F1C40F')
    .setTitle(`💸 Referral reward #${x.id} — ${money(x.amount)}`)
    .setDescription(rewardWhat(x, d.referee))
    .addFields(
      { name: 'Referrer', value: who(x.referrer_id, x.referrer_name), inline: true },
      { name: 'Season', value: clip(x.season_label, 60) || '—', inline: true },
      { name: 'Status', value: RW_STATUS[x.status] ?? x.status, inline: true },
    );
  if (x.status === 'pending') e.addFields({ name: 'Payout wallet', value: d.wallet ? '✅ set on the website (see Open on site)' : '⚠️ not set on the website: ask the referrer for one', inline: false });
  if (x.status === 'paid') e.addFields({ name: 'Paid', value: `${t(x.paid_at)} by ${clip(x.paid_by, 40)}${x.pay_ref ? `\n\`${clip(x.pay_ref, 180)}\`` : ''}` });
  if (x.status === 'void' && x.void_reason) e.addFields({ name: 'Reason', value: clip(x.void_reason, 300) });
  if (by) e.setFooter({ text: `Last change by ${by}` });
  const row = new ActionRowBuilder();
  if (x.status === 'pending') {
    row.addComponents(
      new ButtonBuilder().setCustomId(`rf:pay:${x.id}`).setLabel('Mark paid').setStyle(ButtonStyle.Success).setEmoji('✅'),
      new ButtonBuilder().setCustomId(`rf:rvoid:${x.id}`).setLabel('Void').setStyle(ButtonStyle.Danger).setEmoji('🚫'));
  }
  row.addComponents(...siteButton('admin_referrals.php'));
  return { embeds: [e], components: row.components.length ? [row] : [], allowedMentions: { parse: [] } };
}

// ───────────── cards in the staff channel ─────────────
const cardRow = key => db.prepare('SELECT * FROM ref_cards WHERE key = ?').get(key);
const saveCard = (key, channelId, messageId, status) => db.prepare(`INSERT INTO ref_cards (key, channel_id, message_id, status) VALUES (?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id, status = excluded.status`).run(key, channelId, messageId, status);

/** Edits the card if it still exists, otherwise posts it in the staff channel. Always remembers the status (also without a channel). */
async function upsertCard(key, payload, status) {
  const row = cardRow(key);
  if (row?.message_id) {
    const ch = await clientRef.channels.fetch(row.channel_id).catch(() => null);
    const msg = ch ? await ch.messages.fetch(row.message_id).catch(() => null) : null;
    if (msg) { await msg.edit(payload); saveCard(key, row.channel_id, row.message_id, status); return; }
  }
  const id = cfg().referral_staff_channel;
  const ch = id ? await clientRef.channels.fetch(id).catch(() => null) : null;
  if (!ch) {
    if (id) warn(`I can't see the referral staff channel ${id}.`);
    saveCard(key, null, null, status);
    return;
  }
  const msg = await ch.send(payload);
  saveCard(key, ch.id, msg.id, status);
}

async function dm(userId, content) {
  if (!userId) return;
  try { const u = await clientRef.users.fetch(String(userId)); await u.send({ content: clip(content, 1900) }); }
  catch { /* DMs closed or not in a shared server: nothing to do */ }
}

async function shoutOut(x) {
  if (x.type === 'manual') return;
  const id = cfg().referral_channel;
  const ch = id ? await clientRef.channels.fetch(id).catch(() => null) : null;
  if (!ch) return;
  const text = x.type === 'lb_cut'
    ? `🏆 <@${x.referrer_id}> earns **${money(x.amount)}**: one of their referrals finished **#${x.rank}** on the ${clip(x.season_label, 60)} leaderboard.`
    : `🎉 <@${x.referrer_id}> just earned **${money(x.amount)}**! ${x.referral_id ? 'One of their referrals' : 'Their referrals together'} hit the **${money(x.tier)}** weighted wager milestone this month.`;
  await ch.send({ content: `${text}\nBring your friends too: \`/referral ladder\``, allowedMentions: { users: [String(x.referrer_id)] } }).catch(e => warn('shout-out failed: ' + e.message));
}

// ───────────── events from the site ─────────────
async function onEvent(client, ev) {
  clientRef = client;
  const d = ev.data || {};
  if (ev.type === 'ref.referral') {
    const key = `ref:${d.referral.id}`;
    if (d.op === 'deleted') {
      const row = cardRow(key);
      if (row?.message_id) {
        const ch = await client.channels.fetch(row.channel_id).catch(() => null);
        const msg = ch ? await ch.messages.fetch(row.message_id).catch(() => null) : null;
        if (msg) await msg.delete().catch(() => {});
      }
      db.prepare('DELETE FROM ref_cards WHERE key = ?').run(key);
      return;
    }
    return upsertCard(key, referralCard(d.referral, d.by), d.referral.status);
  }

  if (ev.type === 'ref.reward' || ev.type === 'ref.reward_state') {
    const x = d.reward;
    const key = `rw:${x.id}`;
    const before = cardRow(key);
    await upsertCard(key, rewardCard(d, d.by), x.status);
    if (ev.type === 'ref.reward' && !before) {          // a new reward (not a retry of one we already announced)
      await shoutOut(x);
      await dm(x.referrer_id, `💸 You earned a referral reward: **${money(x.amount)}**\n${rewardWhat(x, d.referee)} (${x.season_label}).\n`
        + `${d.wallet ? 'It will be sent to the payout wallet on your website account.' : '⚠️ You have no payout wallet on the website yet: add one under My Account so staff can pay you.'}\nSee everything with \`/referral me\`.`);
    }
    if (x.status === 'paid' && before?.status !== 'paid') {
      await dm(x.referrer_id, `✅ Your referral reward #${x.id} (**${money(x.amount)}**) has been paid.${x.pay_ref ? `\nReference: \`${clip(x.pay_ref, 180)}\`` : ''}`);
    }
  }
}

module.exports = { onEvent, rewardWhat, money, clip, STATUS, RW_STATUS };
