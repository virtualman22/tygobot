const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } = require('discord.js');
const { getSettings, updateSettings } = require('../db');
const { eph } = require('../utils');

const ch = id => (id ? `<#${id}>` : '*not set*');
const hr = h => (h == null ? '*off*' : `${String(h).padStart(2, '0')}:00 UTC`);

const CLEARABLE = [
  'announce_channel', 'mod_role', 'log_channel', 'claims_channel', 'gtb_channel', 'site_tickets_channel', 'referral_channel', 'referral_staff_channel', 'alt_channel', 'welcome_channel', 'qotd_channel', 'qotd_hour',
  'trivia_channel', 'trivia_hour', 'suggest_channel', 'starboard_channel',
];

const text = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

const data = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Configure the bot for this server')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(s => s.setName('view').setDescription('Show current settings'))
  .addSubcommand(s => s.setName('set').setDescription('Change one or more settings')
    .addChannelOption(o => o.setName('announce_channel').setDescription('Default announcement channel').addChannelTypes(...text))
    .addRoleOption(o => o.setName('mod_role').setDescription('Role that can use mod commands (besides Manage Messages)'))
    .addChannelOption(o => o.setName('log_channel').setDescription('Mod log channel').addChannelTypes(...text))
    .addChannelOption(o => o.setName('claims_channel').setDescription('Private staff channel where ALL submitted claim forms are sent').addChannelTypes(...text))
    .addChannelOption(o => o.setName('gtb_channel').setDescription('Guess The Balance channel: the bot posts every website guess + the result here').addChannelTypes(...text))
    .addChannelOption(o => o.setName('site_tickets_channel').setDescription('PRIVATE staff channel: website tickets get a thread here').addChannelTypes(...text))
    .addChannelOption(o => o.setName('referral_channel').setDescription('Public channel: shout-outs when a referrer earns a milestone reward').addChannelTypes(...text))
    .addChannelOption(o => o.setName('referral_staff_channel').setDescription('PRIVATE staff channel: referral + reward cards with Verify / Mark paid buttons').addChannelTypes(...text))
    .addChannelOption(o => o.setName('alt_channel').setDescription('PRIVATE staff channel: website alt detection (holds, new links, "Not alts")').addChannelTypes(...text))
    .addChannelOption(o => o.setName('welcome_channel').setDescription('Welcome message channel').addChannelTypes(...text))
    .addStringOption(o => o.setName('welcome_message').setDescription('Use {user} {server} {count}').setMaxLength(500))
    .addChannelOption(o => o.setName('qotd_channel').setDescription('Question of the Day channel').addChannelTypes(...text))
    .addIntegerOption(o => o.setName('qotd_hour').setDescription('Hour (UTC, 0-23) to post the QOTD').setMinValue(0).setMaxValue(23))
    .addChannelOption(o => o.setName('trivia_channel').setDescription('Daily trivia channel').addChannelTypes(...text))
    .addIntegerOption(o => o.setName('trivia_hour').setDescription('Hour (UTC, 0-23) for daily trivia').setMinValue(0).setMaxValue(23))
    .addChannelOption(o => o.setName('suggest_channel').setDescription('Where suggestions are posted').addChannelTypes(...text))
    .addChannelOption(o => o.setName('starboard_channel').setDescription('Starboard channel').addChannelTypes(...text))
    .addIntegerOption(o => o.setName('starboard_threshold').setDescription('Stars needed to hit the starboard').setMinValue(1).setMaxValue(25))
    .addBooleanOption(o => o.setName('xp_enabled').setDescription('Enable XP / levels'))
    .addBooleanOption(o => o.setName('automod_links').setDescription('Delete links from non-mods (needs privileged intents)')))
  .addSubcommand(s => s.setName('clear').setDescription('Unset a setting')
    .addStringOption(o => o.setName('setting').setDescription('Which setting').setRequired(true)
      .addChoices(...CLEARABLE.map(c => ({ name: c, value: c })))));

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const g = interaction.guildId;

  if (sub === 'set') {
    const values = {};
    for (const opt of interaction.options.data[0].options ?? []) {
      values[opt.name] = typeof opt.value === 'boolean' ? Number(opt.value) : opt.value;
    }
    if (!Object.keys(values).length) return interaction.reply(eph({ content: 'Pick at least one setting to change.' }));
    updateSettings(g, values);
  }

  if (sub === 'clear') {
    updateSettings(g, { [interaction.options.getString('setting')]: null });
  }

  const s = getSettings(g);
  const embed = new EmbedBuilder().setColor('#9146FF').setTitle('⚙️ Server settings').addFields(
    { name: 'Announcements', value: `Channel: ${ch(s.announce_channel)}\nMod role: ${s.mod_role ? `<@&${s.mod_role}>` : '*not set*'}\nLog: ${ch(s.log_channel)}\nClaims: ${ch(s.claims_channel)}` },
    { name: 'Website link', value: `GTB: ${ch(s.gtb_channel)}\nSite tickets: ${ch(s.site_tickets_channel)}\nAlt alerts: ${ch(s.alt_channel)}\nStatus: \`/sitelink status\`` },
    { name: 'Referrals', value: `Shout-outs: ${ch(s.referral_channel)}\nStaff cards: ${ch(s.referral_staff_channel)}` },
    { name: 'Welcome', value: `Channel: ${ch(s.welcome_channel)}\nMessage: ${s.welcome_message}` },
    { name: 'Daily posts', value: `QOTD: ${ch(s.qotd_channel)} at ${hr(s.qotd_hour)}\nTrivia: ${ch(s.trivia_channel)} at ${hr(s.trivia_hour)}` },
    { name: 'Community', value: `Suggestions: ${ch(s.suggest_channel)}\nStarboard: ${ch(s.starboard_channel)} (${s.starboard_threshold}⭐)\nTickets: *own category per type (Giveaway Claims, Bonuses, Technical Assistance, Milestones)*` },
    { name: 'Toggles', value: `XP: ${s.xp_enabled ? 'on' : 'off'}\nLink filter: ${s.automod_links ? 'on' : 'off'}` },
  );
  return interaction.reply(eph({ embeds: [embed] }));
}

module.exports = { data, execute };
