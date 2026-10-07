const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dir = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data');
fs.mkdirSync(dir, { recursive: true });

const db = new Database(path.join(dir, 'bot.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  guild_id TEXT PRIMARY KEY,
  announce_channel TEXT, mod_role TEXT, log_channel TEXT,
  welcome_channel TEXT,
  welcome_message TEXT DEFAULT 'Welcome to {server}, {user}! You are member #{count}.',
  qotd_channel TEXT, qotd_hour INTEGER, last_qotd TEXT,
  trivia_channel TEXT, trivia_hour INTEGER, last_trivia TEXT,
  suggest_channel TEXT,
  starboard_channel TEXT, starboard_threshold INTEGER DEFAULT 3,
  ticket_category TEXT,
  xp_enabled INTEGER DEFAULT 1,
  automod_links INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL, name TEXT NOT NULL,
  title TEXT, introduction TEXT, standings TEXT, participation TEXT, rewards TEXT,
  UNIQUE (guild_id, name)
);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT UNIQUE NOT NULL,
  author_id TEXT, data TEXT, created_at INTEGER
);

CREATE TABLE IF NOT EXISTS scheduled (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, role_id TEXT,
  color TEXT, image TEXT, fields TEXT NOT NULL,
  send_at INTEGER NOT NULL, repeat_mode TEXT DEFAULT 'none', author_id TEXT
);

CREATE TABLE IF NOT EXISTS xp (
  guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
  xp INTEGER DEFAULT 0, last_gain INTEGER DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS trivia_scores (
  guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
  correct INTEGER DEFAULT 0, answered INTEGER DEFAULT 0,
  streak INTEGER DEFAULT 0, best_streak INTEGER DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS trivia_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL, user_id TEXT NOT NULL, points INTEGER NOT NULL, ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS custom_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL, question TEXT NOT NULL, correct TEXT NOT NULL,
  wrong TEXT NOT NULL, category TEXT, difficulty TEXT
);

CREATE TABLE IF NOT EXISTS qotd_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL, question TEXT NOT NULL, used INTEGER DEFAULT 0, author_id TEXT
);

CREATE TABLE IF NOT EXISTS polls (
  message_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
  question TEXT NOT NULL, options TEXT NOT NULL, ends_at INTEGER, closed INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS poll_votes (
  message_id TEXT NOT NULL, user_id TEXT NOT NULL, option_idx INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS giveaways (
  message_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
  prize TEXT NOT NULL, winners INTEGER DEFAULT 1, ends_at INTEGER NOT NULL,
  host_id TEXT, ended INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS giveaway_entries (
  message_id TEXT NOT NULL, user_id TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT NOT NULL,
  user_id TEXT NOT NULL, content TEXT NOT NULL, status TEXT DEFAULT 'Pending'
);

CREATE TABLE IF NOT EXISTS starboard (
  message_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, star_message_id TEXT NOT NULL
);

-- Mod rewards tracker
CREATE TABLE IF NOT EXISTS rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  label TEXT NOT NULL,
  username TEXT NOT NULL,
  reward TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'Pending',
  created_by TEXT, created_at INTEGER, updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_rewards_guild ON rewards (guild_id, label);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS ticket_claims (
  channel_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, category TEXT,
  what TEXT, amount TEXT, address TEXT, stake_user TEXT,
  reward_id INTEGER, message_id TEXT,
  paid INTEGER DEFAULT 0, paid_by TEXT, paid_at INTEGER
);
`);

// Claims: one row per submitted claim form (tickets or any chat)
db.exec(`
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, user_id TEXT NOT NULL, category TEXT NOT NULL,
  what TEXT, amount TEXT, address TEXT, stake_user TEXT, screenshot TEXT,
  reward_id INTEGER, card_channel_id TEXT, message_id TEXT,
  paid INTEGER DEFAULT 0, paid_by TEXT, paid_at INTEGER
);
`);
// Carry over claims saved by the previous version (one-time, only if the new table is empty)
if (!db.prepare('SELECT 1 FROM claims LIMIT 1').get()) {
  db.exec(`INSERT INTO claims (guild_id, channel_id, user_id, category, what, amount, address, stake_user,
                               reward_id, card_channel_id, message_id, paid, paid_by, paid_at)
           SELECT guild_id, channel_id, user_id, category, what, amount, address, stake_user,
                  reward_id, channel_id, message_id, paid, paid_by, paid_at FROM ticket_claims`);
}
try { db.exec('ALTER TABLE settings ADD COLUMN claims_channel TEXT'); } catch { /* already migrated */ }

// Migration: templates keep a JSON blob so they can hold any announcement style
try { db.exec('ALTER TABLE templates ADD COLUMN fields TEXT'); } catch { /* already migrated */ }

const SETTING_COLUMNS = [
  'announce_channel', 'mod_role', 'log_channel', 'claims_channel', 'welcome_channel', 'welcome_message',
  'qotd_channel', 'qotd_hour', 'last_qotd', 'trivia_channel', 'trivia_hour', 'last_trivia',
  'suggest_channel', 'starboard_channel', 'starboard_threshold', 'ticket_category',
  'xp_enabled', 'automod_links',
];

function getSettings(guildId) {
  db.prepare('INSERT OR IGNORE INTO settings (guild_id) VALUES (?)').run(guildId);
  return db.prepare('SELECT * FROM settings WHERE guild_id = ?').get(guildId);
}

function updateSettings(guildId, values) {
  getSettings(guildId);
  const keys = Object.keys(values).filter(k => SETTING_COLUMNS.includes(k));
  if (!keys.length) return;
  const params = { guild_id: guildId };
  for (const k of keys) params[k] = values[k];
  db.prepare(`UPDATE settings SET ${keys.map(k => `${k} = @${k}`).join(', ')} WHERE guild_id = @guild_id`).run(params);
}

module.exports = { db, getSettings, updateSettings, SETTING_COLUMNS };
