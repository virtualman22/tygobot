/**
 * lossbackNotify.js — DMs a member when their lossback is paid or disqualified.
 *
 * Called from every place that changes a lossback: the list's "Mark paid" / "Disqualify" buttons in Discord,
 * and the website's Pay / DQ buttons (they reach the bot as record.cmd events, see siteCmd.js).
 * Each entry gets at most ONE DM per outcome (table lossback_dm), so toggling paid off and on again never spams anyone.
 * If the member has DMs closed (or left the server) it is written to the log channel instead.
 *
 * Optional Railway variable: LOSSBACK_DM=off switches the DMs off.
 */
const { EmbedBuilder } = require('discord.js');
const { db } = require('./db');
const { logToGuild, truncate } = require('./utils');
const { siteTag } = require('./sites');

db.exec(`CREATE TABLE IF NOT EXISTS lossback_dm (entry_id INTEGER, status TEXT, at INTEGER, PRIMARY KEY (entry_id, status));`);

const enabled = () => String(process.env.LOSSBACK_DM || '').toLowerCase() !== 'off';
const shortAddr = a => (a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '');

/**
 * @param client  discord.js client
 * @param entry   the list_entries row (needs id, list_id, user_id, name, value1 = wallet, value2 = loss, site)
 * @param status  'paid' | 'dq'
 * @param reason  disqualify reason (optional)
 * @returns true if a DM was sent
 */
async function notifyLossback(client, entry, status, reason = '') {
  if (!enabled() || !entry || !['paid', 'dq'].includes(status)) return false;
  const uid = String(entry.user_id || '').replace(/\D/g, '');
  if (!uid) return false;                                                    // added by hand without a Discord account: nobody to tell
  const claimed = db.prepare('INSERT OR IGNORE INTO lossback_dm (entry_id, status, at) VALUES (?, ?, ?)').run(entry.id, status, Date.now());
  if (!claimed.changes) return false;                                        // already told about this outcome

  const list = db.prepare('SELECT title, guild_id FROM lists WHERE id = ?').get(entry.list_id);
  const guildName = client.guilds.cache.get(list?.guild_id)?.name || 'the server';
  const fields = [
    { name: 'Site', value: siteTag(entry.site), inline: true },
    { name: 'Username', value: truncate(entry.name || '—', 100), inline: true },
  ];
  if (entry.value2) fields.push({ name: 'Loss', value: truncate(entry.value2, 100), inline: true });
  if (list?.title) fields.push({ name: 'Week', value: truncate(list.title, 100), inline: true });

  const embed = status === 'paid'
    ? new EmbedBuilder().setColor('#2ECC71').setTitle('✅ Your lossback has been paid!')
      .setDescription(`Your lossback from **${guildName}** was sent${entry.value1 ? ` to your wallet \`${shortAddr(entry.value1)}\`` : ''}. Please check your wallet. If it hasn't arrived within a few hours, open a ticket.`)
      .addFields(fields)
    : new EmbedBuilder().setColor('#E74C3C').setTitle('🚫 Your lossback was disqualified')
      .setDescription(`Staff at **${guildName}** disqualified this lossback submission.${reason ? `\n\n**Reason:** ${truncate(reason, 500)}` : ''}\n\nYou can submit a new lossback form next Friday. If you think this is a mistake, open a ticket.`)
      .addFields(fields);

  try {
    const user = await client.users.fetch(uid);
    await user.send({ embeds: [embed] });
    return true;
  } catch (e) {
    await logToGuild(client, list?.guild_id, `📭 Couldn't DM <@${uid}> that their lossback (**${entry.name}**) was ${status === 'paid' ? 'paid' : 'disqualified'}: ${e.code === 50007 ? 'their DMs are closed' : e.message}.`);
    return false;
  }
}

/** Forget a DM so the next change can notify again (used when a disqualification is undone). */
const forget = (entryId, status) => db.prepare('DELETE FROM lossback_dm WHERE entry_id = ? AND status = ?').run(entryId, status);

module.exports = { notifyLossback, forget };
