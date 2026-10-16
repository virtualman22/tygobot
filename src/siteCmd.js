/**
 * siteCmd.js — applies what staff do on the website's payout pages to the bot's own data, so both sides always agree.
 *
 * The site sends "record.cmd" events (through the same bridge as tickets and GTB):
 *   pay      mark a claim / reward / lossback as paid        (claims: card updated, member told, ticket renamed — same as the button)
 *   dq       disqualify                                        (claims: card + member told; rewards: Cancelled; lossbacks: 🚫 and the member can submit again)
 *   delete   remove it from the bot (claim row + rewards entry + card message, or the lossback list entry)
 *   edit     amount / category / source / note
 *   add      register one by hand for a member (claim + card, lossback list entry, or a rewards-tracker entry)
 *
 * Afterwards the record is sent back to the site straight away (siteSync), which clears the "syncing" mark there.
 * A command that cannot be applied (e.g. no lossback list yet) is reported to the site instead of being retried forever.
 */
const { db, getSettings } = require('./db');
const { logToGuild } = require('./utils');

db.exec(`CREATE TABLE IF NOT EXISTS site_meta (key TEXT PRIMARY KEY, tmp TEXT, origin TEXT, note TEXT);`);

const ORIGINS = new Set(['', 'discord', 'kick', 'x', 'other']);
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const parseKey = k => { const m = /^(claim|reward|lossback):(\d{1,12})$/.exec(String(k)); return m ? { type: m[1], id: Number(m[2]) } : null; };
const gid = client => process.env.GUILD_ID || client.guilds.cache.first()?.id || null;

/** manual:<hex> (the site's placeholder) -> the real key the bot gave it */
function resolveKey(key) {
  if (!String(key).startsWith('manual:')) return key;
  return db.prepare('SELECT key FROM site_meta WHERE tmp = ?').get(key)?.key ?? null;
}

function setMeta(key, { tmp, origin, note }) {
  const cur = db.prepare('SELECT * FROM site_meta WHERE key = ?').get(key) ?? { key, tmp: null, origin: '', note: '' };
  const next = { key, tmp: tmp ?? cur.tmp, origin: origin ?? cur.origin, note: note ?? cur.note };
  if (!next.tmp && !next.origin && !next.note) db.prepare('DELETE FROM site_meta WHERE key = ?').run(key);
  else db.prepare('INSERT INTO site_meta (key, tmp, origin, note) VALUES (@key, @tmp, @origin, @note) ON CONFLICT(key) DO UPDATE SET tmp = @tmp, origin = @origin, note = @note').run(next);
}
const metaOf = key => db.prepare('SELECT * FROM site_meta WHERE key = ?').get(key) ?? null;

async function pay(client, p, by) {
  const { payClaim } = require('./commands/ticket');
  const { markPaid } = require('./commands/rewards');
  if (p.type === 'claim') {
    const c = db.prepare('SELECT * FROM claims WHERE id = ?').get(p.id);
    if (!c) throw new Error('That claim no longer exists in the bot.');
    if (c.disqualified) throw new Error('That claim was disqualified in Discord.');
    if (!c.paid) await payClaim(client, c, by);
  } else if (p.type === 'reward') {
    const r = db.prepare('SELECT * FROM rewards WHERE id = ?').get(p.id);
    if (!r) throw new Error('That rewards entry no longer exists in the bot.');
    if (r.status !== 'Paid') await markPaid(client, r, by);
  } else {
    const e = db.prepare('SELECT * FROM list_entries WHERE id = ?').get(p.id);
    if (!e) throw new Error('That lossback entry no longer exists in the bot.');
    if (!e.paid) {
      db.prepare('UPDATE list_entries SET paid = 1 WHERE id = ?').run(e.id);
      await logToGuild(client, gid(client), `✅ <@${by}> marked lossback **${e.name}** as paid (from the website).`);
      await require('./commands/list').refreshMessage(client, e.list_id);
    }
  }
}

