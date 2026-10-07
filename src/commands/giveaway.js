const {
  SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const { db } = require('../db');
const { eph, requireMod, parseDuration, shuffle, ts } = require('../utils');

const entryCount = id => db.prepare('SELECT COUNT(*) c FROM giveaway_entries WHERE message_id = ?').get(id).c;

function giveawayEmbed(g, { ended = false, winners = [] } = {}) {
  const e = new EmbedBuilder().setColor(ended ? '#95A5A6' : '#E91E63').setTitle(`🎉 ${g.prize}`)
    .setFooter({ text: `${entryCount(g.message_id)} entries` });
  if (ended) {
    e.setDescription(`**Ended** ${ts(g.ends_at, 'R')}\nWinner${winners.length === 1 ? '' : 's'}: ${winners.length ? winners.map(w => `<@${w}>`).join(', ') : '*no valid entries*'}\nHosted by <@${g.host_id}>`);
  } else {
    e.setDescription(`Click the button to enter!\n\nEnds ${ts(g.ends_at, 'R')} (${ts(g.ends_at)})\nWinners: **${g.winners}**\nHosted by <@${g.host_id}>`);
  }
  return e;
}

const enterRow = disabled => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('gw:enter').setLabel('🎉 Enter').setStyle(ButtonStyle.Success).setDisabled(disabled));

/** Ends (or rerolls) a giveaway and announces winners. */
async function endGiveaway(client, g, { reroll = false } = {}) {
  const entries = db.prepare('SELECT user_id FROM giveaway_entries WHERE message_id = ?').all(g.message_id).map(r => r.user_id);
  const winners = shuffle(entries).slice(0, g.winners);
  db.prepare('UPDATE giveaways SET ended = 1 WHERE message_id = ?').run(g.message_id);
  try {
    const ch = await client.channels.fetch(g.channel_id);
    const msg = await ch.messages.fetch(g.message_id);
    await msg.edit({ embeds: [giveawayEmbed(g, { ended: true, winners })], components: [enterRow(true)] });
    await ch.send({
      content: winners.length
        ? `🎉 ${reroll ? 'New winner' : 'Congratulations'} ${winners.map(w => `<@${w}>`).join(', ')}! You won **${g.prize}**.`
        : `😕 No valid entries for **${g.prize}**.`,
      allowedMentions: { users: winners },
      reply: { messageReference: g.message_id, failIfNotExists: false },
    });
  } catch (e) { console.error('Giveaway end failed:', e.message); }
}

const data = new SlashCommandBuilder()
  .setName('giveaway')
  .setDescription('Run giveaways')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand(s => s.setName('start').setDescription('Start a giveaway')
    .addStringOption(o => o.setName('prize').setDescription('What are you giving away?').setRequired(true).setMaxLength(200))
    .addStringOption(o => o.setName('duration').setDescription('e.g. 30m, 12h, 3d').setRequired(true))
    .addIntegerOption(o => o.setName('winners').setDescription('Number of winners (default 1)').setMinValue(1).setMaxValue(20)))
  .addSubcommand(s => s.setName('end').setDescription('End a giveaway now')
    .addStringOption(o => o.setName('message_id').setDescription('Giveaway message ID').setRequired(true)))
  .addSubcommand(s => s.setName('reroll').setDescription('Pick new winners for an ended giveaway')
    .addStringOption(o => o.setName('message_id').setDescription('Giveaway message ID').setRequired(true)));

async function execute(interaction) {
  if (!requireMod(interaction)) return;
  const sub = interaction.options.getSubcommand();

  if (sub === 'start') {
    const dur = parseDuration(interaction.options.getString('duration'));
    if (!dur) return interaction.reply(eph({ content: '❌ Duration should look like `30m`, `12h` or `3d`.' }));
    const g = {
      message_id: 'pending', guild_id: interaction.guildId, channel_id: interaction.channelId,
      prize: interaction.options.getString('prize'), winners: interaction.options.getInteger('winners') ?? 1,
      ends_at: Date.now() + dur, host_id: interaction.user.id,
    };
    await interaction.reply({ embeds: [giveawayEmbed(g)], components: [enterRow(false)] });
    const msg = await interaction.fetchReply();
    g.message_id = msg.id;
    db.prepare('INSERT INTO giveaways (message_id, guild_id, channel_id, prize, winners, ends_at, host_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(g.message_id, g.guild_id, g.channel_id, g.prize, g.winners, g.ends_at, g.host_id);
    return;
  }

  const g = db.prepare('SELECT * FROM giveaways WHERE message_id = ? AND guild_id = ?').get(interaction.options.getString('message_id').trim(), interaction.guildId);
  if (!g) return interaction.reply(eph({ content: '❌ Giveaway not found.' }));

  if (sub === 'end') {
    if (g.ended) return interaction.reply(eph({ content: 'That giveaway already ended. Use `/giveaway reroll`.' }));
    await endGiveaway(interaction.client, { ...g, ends_at: Date.now() });
    return interaction.reply(eph({ content: '✅ Ended.' }));
  }
  if (sub === 'reroll') {
    if (!g.ended) return interaction.reply(eph({ content: 'That giveaway is still running.' }));
    await endGiveaway(interaction.client, g, { reroll: true });
    return interaction.reply(eph({ content: '✅ Rerolled.' }));
  }
}

const buttons = {
  async gw(interaction) {
    const g = db.prepare('SELECT * FROM giveaways WHERE message_id = ?').get(interaction.message.id);
    if (!g || g.ended) return interaction.reply(eph({ content: '⌛ This giveaway has ended.' }));
    const del = db.prepare('DELETE FROM giveaway_entries WHERE message_id = ? AND user_id = ?').run(g.message_id, interaction.user.id);
    if (!del.changes) db.prepare('INSERT INTO giveaway_entries (message_id, user_id) VALUES (?, ?)').run(g.message_id, interaction.user.id);
    await interaction.update({ embeds: [giveawayEmbed(g)] });
    await interaction.followUp(eph({ content: del.changes ? '👋 You left the giveaway.' : '🎉 You\'re in! Click again to leave.' }));
  },
};

module.exports = { data, execute, buttons, endGiveaway };
