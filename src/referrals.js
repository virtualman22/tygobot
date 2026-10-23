/**
 * referrals.js — the referral program's Discord side. The website keeps the data (referrals_lib.php); the bot never stores
 * referrals itself, so both always agree. This file handles the site's ref.* events (src/bridge.js):
 *   ref.referral                  -> a staff card per referral (Verified by Stake / Void / Restore), kept up to date
 *   ref.reward / ref.reward_state -> ONE staff card per referrer with all their rewards: what is still to pay (each reward with what it
 *   ref.paid_all                     is for), recently paid, totals, and Mark all paid / Mark one paid / Void one
 *   New rewards also bump that card to the bottom of the channel, post one shout-out in the public referral channel and send the
 *   referrer one DM. Rewards that arrive together (e.g. several ladder steps at once) are bundled into one bump / shout-out / DM.
 *   When rewards are paid, the referrer gets a DM listing them and every referee they came from gets one too (notifyPaid).
 * Channels: /setup set referral_channel:#public referral_staff_channel:#staff (both optional; without them only the DMs are sent).
 * The /referral command (commands/referral.js) and the buttons talk to the site through bridge.api().
 */
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { db, getSettings } = require('./db');
const { payoutReminder } = require('./sites');

db.exec(`CREATE TABLE IF NOT EXISTS ref_cards (key TEXT PRIMARY KEY, channel_id TEXT, message_id TEXT, status TEXT);
CREATE TABLE IF NOT EXISTS ref_seen (reward_id INTEGER PRIMARY KEY, status TEXT);`);

const BUNDLE_MS = 5000;                 // rewards of one person arriving within this window share one bump / shout-out / DM
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
    const extra = Number(x.amount) < Number(x.tier_amount) ? ` (top-up of ${money(x.amount)})` : '';
    return `${x.referral_id ? 'Hit' : 'Referrals together hit'} **${money(x.tier)}** weighted wager → ${money(x.tier_amount)} step${extra}${of}`;
  }
  if (x.type === 'lb_cut') return `${Math.round(Number(x.amount) / Number(x.prize) * 100)}% of a **${money(x.prize)}** leaderboard prize (rank #${x.rank})${of}`;
  return `${clip(x.note, 150)}${of}`;
}
const plain = s => String(s).replace(/\*\*/g, '');

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

/** Lines -> embed fields of at most 1024 characters each. */
function fieldsOf(name, lines, max = 4) {
  const out = []; let buf = [];
  const flush = () => { if (buf.length) out.push({ name: out.length ? `${name} (cont.)` : name, value: buf.join('\n') }); buf = []; };
  for (const l of lines) {
    if (buf.join('\n').length + l.length + 1 > 1024) flush();
    if (out.length >= max) break;
    buf.push(l);
  }
  if (out.length < max) flush();
  return out;
}