async function dq(client, p, by, reason) {
  const { dqClaim } = require('./commands/ticket');
  if (p.type === 'claim') {
    const c = db.prepare('SELECT * FROM claims WHERE id = ?').get(p.id);
    if (!c) throw new Error('That claim no longer exists in the bot.');
    if (c.paid) throw new Error('That claim is already paid in the bot.');
    if (!c.disqualified) await dqClaim(client, c, by, reason);
  } else if (p.type === 'reward') {
    const r = db.prepare('SELECT * FROM rewards WHERE id = ?').get(p.id);
    if (!r) throw new Error('That rewards entry no longer exists in the bot.');
    db.prepare("UPDATE rewards SET status = 'Cancelled', updated_at = ? WHERE id = ?").run(Date.now(), r.id);
    await logToGuild(client, r.guild_id, `🚫 <@${by}> set reward #${r.id} to **Cancelled** (from the website)${reason ? `: ${reason}` : ''}.`);
  } else {
    const e = db.prepare('SELECT * FROM list_entries WHERE id = ?').get(p.id);
    if (!e) throw new Error('That lossback entry no longer exists in the bot.');
    db.prepare('UPDATE list_entries SET dq = 1, dq_reason = ? WHERE id = ?').run(reason || null, e.id);
    await logToGuild(client, gid(client), `🚫 <@${by}> disqualified lossback **${e.name}** (from the website)${reason ? `: ${reason}` : ''}.`);
    await require('./commands/list').refreshMessage(client, e.list_id);
  }
}

async function del(client, p, by) {
  if (p.type === 'claim') {
    const c = db.prepare('SELECT * FROM claims WHERE id = ?').get(p.id);
    if (!c) return;
    if (c.message_id && c.card_channel_id) {
      try { const ch = await client.channels.fetch(c.card_channel_id); const m = await ch.messages.fetch(c.message_id); await m.delete(); } catch { /* already gone */ }
    }
    db.transaction(() => { db.prepare('DELETE FROM claims WHERE id = ?').run(c.id); if (c.reward_id) db.prepare('DELETE FROM rewards WHERE id = ?').run(c.reward_id); })();
    await logToGuild(client, c.guild_id, `🗑️ <@${by}> deleted ${c.stake_user}'s **${c.amount}** claim (from the website).`);
  } else if (p.type === 'reward') {
    const r = db.prepare('SELECT * FROM rewards WHERE id = ?').get(p.id);
    if (!r) return;
    db.prepare('DELETE FROM rewards WHERE id = ?').run(r.id);
    await logToGuild(client, r.guild_id, `🗑️ <@${by}> deleted reward #${r.id} (${r.username}, ${r.reward}) from the website.`);
  } else {
    const e = db.prepare('SELECT * FROM list_entries WHERE id = ?').get(p.id);
    if (!e) return;
    db.prepare('DELETE FROM list_entries WHERE id = ?').run(e.id);
    await logToGuild(client, gid(client), `🗑️ <@${by}> deleted lossback entry **${e.name}** (from the website).`);
    await require('./commands/list').refreshMessage(client, e.list_id);
  }
  db.prepare('DELETE FROM site_meta WHERE key = ?').run(`${p.type}:${p.id}`);
  db.prepare('DELETE FROM site_sync WHERE key = ?').run(`${p.type}:${p.id}`);
}

async function edit(client, p, d) {
  const { refreshCard, claimNotes, CATEGORIES } = require('./commands/ticket');
  const amount = clean(d.amount_text, 100);
  const kind = String(d.kind || '');
  if (p.type === 'claim') {
    const c = db.prepare('SELECT * FROM claims WHERE id = ?').get(p.id);
    if (!c) throw new Error('That claim no longer exists in the bot.');
    const cat = CATEGORIES[kind]?.claim ? kind : c.category;       // lossback / other can't be a claim type: those stay site-side
    db.prepare('UPDATE claims SET amount = ?, category = ? WHERE id = ?').run(amount || c.amount, cat, c.id);
    const fresh = db.prepare('SELECT * FROM claims WHERE id = ?').get(c.id);
    if (c.reward_id) db.prepare('UPDATE rewards SET label = ?, reward = ?, notes = ?, updated_at = ? WHERE id = ?')
      .run(CATEGORIES[cat].label, `${fresh.what} (${fresh.amount})`.slice(0, 200), claimNotes(fresh), Date.now(), c.reward_id);
    await refreshCard(client, fresh);
  } else if (p.type === 'reward') {
    if (amount) db.prepare('UPDATE rewards SET reward = ?, updated_at = ? WHERE id = ?').run(amount, Date.now(), p.id);
  } else {
    const e = db.prepare('SELECT * FROM list_entries WHERE id = ?').get(p.id);
    if (!e) throw new Error('That lossback entry no longer exists in the bot.');
    if (amount) { db.prepare('UPDATE list_entries SET value2 = ? WHERE id = ?').run(amount, e.id); await require('./commands/list').refreshMessage(client, e.list_id); }
  }
  const origin = ORIGINS.has(String(d.origin ?? '')) ? String(d.origin ?? '') : '';
  setMeta(`${p.type}:${p.id}`, { origin, note: clean(d.note, 200) });
}

