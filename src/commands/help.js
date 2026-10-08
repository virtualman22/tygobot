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
    item(s.claims_channel, 'Claims channel (all submitted forms go here)', '/setup set claims_channel:#staff-channel'),
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
    label: '🎫 Tickets & claims', description: 'Private tickets, claim forms and payouts',
    build: () => ({
      title: '🎫 Tickets & claims',
      description:
        '**Members:** press a button on the ticket panel. A private channel opens just for you and staff.\n' +
        '🎁 **Giveaway Claim** · 🏆 **Milestones** · 🛠️ **Technical Assistance** · 💰 **Bonuses**\n' +
        'You can have one open ticket per category.\n\n' +
        '**Claim forms** (Giveaway Claim, Milestones, Bonuses): press **Submit claim details** and fill in what you won (or which milestone you hit), how much, your crypto address and your Stake username. ' +
        'For milestones, then upload your screenshot in the chat (or use `/screenshot`).\n\n' +
        '**Staff 🔒**\n' +
        '`/ticket panel` — post the ticket buttons\n' +
        '`/claimform` — post a claim form button in ANY chat. Submissions go to your claims channel (`/setup set claims_channel`) so addresses stay private.\n' +
        '**Mark as paid** on a claim card updates the rewards tracker, tells the member and renames their ticket to `paid-…`.\n' +
        '**Disqualify** on a claim card (with an optional reason) cancels it, tells the member and lets them submit again. Paid claims can\'t be disqualified.\n' +
        'Each member can have **one active submission per category** until it is paid or disqualified.\n' +
        '**Only staff can close tickets.** Close ticket deletes the channel after 5 seconds.',
    }),
  },
  rewards: {
    label: '🎁 Rewards tracker', description: 'Keep track of who is owed what', mod: true,
    build: () => ({
      title: '🎁 Rewards tracker 🔒',
      description:
        'A log for prizes, payouts and bonuses. Each entry has: **Label** (what it is for), **User name**, **Reward**, **Notes** and **Status** (Pending / Paid / Cancelled).\n\n' +
        '`/rewards add` — fill in a short form\n' +
        '`/rewards list` — browse, with optional filters for label, user or status\n' +
        '`/rewards status` — mark an entry Paid in one step\n' +
        '`/rewards view`, `edit`, `delete` — work with one entry by its number\n' +
        '`/rewards labels` — totals per label (how many are still pending)\n' +
        '`/rewards export` — download a CSV for Excel or Google Sheets\n\n' +
        'Replies are posted in the channel for everyone to see, with full usernames and crypto addresses.',
    }),
  },
  lists: {
    label: '📋 Custom lists', description: 'Make lists of names and values that everyone can read', mod: true,
    build: () => ({
      title: '📋 Custom lists 🔒',
      description:
        'Spawn as many lists as you like, each for its own purpose (top wagerers, winners, VIPs…). Everyone can read them; staff edit them with buttons.\n\n' +
        '`/list create title:` — posts a new empty list. Optional `value1` / `value2` set the headers of up to two value columns (e.g. *Amount*, *Status*), `name_header` renames the names column, and `channel` picks where it goes.\n' +
        '`/list all` — every list in the server with a link · `/list delete` — remove one\n\n' +
        '**Buttons on the list**\n' +
        '➕ **Add** — one entry · 📥 **Bulk add** — paste many, one per line like `Alice | $25 | Paid`\n' +
        '✏️ **Edit** — pick an entry and change it · 🗑️ **Remove** — pick one or more entries to delete\n' +
        '⚙️ **Settings** — change the title, text and column headers (leave a value header empty to hide that column)\n' +
        '◀ ▶ — pages, for long lists (anyone can use these)',
    }),
  },
  gtb: {
    label: '💰 Guess The Balance', description: 'Run a GTB game', mod: true,
    build: () => ({
      title: '💰 Guess The Balance 🔒',
      description:
        '`/gtb start` — opens the channel; members send a number (like `1250` or `1250.50`) as their guess. **One guess each**, the first one counts (✅ = saved, ❌ = already guessed).\n' +
        '`/gtb close` — stops entries and locks the channel\n' +
        '`/gtb result balance:` — enter the final balance: posts the **top 3 with how far off they were**, then clears every entry\n' +
        '`/gtb status` — how many guesses are in · `/gtb cancel` — scrap the game\n\n' +
        'Needs the **Message Content** intent (`ENABLE_PRIVILEGED_INTENTS=true`) and the bot needs **Manage Channels** in the GTB channel.',
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
