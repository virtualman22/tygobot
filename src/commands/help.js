const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { getSettings } = require('../db');
const { eph, isMod } = require('../utils');

const COLOR = '#9146FF';

function checklist(guildId) {
  const s = getSettings(guildId);
  const item = (ok, name, how) => `${ok ? '✅' : '⬜'} **${name}**${ok ? '' : ` — \`${how}\``}`;
  return [
    item(s.announce_channel, 'Announcement channel', '/setup set announce_channel:#channel'),
    item(s.log_channel, 'Mod log channel', '/setup set log_channel:#channel'),
    item(s.mod_role, 'Mod role', '/setup set mod_role:@role'),
    item(s.ticket_category, 'Ticket category', '/setup set ticket_category:Category'),
    item(s.trivia_channel && s.trivia_hour != null, 'Daily trivia', '/setup set trivia_channel:#channel trivia_hour:18'),
    item(s.qotd_channel && s.qotd_hour != null, 'Question of the Day', '/setup set qotd_channel:#channel qotd_hour:15'),
    item(s.suggest_channel, 'Suggestions channel', '/setup set suggest_channel:#channel'),
    item(s.welcome_channel, 'Welcome messages', '/setup set welcome_channel:#channel'),
    item(s.starboard_channel, 'Starboard', '/setup set starboard_channel:#channel'),
  ].join('\n');
}

const PAGES = {
  home: {
    label: '🏠 Start here', description: 'What the bot does and the most common tasks',
    build: () => ({
      title: '👋 Welcome! Here\'s what I can do',
      description:
        'Use the **dropdown below** to read about any feature. Everything is a slash command: type `/` and pick from the list.\n\n' +
        '**Most common things people ask for**\n' +
        '📢 Post an announcement → `/announcement create`\n' +
        '🎫 Let members open a ticket → `/ticket panel`\n' +
        '🎁 Track who is owed a reward → `/rewards add`\n' +
        '🧠 Play trivia → `/trivia play`\n' +
        '📊 Run a poll → `/poll create`\n' +
        '🎉 Run a giveaway → `/giveaway start`\n' +
        '⭐ Check your level → `/xp rank`\n\n' +
        '🔒 = moderators only. Not sure where to begin? Open **Setup checklist**.',
    }),
  },
  setup: {
    label: '✅ Setup checklist', description: 'First-time setup, with what is done and what is missing', mod: true,
    build: (gid) => ({
      title: '✅ Setup checklist 🔒',
      description:
        `Tick these off once. Copy the command shown next to any ⬜ item.\n\n${checklist(gid)}\n\n` +
        '`/setup view` shows all your settings. `/setup clear` unsets one.\n' +
        'Hours are in **UTC**.',
    }),
  },
  announce: {
    label: '📢 Announcements', description: 'Post, schedule and edit announcements', mod: true,
    build: () => ({
      title: '📢 Announcements 🔒',
      description:
        '**Post one:** `/announcement create`\n' +
        'Pick a **style**, type your text in the pop-up form, then check the preview and press **Send**.\n\n' +
        '**Three styles**\n' +
        '✏️ **Free text** (default) — a title (optional) and a big text box where you can type anything. Add an optional link button.\n' +
        '💬 **Plain message** — normal chat text, no embed box.\n' +
        '🏆 **Event layout** — the structured one with leaderboard link, how to participate, and rewards & rules.\n\n' +
        '**Extra options** (all optional): `channel`, `ping` a role, `color`, `image`, or start from a `template`.\n\n' +
        '**On the preview you can:** Send · Schedule (later or repeating) · Edit · Save as template · Cancel\n\n' +
        '**Later:** `/announcement edit` and `/announcement delete` (need the message ID: right-click the message → Copy Message ID), `/announcement scheduled`, `/announcement templates`.\n\n' +
        '**Formatting tips:** `**bold**`, `*italic*`, `> quote`, `- list`, and `[text](https://link)` all work.',
    }),
  },
  tickets: {
    label: '🎫 Tickets', description: 'Private support channels in 4 categories',
    build: () => ({
      title: '🎫 Tickets',
      description:
        '**Members:** press a button on the ticket panel. A private channel opens just for you and staff.\n' +
        '🎁 **Giveaway Claim** — you won a giveaway\n' +
        '🏆 **Milestones** — you reached a milestone\n' +
        '🛠️ **Technical Assistance** — something is broken\n' +
        '💰 **Bonuses** — questions about a bonus\n' +
        'You can have one open ticket per category.\n\n' +
        '🎁 **Giveaway Claim** and 💰 **Bonuses** tickets have a **Submit claim details** button: you enter what you won, how much, your crypto address and your Stake username. '+
        'Staff then press **Mark as paid** once it is sent. Every claim is saved in the rewards tracker automatically.\n\n' +
        '**Staff 🔒:** run `/ticket panel` in the channel where members should see the buttons. Inside a ticket, **Claim** shows you are handling it and **Close ticket** deletes the channel after 5 seconds.\n\n' +
        'Set the Discord category tickets are created in with `/setup set ticket_category`, and the staff role with `/setup set mod_role`.',
    }),
  },
  rewards: {
    label: '🎁 Rewards tracker', description: 'Keep track of who is owed what', mod: true,
    build: () => ({
      title: '🎁 Rewards tracker 🔒',
      description:
        'A private log for prizes, payouts and bonuses. Each entry has: **Label** (what it is for), **User name**, **Reward**, **Notes** and **Status** (Pending / Paid / Cancelled).\n\n' +
        '`/rewards add` — fill in a short form\n' +
        '`/rewards list` — browse, with optional filters for label, user or status\n' +
        '`/rewards status` — mark an entry Paid in one step\n' +
        '`/rewards view`, `edit`, `delete` — work with one entry by its number\n' +
        '`/rewards labels` — totals per label (how many are still pending)\n' +
        '`/rewards export` — download a CSV for Excel or Google Sheets\n\n' +
        'Only you can see the replies.',
    }),
  },
  trivia: {
    label: '🧠 Trivia', description: 'Questions, scores and leaderboards',
    build: () => ({
      title: '🧠 Trivia',
      description:
        '`/trivia play` — posts a question. Press A, B, C or D within 20 seconds. Faster correct answers earn bonus points.\n' +
        '`/trivia leaderboard` — top players (week, month or all time)\n' +
        '`/trivia stats` — your accuracy and streak\n\n' +
        '**Mods 🔒:** `/trivia add` writes your own question, `/trivia questions` lists them, `/trivia remove` deletes one.\n' +
        'For a question every day, set `trivia_channel` and `trivia_hour` in `/setup set`.',
    }),
  },
  fun: {
    label: '🎉 Polls, giveaways & more', description: 'Polls, giveaways, QOTD, suggestions, role buttons', 
    build: () => ({
      title: '🎉 Polls, giveaways & more',
      description:
        '**Everyone**\n' +
        '`/suggest new` — send an idea to the suggestions channel\n' +
        '`/xp rank` and `/xp leaderboard` — levels from chatting\n\n' +
        '**Mods 🔒**\n' +
        '`/poll create` — separate options with `|`, e.g. `Yes | No | Maybe`. Add a duration like `2h` to auto-close.\n' +
        '`/giveaway start` — prize, duration (like `3d`), number of winners. Also `end` and `reroll`.\n' +
        '`/qotd add` — queue questions. One is posted each day at the hour you set. `/qotd post` posts one now.\n' +
        '`/suggest review` — approve or deny a suggestion\n' +
        '`/rolepanel` — post buttons so members choose their own roles',
    }),
  },
  auto: {
    label: '🤖 Automatic features', description: 'Welcome, levels, starboard, link filter', mod: true,
    build: () => ({
      title: '🤖 Automatic features 🔒',
      description:
        '👋 **Welcome messages** — `/setup set welcome_channel` and `welcome_message`. Use `{user}`, `{server}` and `{count}`.\n' +
        '⭐ **Starboard** — messages that get enough ⭐ reactions are copied to the starboard channel (`starboard_channel`, `starboard_threshold`).\n' +
        '📈 **Levels** — members earn XP for chatting. Turn off with `/setup set xp_enabled:false`.\n' +
        '🔗 **Link filter** — deletes links from non-mods (`automod_links:true`).\n\n' +
        'Welcome messages and the link filter also need the **Server Members** and **Message Content** intents turned on in the Discord Developer Portal, and `ENABLE_PRIVILEGED_INTENTS=true` in the bot\'s `.env` file.',
    }),
  },
};

function pagePayload(key, interaction) {
  const page = PAGES[key] ?? PAGES.home;
  const embed = new EmbedBuilder().setColor(COLOR).setFooter({ text: 'Tip: type / to see every command' });
  const { title, description } = page.build(interaction.guildId);
  embed.setTitle(title).setDescription(description);

  const menu = new StringSelectMenuBuilder().setCustomId('help:menu').setPlaceholder('Choose a topic…')
    .addOptions(Object.entries(PAGES).map(([value, p]) => ({
      label: p.label.replace(/^\S+\s/, ''), emoji: p.label.split(' ')[0], description: p.description.slice(0, 100),
      value, default: value === key,
    })));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
}

const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Learn what the bot can do and how to use it')
  .addStringOption(o => o.setName('topic').setDescription('Jump straight to a topic')
    .addChoices(...Object.entries(PAGES).map(([value, p]) => ({ name: p.label.replace(/^\S+\s/, ''), value }))));

async function execute(interaction) {
  return interaction.reply(eph(pagePayload(interaction.options.getString('topic') ?? 'home', interaction)));
}

const selects = {
  async help(interaction) {
    return interaction.update(pagePayload(interaction.values[0], interaction));
  },
};

module.exports = { data, execute, selects };
