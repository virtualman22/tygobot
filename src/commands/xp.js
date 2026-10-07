const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { db } = require('../db');
const { eph, levelFromXp, xpForLevel } = require('../utils');

const MEDALS = ['🥇', '🥈', '🥉'];

const data = new SlashCommandBuilder()
  .setName('xp')
  .setDescription('Levels and XP')
  .addSubcommand(s => s.setName('rank').setDescription('Show your level')
    .addUserOption(o => o.setName('user').setDescription('Defaults to you')))
  .addSubcommand(s => s.setName('leaderboard').setDescription('Top chatters'));

async function execute(interaction) {
  const g = interaction.guildId;

  if (interaction.options.getSubcommand() === 'rank') {
    const user = interaction.options.getUser('user') ?? interaction.user;
    const row = db.prepare('SELECT xp FROM xp WHERE guild_id = ? AND user_id = ?').get(g, user.id);
    if (!row) return interaction.reply(eph({ content: `${user.username} has no XP yet.` }));
    const level = levelFromXp(row.xp);
    const cur = row.xp - xpForLevel(level);
    const need = xpForLevel(level + 1) - xpForLevel(level);
    const rank = db.prepare('SELECT COUNT(*) + 1 r FROM xp WHERE guild_id = ? AND xp > ?').get(g, row.xp).r;
    const filled = Math.round((cur / need) * 12);
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor('#9146FF').setTitle(`${user.username} — Level ${level}`)
        .setThumbnail(user.displayAvatarURL())
        .setDescription(`Rank **#${rank}** · ${row.xp} XP\n${'█'.repeat(filled)}${'░'.repeat(12 - filled)} ${cur}/${need}`)],
    });
  }

  const rows = db.prepare('SELECT user_id, xp FROM xp WHERE guild_id = ? ORDER BY xp DESC LIMIT 10').all(g);
  const desc = rows.length ? rows.map((r, i) => `${MEDALS[i] ?? `**${i + 1}.**`} <@${r.user_id}> — Level ${levelFromXp(r.xp)} (${r.xp} XP)`).join('\n') : '*Nobody has XP yet.*';
  return interaction.reply({ embeds: [new EmbedBuilder().setColor('#9146FF').setTitle('🏆 XP leaderboard').setDescription(desc)], allowedMentions: { parse: [] } });
}

module.exports = { data, execute };
