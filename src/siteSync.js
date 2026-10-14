/**
 * siteSync.js — copies every payout record the bot knows about to the website, old ones included, so the site can list them
 * (To pay / Lossbacks tabs) and add the paid ones to the Payout ledger.
 *
 *   claim forms (giveaway / bonus / milestone)   <- table `claims`
 *   manual rewards tracker (/rewards)            <- table `rewards` (the ones NOT created by a claim form: no double counting)
 *   weekly lossback submissions                  <- `list_entries` of lists with kind 'lossback'
 *
 * Runs shortly after start and then every minute. Only records that changed since the last run are sent (hash per record),
 * and sending a record twice is harmless, so a redeploy or a wiped bot database never loses or duplicates anything on the site.
 * The site never deletes records: history stays even if something is removed in Discord.
 */
const crypto = require('crypto');
const { db } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS site_sync (key TEXT PRIMARY KEY, hash TEXT, paid_seen_at INTEGER, paid_approx INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS site_user_names (user_id TEXT PRIMARY KEY, name TEXT, at INTEGER);
`);

const EVERY_MS = Math.max(15_000, Number(process.env.SITE_SYNC_MS) || 60_000);
const BATCH = 100;
const sec = ms => (ms ? Math.floor(Number(ms) / 1000) : null);
const state = { last: 0, sent: 0, error: null, total: 0, running: false };
let timer = null;

const nameOf = id => db.prepare('SELECT name FROM site_user_names WHERE user_id = ?').get(String(id ?? ''))?.name || '';

/** Looks up Discord usernames for the people in the records (a few per run, remembered in the database). */
async function resolveNames(client, ids) {
  const need = [...new Set(ids.filter(Boolean).map(String))].filter(id => {
    const row = db.prepare('SELECT at FROM site_user_names WHERE user_id = ?').get(id);
    return !row || (!db.prepare('SELECT name FROM site_user_names WHERE user_id = ?').get(id).name && Date.now() - row.at > 86_400_000);
  }).slice(0, 25);
  for (const id of need) {
    let name = client.users?.cache?.get(id)?.username || '';
    if (!name) { const u = await client.users.fetch(id).catch(() => null); name = u?.username || ''; }
    db.prepare('INSERT OR REPLACE INTO site_user_names (user_id, name, at) VALUES (?, ?, ?)').run(id, name, Date.now());
  }
}

const KIND = { giveaway: 'giveaway', bonus: 'bonus', milestone: 'milestone' };

/** Every record, in the shape api_bridge.php expects. */
function build() {
  const out = [];
  const claims = db.prepare('SELECT c.*, r.created_at AS r_created FROM claims c LEFT JOIN rewards r ON r.id = c.reward_id').all();
  const linked = new Set(claims.map(c => c.reward_id).filter(Boolean));

  for (const c of claims) {
    const dq = Boolean(c.disqualified);
    out.push({
      key: `claim:${c.id}`, kind: KIND[c.category] ?? 'other', status: dq ? 'cancelled' : c.paid ? 'paid' : 'pending',
      user_id: c.user_id, discord_name: nameOf(c.user_id), user: c.stake_user, stake: c.stake_user,
      what: c.what, amount_text: c.amount, address: c.address, proof: c.screenshot,
      created_at: sec(c.r_created), paid_at: c.paid ? sec(c.paid_at) : null, paid_by: c.paid ? (nameOf(c.paid_by) || c.paid_by) : '',
      note: dq ? `Disqualified${c.dq_reason ? ': ' + c.dq_reason : ''}` : '',
    });
  }

  for (const r of db.prepare('SELECT * FROM rewards').all()) {
    if (linked.has(r.id)) continue;
    const st = String(r.status || 'Pending').toLowerCase();
    out.push({
      key: `reward:${r.id}`, kind: 'other', status: st === 'paid' ? 'paid' : st === 'cancelled' ? 'cancelled' : 'pending',
      user: r.username, what: r.label, amount_text: r.reward, note: r.notes,
      created_at: sec(r.created_at), paid_at: st === 'paid' ? sec(r.updated_at) : null, paid_by: '',
    });
  }

  const entries = db.prepare(`SELECT e.*, l.title AS l_title, l.created_at AS l_created FROM list_entries e JOIN lists l ON l.id = e.list_id WHERE l.kind = 'lossback'`).all();
  for (const e of entries) {
    const key = `lossback:${e.id}`;
    const paid = Boolean(e.paid);
    const row = db.prepare('SELECT * FROM site_sync WHERE key = ?').get(key);
    let paidAt = null, approx = 0;
    if (paid) {
      if (row?.paid_seen_at) { paidAt = sec(row.paid_seen_at); approx = row.paid_approx ? 1 : 0; }
      else if (row) { paidAt = Math.floor(Date.now() / 1000); }                       // we watched it go from waiting to paid
      else { paidAt = sec(e.l_created); approx = 1; }                                  // old entry, already paid before we ever saw it: date = when its list was made
    }
    out.push({
      key, kind: 'lossback', status: paid ? 'paid' : 'pending', user_id: e.user_id, discord_name: nameOf(e.user_id), user: e.name,
      what: e.l_title, group: e.l_title, amount_text: e.value2, address: e.value1,
      created_at: sec(e.l_created), paid_at: paidAt, paid_approx: Boolean(approx),
    });
  }
  return out;
}

const hashOf = r => crypto.createHash('sha1').update(JSON.stringify(r)).digest('hex');

async function syncOnce(client, api) {
  if (state.running) return;
  state.running = true;
  try {
    const pre = build();
    await resolveNames(client, pre.flatMap(r => [r.user_id]).concat(db.prepare('SELECT paid_by FROM claims WHERE paid = 1').all().map(x => x.paid_by)));
    const recs = build();
    state.total = recs.length;
    const todo = recs.filter(r => db.prepare('SELECT hash FROM site_sync WHERE key = ?').get(r.key)?.hash !== hashOf(r));
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      const j = await api('POST', { action: 'records_upsert', records: batch });
      if (!j.ok) throw new Error(j.error || 'the site refused the records');
      const save = db.prepare(`INSERT INTO site_sync (key, hash, paid_seen_at, paid_approx) VALUES (@key, @hash, @seen, @approx)
                               ON CONFLICT(key) DO UPDATE SET hash = @hash, paid_seen_at = @seen, paid_approx = @approx`);
      db.transaction(() => { for (const r of batch) save.run({ key: r.key, hash: hashOf(r), seen: r.status === 'paid' && r.paid_at ? r.paid_at * 1000 : null, approx: r.paid_approx ? 1 : 0 }); })();
      state.sent += batch.length;
      if (i + BATCH < todo.length) await new Promise(r => setTimeout(r, 300));
    }
    state.last = Date.now(); state.error = null;
  } catch (e) { state.error = e.message; console.warn('[site sync]', e.message); }
  finally { state.running = false; }
}

function start(client, api) {
  if (timer) return;
  setTimeout(() => syncOnce(client, api), 15_000);
  timer = setInterval(() => syncOnce(client, api), EVERY_MS);
}

module.exports = { start, syncOnce, build, state };
