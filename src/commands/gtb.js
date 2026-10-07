const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ChannelType } = require('discord.js');
const { db } = require('../db');
const { eph, requireMod, truncate, logToGuild } = require('../utils');

// Plain digits or a float ("1234", "1234.56"); thousands commas like "1,234.56" are also accepted.
const PLAIN = /^\d+(\.\d+)?$/;
const COMMAS = /^\d{1,3}(,\d{3})+(\.\d+)?$/;

function parseGuess(content) {
  const t = String(content ?? '').trim();
  if (!PLAIN.test(t) && !COMMAS.test(t)) return null;
  const clean = t.replace(/,/g, '');
  const n = Number(clean);
  return Number.isFinite(n) ? { value: n, text: clean } : null;
}

const fmt = n => {
  const s = Number(n).toLocaleString('en-US', { maximumFractionDigits: 8 });
  return s;
};

async function setTyping(channel, allowed, reason) {
  await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { SendMessages: allowed }, { reason });
}

const data = new SlashCommandBuilder()
  .setName('gtb')
  .setDescription('Guess The Balance game')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand(s => s.setName('start').setDescription('Start a GTB: opens the channel so members can send their guess')
    .addChannelOption(o => o.setName('channel').setDescription('GTB channel (default: this one)').addChannelTypes(ChannelType.GuildText))
    .addStringOption(o => o.setName('title').setDescription('Optional title, e.g. "Bonus hunt #12"').setMaxLength(100)))
  .addSubcommand(s => s.setName('close').setDescription('Close the GTB: stops entries and locks the channel')
    .addChannelOption(o => o.setName('channel').setDescription('GTB channel (default: this one)').addChannelTypes(ChannelType.GuildText)))
  .addSubcommand(s => s.setName('result').setDescription('Enter the final balance: shows the top 3 and clears all entries')
    .addNumberOption(o => o.setName('balance').setDescription('The final balance').setRequired(true).setMinValue(0))
    .addChannelOption(o => o.setName('channel').setDescription('GTB channel (default: this one)').addChannelTypes(ChannelType.GuildText)))
  .addSubcommand(s => s.setName('status').setDescription('Show how many guesses are in')
    .addChannelOption(o => o.setName('channel').setDescription('GTB channel (default: this one)').addChannelTypes(ChannelType.GuildText)))
  .addSubcommand(s => s.setName('cancel').setDescription('Cancel the GTB, clear all entries and lock the channel')
    .addChannelOption(o => o.setName('channel').setDescription('GTB channel (default: this one)').addChannelTypes(ChannelType.GuildText)));

/** The GTB for the given/current channel (or the only one running in the server). */
function findGame(interaction) {
  const ch = interaction.options.getChannel('channel');
  if (ch) return db.prepare('SELECT * FROM gtb_games WHERE channel_id = ?').get(ch.id);
  const here = db.prepare('SELECT * FROM gtb_games WHERE channel_id = ?').get(interaction.channelId);
  if (here) return here;
  const all = db.prepare('SELECT * FROM gtb_games WHERE guild_id = ?').all(interaction.guildId);
  return all.length === 1 ? all[0] : null;
}

const countEntries = id => db.prepare('SELECT COUNT(*) c FROM gtb_entries WHERE channel_id = ?').get(id).c;
const clearGame = id => {
  db.prepare('DELETE FROM gtb_entries WHERE channel_id = ?').run(id);
  db.prepare('DELETE FROM gtb_games WHERE channel_id = ?').run(id);
};