/** The one card per referrer: everything still to pay with what each reward is for, recently paid, totals, and the pay buttons. */
function personCard(p, by = '') {
  const pend = p.pending ?? [];
  const n = p.pending_count ?? pend.length;
  const e = new EmbedBuilder().setColor(n ? '#F1C40F' : '#2ECC71')
    .setTitle(`💸 Referral rewards — ${clip(p.name || p.id, 60)}`)
    .setDescription(`<@${p.id}> · ${p.active}/${p.referrals} referral${p.referrals === 1 ? '' : 's'} active\n`
      + (n ? `## To pay: ${money(p.totals.pending)}\n${n} reward${n === 1 ? '' : 's'} waiting` : '## ✅ Nothing to pay')
      + ` · paid so far **${money(p.totals.paid)}**`);
  if (pend.length) {
    const lines = pend.map(x => `\`#${x.id}\` **${money(x.amount)}** · ${rewardWhat(x, x.referee)} · *${clip(x.season_label, 30)}*`);
    if (n > pend.length) lines.push(`…and ${n - pend.length} more on the website`);
    e.addFields(...fieldsOf('⏳ Waiting to be paid', lines));
    e.addFields({ name: 'Payout wallet', value: p.wallet ? '✅ set on the website (Open on site to copy it)' : '⚠️ not set on the website: ask them to add one under My Account' });
  }
  if (p.recent_paid?.length) {
    e.addFields(...fieldsOf('✅ Recently paid', p.recent_paid.map(x => `\`#${x.id}\` ${money(x.amount)} · ${plain(rewardWhat(x, x.referee))} · ${t(x.paid_at, 'd')}${x.paid_by ? ` by ${clip(x.paid_by, 30)}` : ''}${x.pay_ref ? ` · \`${clip(x.pay_ref, 40)}\`` : ''}`), 1));
  }
  if (by) e.setFooter({ text: `Last change by ${by}` });

  const rows = [];
  const top = new ActionRowBuilder();
  if (pend.length) {
    const upto = Math.max(...pend.map(x => x.id));
    top.addComponents(new ButtonBuilder().setCustomId(`rf:payall:${p.id}:${upto}`).setLabel(`Mark all paid (${money(pend.reduce((a, x) => a + Number(x.amount), 0))})`).setStyle(ButtonStyle.Success).setEmoji('✅'));
  }
  top.addComponents(...siteButton('admin_referrals.php'));
  if (top.components.length) rows.push(top);
  if (pend.length) {
    const opts = pend.slice(0, 25).map(x => {
      const o = { label: clip(`#${x.id} · ${money(x.amount)} · ${plain(rewardWhat(x))}`, 100), value: String(x.id) };
      const desc = [x.referee, x.season_label].filter(Boolean).join(' · ');
      if (desc) o.description = clip(desc, 100);
      return o;
    });
    rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`rfsel:pay:${p.id}`).setPlaceholder('✅ Mark one reward paid…').addOptions(opts)));
    rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`rfsel:void:${p.id}`).setPlaceholder('🚫 Void one reward…').addOptions(opts)));
  }
  return { embeds: [e], components: rows, allowedMentions: { parse: [] } };
}

// ───────────── cards in the staff channel ─────────────
const cardRow = key => db.prepare('SELECT * FROM ref_cards WHERE key = ?').get(key);
const saveCard = (key, channelId, messageId, status) => db.prepare(`INSERT INTO ref_cards (key, channel_id, message_id, status) VALUES (?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id, status = excluded.status`).run(key, channelId, messageId, status);

async function messageOf(row) {
  if (!row?.message_id) return null;
  const ch = await clientRef.channels.fetch(row.channel_id).catch(() => null);
  return ch ? ch.messages.fetch(row.message_id).catch(() => null) : null;
}

/** Edits the card if it still exists, otherwise posts it in the staff channel. $bump: delete it and post it again at the bottom. */
async function upsertCard(key, payload, status, bump = false) {
  const row = cardRow(key);
  const old = await messageOf(row);
  if (old && !bump) { await old.edit(payload); saveCard(key, row.channel_id, row.message_id, status); return; }
  const id = cfg().referral_staff_channel;
  const ch = id ? await clientRef.channels.fetch(id).catch(() => null) : null;
  if (!ch) {
    if (id) warn(`I can't see the referral staff channel ${id}.`);
    if (old) await old.edit(payload).catch(() => {});
    if (!row) saveCard(key, null, null, status);
    return;
  }
  const msg = await ch.send(payload);
  saveCard(key, ch.id, msg.id, status);
  if (old) await old.delete().catch(() => {});
}

/** Cards of the old one-card-per-reward layout are folded into the person card. */
async function dropLegacy(ids) {
  for (const id of ids) {
    const row = cardRow(`rw:${id}`);
    if (!row) continue;
    const msg = await messageOf(row);
    if (msg) await msg.delete().catch(() => {});
    db.prepare('DELETE FROM ref_cards WHERE key = ?').run(`rw:${id}`);
  }
}

// one person's card is only ever changed by one task at a time (events and the bundled bump can overlap)
const locks = new Map();
function serial(key, fn) {
  const p = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  locks.set(key, p);
  p.finally(() => { if (locks.get(key) === p) locks.delete(key); }).catch(() => {});
  return p;
}

const latest = new Map();          // referrer id -> newest person summary from the site
function drawPerson(p, by, bump = false) {
  latest.set(String(p.id), p);
  return serial(`rp:${p.id}`, async () => {
    await upsertCard(`rp:${p.id}`, personCard(latest.get(String(p.id)) ?? p, by), p.pending_count ? 'pending' : 'paid', bump);
    await dropLegacy([...(p.pending ?? []), ...(p.recent_paid ?? [])].map(x => x.id));
  });
}

