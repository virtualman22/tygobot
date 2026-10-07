const { db } = require('./db');
const { sendAnnouncement } = require('./announce');
const { nextRun } = require('./utils');
const { closePoll } = require('./commands/poll');
const { endGiveaway } = require('./commands/giveaway');
const { startTrivia } = require('./commands/trivia');
const { postQotd } = require('./commands/qotd');

async function tick(client) {
  const now = Date.now();

  // Scheduled announcements
  for (const r of db.prepare('SELECT * FROM scheduled WHERE send_at <= ?').all(now)) {
    const upcoming = nextRun(r.send_at, r.repeat_mode);
    if (upcoming) {
      let t = upcoming;
      while (t <= now) t = nextRun(t, r.repeat_mode); // skip missed runs after downtime
      db.prepare('UPDATE scheduled SET send_at = ? WHERE id = ?').run(t, r.id);
    } else {
      db.prepare('DELETE FROM scheduled WHERE id = ?').run(r.id);
    }
    try {
      await sendAnnouncement(client, {
        guildId: r.guild_id, channelId: r.channel_id, roleId: r.role_id,
        fields: JSON.parse(r.fields), color: r.color, image: r.image,
      });
    } catch (e) { console.error(`Scheduled announcement #${r.id} failed:`, e.message); }
  }

  // Polls
  for (const p of db.prepare('SELECT * FROM polls WHERE closed = 0 AND ends_at IS NOT NULL AND ends_at <= ?').all(now)) {
    await closePoll(client, p);
  }

  // Giveaways
  for (const g of db.prepare('SELECT * FROM giveaways WHERE ended = 0 AND ends_at <= ?').all(now)) {
    await endGiveaway(client, g);
  }

  // Daily trivia + question of the day (hours are UTC; catches up if the bot was offline at the exact hour)
  const d = new Date();
  const today = d.toISOString().slice(0, 10);
  const hour = d.getUTCHours();

  for (const s of db.prepare('SELECT * FROM settings WHERE trivia_channel IS NOT NULL AND trivia_hour IS NOT NULL').all()) {
    if (hour >= s.trivia_hour && s.last_trivia !== today) {
      db.prepare('UPDATE settings SET last_trivia = ? WHERE guild_id = ?').run(today, s.guild_id);
      try {
        const ch = await client.channels.fetch(s.trivia_channel);
        await startTrivia(client, ch, { source: 'any' });
      } catch (e) { console.error('Daily trivia failed:', e.message); }
    }
  }

  for (const s of db.prepare('SELECT * FROM settings WHERE qotd_channel IS NOT NULL AND qotd_hour IS NOT NULL').all()) {
    if (hour >= s.qotd_hour && s.last_qotd !== today) {
      db.prepare('UPDATE settings SET last_qotd = ? WHERE guild_id = ?').run(today, s.guild_id);
      try { await postQotd(client, s.guild_id, s.qotd_channel); }
      catch (e) { console.error('QOTD failed:', e.message); }
    }
  }
}

let running = false;
function start(client) {
  setInterval(async () => {
    if (running) return;
    running = true;
    try { await tick(client); } catch (e) { console.error('Scheduler error:', e); }
    running = false;
  }, 30_000);
}

module.exports = { start };