async function add(client, d, by) {
  const g = gid(client);
  if (!g) throw new Error('The bot is not in a server yet.');
  const kind = String(d.kind);
  const uid = String(d.user_id || '').replace(/\D/g, '');
  const name = clean(d.user, 80) || uid;
  const what = clean(d.what, 200);
  const amount = clean(d.amount_text, 100);
  const address = clean(d.address, 120);
  let key;
  if (['giveaway', 'bonus', 'milestone'].includes(kind)) {
    const { createClaim } = require('./commands/ticket');
    const { id } = await createClaim(client, { guildId: g, userId: uid, cat: kind, what, amount, address, stake: name });
    key = `claim:${id}`;
  } else if (kind === 'lossback') {
    const l = getSettings(g).lossback_list_id;
    const active = l && db.prepare('SELECT * FROM lists WHERE id = ?').get(l);
    const group = clean(d.group, 100);
    // the list picked on the website (newest one with that title); a new name starts a new list next to the active one
    let list = group ? db.prepare(`SELECT * FROM lists WHERE guild_id = ? AND kind = 'lossback' AND title = ? ORDER BY id DESC LIMIT 1`).get(g, group) : active;
    if (!list && group) {
      if (!active) throw new Error(`There is no lossback list called "${group}" and no active list to put a new one next to (/lossback).`);
      const { createList, getList } = require('./commands/list');
      const ch = await client.channels.fetch(active.channel_id).catch(() => null);
      if (!ch) throw new Error('I could not open the channel of the active lossback list to start a new one.');
      const id = await createList(ch, { guildId: g, userId: by || null, kind: 'lossback', title: group,
        description: active.description, col1: active.col1, col2: active.col2, col3: active.col3 });
      list = getList(id);
      await logToGuild(client, g, `💸 <@${by}> started lossback list **${group}** from the website (the active list did not change).`);
    }
    if (!list) throw new Error('There is no active lossback list in Discord yet (/lossback), so I could not add it there.');
    const res = db.prepare('INSERT INTO list_entries (list_id, name, value1, value2, user_id) VALUES (?, ?, ?, ?, ?)').run(list.id, name, address || null, amount, uid || null);
    key = `lossback:${Number(res.lastInsertRowid)}`;
    await require('./commands/list').refreshMessage(client, list.id);
  } else {
    const now = Date.now();
    const res = db.prepare(`INSERT INTO rewards (guild_id, label, username, reward, notes, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'Pending', ?, ?, ?)`)
      .run(g, what || 'Other', name, amount, clean(d.note, 200) || null, by, now, now);
    key = `reward:${Number(res.lastInsertRowid)}`;
  }
  setMeta(key, { tmp: String(d.key), origin: ORIGINS.has(String(d.origin ?? '')) ? String(d.origin ?? '') : '', note: clean(d.note, 200) });
  await logToGuild(client, g, `➕ <@${by}> registered a **${kind}** payout for ${name} (${amount}) from the website.`);
  return key;
}

/** One event. Never throws: problems are reported to the site so the person at the keyboard sees them. Returns the keys to re-send. */
async function handle(client, ev, api) {
  const d = ev.data || {};
  const by = String(d.by || '');
  let key = String(d.key || '');
  try {
    if (d.op === 'add') key = await add(client, d, by);
    else {
      const real = resolveKey(key);
      const p = real && parseKey(real);
      if (!p) { if (d.op === 'delete') return []; throw new Error('I could not find that record in the bot (it may still be waiting to be created).'); }
      key = real;
      if (d.op === 'pay') await pay(client, p, by);
      else if (d.op === 'dq') await dq(client, p, by, clean(d.reason, 200));
      else if (d.op === 'delete') await del(client, p, by);
      else if (d.op === 'edit') await edit(client, p, d);
    }
    db.prepare('DELETE FROM site_sync WHERE key = ?').run(key);       // forces the record to be re-sent even if nothing visible changed
    return [key];
  } catch (e) {
    console.warn(`[site cmd] ${d.op} ${d.key}:`, e.message);
    try { await api('POST', { action: 'cmd_result', key: String(d.key || ''), error: e.message.slice(0, 200) }); } catch { /* the site will keep showing "syncing" */ }
    const real = resolveKey(String(d.key || ''));
    if (real && parseKey(real)) { db.prepare('DELETE FROM site_sync WHERE key = ?').run(real); return [real]; }   // re-send the bot's real state so the site stops showing the change that failed
    return [];
  }
}

module.exports = { handle, metaOf };
