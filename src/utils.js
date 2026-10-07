const { PermissionsBitField, MessageFlags } = require('discord.js');
const { getSettings } = require('./db');

const eph = (o = {}) => ({ ...o, flags: MessageFlags.Ephemeral });

function isMod(interaction) {
  const member = interaction.member;
  if (!member?.permissions) return false;
  if (member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return true;
  const { mod_role } = getSettings(interaction.guildId);
  return Boolean(mod_role && member.roles?.cache?.has(mod_role));
}

/** Replies with an error and returns false when the user is not a mod. */
function requireMod(interaction) {
  if (isMod(interaction)) return true;
  interaction.reply(eph({ content: '❌ You need the Manage Messages permission (or the configured mod role) to do that.' }));
  return false;
}

const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s ?? '');
const ts = (ms, style = 'f') => `<t:${Math.floor(ms / 1000)}:${style}>`;

function parseColor(input, fallback = '#9146FF') {
  const m = String(input ?? '').trim().match(/^#?([0-9a-f]{6})$/i);
  return m ? `#${m[1].toUpperCase()}` : fallback;
}

/** "30m", "2h", "1d" -> milliseconds (or null) */
function parseDuration(input) {
  const m = String(input ?? '').trim().match(/^(\d+)\s*(m|h|d)$/i);
  if (!m) return null;
  const mult = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase()];
  return Number(m[1]) * mult;
}

/** "+90m" / "+2h" / "+1d" or "YYYY-MM-DD HH:mm" (UTC) -> timestamp in the future (or null) */
function parseWhen(input) {
  const s = String(input ?? '').trim();
  let when = null;
  const rel = s.match(/^\+\s*(\d+\s*[mhd])$/i);
  if (rel) {
    const d = parseDuration(rel[1]);
    if (d) when = Date.now() + d;
  } else {
    const abs = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
    if (abs) when = Date.UTC(+abs[1], +abs[2] - 1, +abs[3], +abs[4], +abs[5]);
  }
  return when && when > Date.now() ? when : null;
}

function nextRun(ms, mode) {
  if (mode === 'daily') return ms + 86_400_000;
  if (mode === 'weekly') return ms + 7 * 86_400_000;
  if (mode === 'monthly') {
    const d = new Date(ms);
    d.setUTCMonth(d.getUTCMonth() + 1);
    return d.getTime();
  }
  return null;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const levelFromXp = xp => Math.floor(Math.sqrt(xp / 100));
const xpForLevel = level => 100 * level * level;

async function logToGuild(client, guildId, content) {
  try {
    const { log_channel } = getSettings(guildId);
    if (!log_channel) return;
    const ch = await client.channels.fetch(log_channel);
    await ch.send({ content: truncate(content, 1900), allowedMentions: { parse: [] } });
  } catch { /* logging must never break a command */ }
}

module.exports = {
  eph, isMod, requireMod, truncate, ts, parseColor, parseDuration, parseWhen,
  nextRun, shuffle, levelFromXp, xpForLevel, logToGuild,
};