async function dm(userId, content) {
  if (!userId) return;
  try { const u = await clientRef.users.fetch(String(userId)); await u.send({ content: clip(content, 1900) }); }
  catch { /* DMs closed or not in a shared server: nothing to do */ }
}

// ───────────── new rewards: bundled bump + shout-out + DM ─────────────
const bundles = new Map();         // referrer id -> { rewards, wallet, timer }
function queueNew(d) {
  const id = String(d.reward.referrer_id);
  const b = bundles.get(id) ?? { rewards: [], wallet: d.wallet };
  b.rewards.push({ ...d.reward, referee: d.referee });
  b.wallet = d.wallet;
  clearTimeout(b.timer);
  b.timer = setTimeout(() => flush(id).catch(e => warn('notify failed: ' + e.message)), BUNDLE_MS);
  bundles.set(id, b);
}

async function flush(id) {
  const b = bundles.get(id);
  bundles.delete(id);
  if (!b?.rewards.length) return;
  const p = latest.get(id);
  if (p) await drawPerson(p, '', true).catch(e => warn('card bump failed: ' + e.message));
  const total = b.rewards.reduce((a, x) => a + Number(x.amount), 0);

  const shout = b.rewards.filter(x => x.type !== 'manual');
  const ch = shout.length && cfg().referral_channel ? await clientRef.channels.fetch(cfg().referral_channel).catch(() => null) : null;
  if (ch) {
    const top = shout.filter(x => x.type === 'ladder').sort((a, c) => c.tier - a.tier)[0];
    const cut = shout.find(x => x.type === 'lb_cut');
    const parts = [];
    if (top) parts.push(`${top.referral_id ? 'a referral' : 'their referrals together'} hit the **${money(top.tier)}** weighted wager milestone`);
    if (cut) parts.push(`a referral finished **#${cut.rank}** on the ${clip(cut.season_label, 60)} leaderboard`);
    const amt = shout.reduce((a, x) => a + Number(x.amount), 0);
    await ch.send({ content: `🎉 <@${id}> just earned **${money(amt)}**: ${parts.join(' and ')}!\nBring your friends too: \`/referral ladder\``, allowedMentions: { users: [id] } })
      .catch(e => warn('shout-out failed: ' + e.message));
  }

  const lines = b.rewards.map(x => `• **${money(x.amount)}** · ${rewardWhat(x, x.referee)} (${clip(x.season_label, 40)})`);
  await dm(id, `💸 You earned ${b.rewards.length === 1 ? 'a referral reward' : `${b.rewards.length} referral rewards`}: **${money(total)}**\n${lines.join('\n')}\n`
    + `${b.wallet ? 'It will be sent to the payout wallet on your website account.' : '⚠️ You have no payout wallet on the website yet: add one under My Account so staff can pay you.'}\nSee everything with \`/referral me\`.`);
}