async function execute(interaction) {
  if (!requireMod(interaction)) return;
  const sub = interaction.options.getSubcommand();

  if (sub === 'start') {
    const channel = interaction.options.getChannel('channel') ?? interaction.channel;
    const title = interaction.options.getString('title');
    if (db.prepare('SELECT 1 FROM gtb_games WHERE channel_id = ?').get(channel.id)) {
      return interaction.reply(eph({ content: '❌ A GTB is already running in that channel. Use `/gtb close` or `/gtb result` first.' }));
    }
    await interaction.deferReply({ flags: 64 });
    try { await setTyping(channel, true, `GTB started by ${interaction.user.tag}`); }
    catch (e) { return interaction.editReply(`❌ I couldn't open the channel (I need **Manage Channels** / **Manage Roles** there): ${e.message}`); }
    db.prepare('DELETE FROM gtb_entries WHERE channel_id = ?').run(channel.id);
    db.prepare('INSERT INTO gtb_games (channel_id, guild_id, status, title, started_by, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(channel.id, interaction.guildId, 'open', title, interaction.user.id, Date.now());
    await channel.send({ embeds: [new EmbedBuilder().setColor('#2ECC71')
      .setTitle(`💰 Guess The Balance${title ? ` — ${title}` : ''}`)
      .setDescription('**The GTB is open!**\nSend your guess as a number (for example `1250` or `1250.50`).\n⚠️ **One guess per person**, your first valid guess is the one that counts.')] });
    await logToGuild(interaction.client, interaction.guildId, `💰 <@${interaction.user.id}> started a GTB in <#${channel.id}>.`);
    return interaction.editReply(`✅ GTB started in ${channel}.`);
  }

  const game = findGame(interaction);
  if (!game) return interaction.reply(eph({ content: '❌ There is no GTB running here. Start one with `/gtb start`.' }));
  const channel = await interaction.client.channels.fetch(game.channel_id).catch(() => null);

  if (sub === 'status') {
    return interaction.reply(eph({ content: `💰 GTB in <#${game.channel_id}> is **${game.status}** with **${countEntries(game.channel_id)}** guesses.` }));
  }

  if (sub === 'cancel') {
    await interaction.deferReply({ flags: 64 });
    clearGame(game.channel_id);
    if (channel) await setTyping(channel, false, 'GTB cancelled').catch(() => {});
    if (channel) await channel.send('🛑 The GTB was cancelled. All entries were cleared.').catch(() => {});
    return interaction.editReply('✅ GTB cancelled and cleared.');
  }

  if (sub === 'close') {
    if (game.status === 'closed') return interaction.reply(eph({ content: 'That GTB is already closed. Use `/gtb result` with the final balance.' }));
    await interaction.deferReply({ flags: 64 });
    db.prepare("UPDATE gtb_games SET status = 'closed' WHERE channel_id = ?").run(game.channel_id);
    let lockNote = '';
    if (channel) {
      try { await setTyping(channel, false, `GTB closed by ${interaction.user.tag}`); }
      catch (e) { lockNote = `\n⚠️ Entries are closed, but I couldn't lock the channel (${e.message}).`; }
      await channel.send({ embeds: [new EmbedBuilder().setColor('#E74C3C').setTitle('🔒 GTB closed')
        .setDescription(`No more guesses. **${countEntries(game.channel_id)}** entries are locked in. Good luck everyone!`)] }).catch(() => {});
    }
    return interaction.editReply(`✅ GTB closed with ${countEntries(game.channel_id)} guesses. Use \`/gtb result\` when you have the final balance.${lockNote}`);
  }

  if (sub === 'result') {
    await interaction.deferReply({ flags: 64 });
    const balance = interaction.options.getNumber('balance');
    // Make sure nobody can still enter
    if (game.status === 'open' && channel) await setTyping(channel, false, 'GTB finished').catch(() => {});

    const entries = db.prepare('SELECT * FROM gtb_entries WHERE channel_id = ?').all(game.channel_id)
      .map(e => ({ ...e, diff: Math.abs(e.guess - balance) }))
      .sort((a, b) => a.diff - b.diff || a.ts - b.ts); // closest wins, earlier guess breaks a tie

    const medals = ['🥇', '🥈', '🥉'];
    const top = entries.slice(0, 3);
    const lines = top.map((e, i) => {
      const dir = e.guess === balance ? 'exact!' : e.guess > balance ? 'over' : 'under';
      return `${medals[i]} <@${e.user_id}> — guessed **${fmt(e.guess)}** · off by **${fmt(e.diff)}** (${dir})`;
    });

    const embed = new EmbedBuilder().setColor('#F1C40F')
      .setTitle(`🏁 GTB result${game.title ? ` — ${truncate(game.title, 100)}` : ''}`)
      .addFields({ name: 'Final balance', value: `**${fmt(balance)}**` })
      .setDescription(top.length ? lines.join('\n') : '*Nobody entered this one.*')
      .setFooter({ text: `${entries.length} total ${entries.length === 1 ? 'entry' : 'entries'}` });
    if (top.length) embed.addFields({ name: 'Winner', value: `🎉 <@${top[0].user_id}>` });

    const payload = { embeds: [embed], allowedMentions: { users: top.map(e => e.user_id) } };
    if (channel) await channel.send(payload).catch(e => console.error('GTB result post failed:', e.message));
    clearGame(game.channel_id); // entries wiped, ready for the next one
    await logToGuild(interaction.client, interaction.guildId,
      `💰 <@${interaction.user.id}> ended the GTB in <#${game.channel_id}> (final ${fmt(balance)}).${top[0] ? ` Winner: <@${top[0].user_id}>.` : ''}`);
    return interaction.editReply(`✅ Result posted in <#${game.channel_id}> and all entries were cleared. Channel is locked; use \`/gtb start\` for the next one.`);
  }
}

/** Called for every guild message: records the member's single guess while a GTB is open in that channel. */
async function handleGuess(message) {
  const game = db.prepare("SELECT * FROM gtb_games WHERE channel_id = ? AND status = 'open'").get(message.channelId);
  if (!game) return;
  const guess = parseGuess(message.content);
  if (!guess) return;
  const res = db.prepare(`INSERT OR IGNORE INTO gtb_entries (channel_id, user_id, guess, guess_text, message_id, ts)
                          VALUES (?, ?, ?, ?, ?, ?)`)
    .run(message.channelId, message.author.id, guess.value, guess.text, message.id, Date.now());
  message.react(res.changes ? '✅' : '❌').catch(() => {}); // ❌ = you already guessed
}

module.exports = { data, execute, handleGuess };