// ───────────── paid: DM the referrer and every referee the rewards came from ─────────────
/** What the referee did to earn their referrer this reward, from the referee's side. */
function youDid(x) {
  if (x.type === 'ladder') return `you reached **${money(x.tier)}** weighted wager${x.season_label ? ` in ${clip(x.season_label, 40)}` : ''}`;
  if (x.type === 'lb_cut') return `you finished **#${x.rank}** on the ${clip(x.season_label, 60) || 'season'} leaderboard`;
  return `of a referral bonus${x.note ? ` (${clip(x.note, 100)})` : ''}`;
}
/** Several ladder steps of one season paid together read as the highest one. */
function becauseOf(xs) {
  const top = new Map(), other = new Set();
  for (const x of xs) {
    if (x.type !== 'ladder') { other.add(youDid(x)); continue; }
    const k = x.season_label || '', cur = top.get(k);
    if (!cur || Number(x.tier) > Number(cur.tier)) top.set(k, x);
  }
  return [...[...top.values()].map(youDid), ...other].join(' and ');
}
/** rewards: the paid rewards, each with referee (name) and referee_id. */
async function notifyPaid(referrerId, referrerName, rewards, ref) {
  if (!rewards.length) return;
  const total = rewards.reduce((a, x) => a + Number(x.amount), 0);
  const lines = rewards.slice(0, 15).map(x => `• \`#${x.id}\` **${money(x.amount)}** · ${rewardWhat(x, x.referee)}`);
  if (rewards.length > 15) lines.push(`…and ${rewards.length - 15} more`);
  await dm(referrerId, `✅ **Referral payout sent: ${money(total)}**\n${lines.join('\n')}`
    + `${ref ? `\nReference: \`${clip(ref, 180)}\`` : ''}\n${payoutReminder('stake')}\nThanks for bringing people in. Track your next rewards with \`/referral me\`.`);

  const byReferee = new Map();
  for (const x of rewards) {
    const id = String(x.referee_id || '');
    if (!id || id === String(referrerId)) continue;              // "all referrals together" / manual rewards have no single referee
    if (!byReferee.has(id)) byReferee.set(id, []);
    byReferee.get(id).push(x);
  }
  const from = `<@${referrerId}>${referrerName ? ` (${clip(referrerName, 40)})` : ''}`;
  for (const [id, xs] of byReferee) {
    const sum = xs.reduce((a, x) => a + Number(x.amount), 0);
    await dm(id, `🎉 **Referral payout!** ${from}, who referred you, was just paid **${money(sum)}** because ${becauseOf(xs)}.\n`
      + 'Want to earn too? Invite your friends and climb the ladder: `/referral ladder`');
  }
}

const seen = id => db.prepare('SELECT status FROM ref_seen WHERE reward_id = ?').get(id)?.status;
const markSeen = (id, status) => db.prepare('INSERT INTO ref_seen (reward_id, status) VALUES (?, ?) ON CONFLICT(reward_id) DO UPDATE SET status = excluded.status').run(id, status);

// ───────────── events from the site ─────────────
async function onEvent(client, ev) {
  clientRef = client;
  const d = ev.data || {};
  if (ev.type === 'ref.referral') {
    const key = `ref:${d.referral.id}`;
    if (d.op === 'deleted') {
      const msg = await messageOf(cardRow(key));
      if (msg) await msg.delete().catch(() => {});
      db.prepare('DELETE FROM ref_cards WHERE key = ?').run(key);
      return;
    }
    return upsertCard(key, referralCard(d.referral, d.by), d.referral.status);
  }

  if (ev.type === 'ref.reward' || ev.type === 'ref.reward_state') {
    const x = d.reward;
    const before = seen(x.id) ?? cardRow(`rw:${x.id}`)?.status;      // (older rewards were remembered by their card)
    if (d.person) await drawPerson(d.person, d.by);
    await dropLegacy([x.id]);
    markSeen(x.id, x.status);
    if (ev.type === 'ref.reward' && !before) queueNew(d);           // a new reward (not a retry of one we already announced)
    if (x.status === 'paid' && before && before !== 'paid') {
      await notifyPaid(x.referrer_id, d.person?.name, [{ ...x, referee: d.referee, referee_id: d.referee_id }], x.pay_ref);
    }
    return;
  }

  if (ev.type === 'ref.paid_all') {
    const fresh = d.ids.filter(id => seen(id) !== 'paid');
    if (d.person) await drawPerson(d.person, d.by);
    await dropLegacy(d.ids);
    for (const id of d.ids) markSeen(id, 'paid');
    const rewards = (d.rewards ?? []).filter(x => fresh.includes(x.id));
    if (rewards.length) await notifyPaid(d.referrer_id, d.person?.name, rewards, d.ref);
    else if (fresh.length) {   // a site version that doesn't send the per-reward list yet: referrer only
      await dm(d.referrer_id, `✅ Your referral rewards have been paid: **${money(d.total)}** (${d.ids.length} reward${d.ids.length === 1 ? '' : 's'}: ${d.ids.map(i => `#${i}`).join(', ')}).`
        + `${d.ref ? `\nReference: \`${clip(d.ref, 180)}\`` : ''}\n${payoutReminder('stake')}`);
    }
  }
}

module.exports = { onEvent, rewardWhat, money, clip, STATUS, RW_STATUS };
