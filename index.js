require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Client, Collection, GatewayIntentBits, Partials } = require('discord.js');
const loadCommands = require('./src/loadCommands');

const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,         // XP
  GatewayIntentBits.GuildMessageReactions, // starboard
];
// Privileged intents: enable them in the Developer Portal first, then set ENABLE_PRIVILEGED_INTENTS=true
if (process.env.ENABLE_PRIVILEGED_INTENTS === 'true') {
  intents.push(GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent);
}

const client = new Client({
  intents,
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.commands = new Collection();
client.buttons = new Collection();
client.modals = new Collection();
client.selects = new Collection();

for (const cmd of loadCommands()) {
  client.commands.set(cmd.data.name, cmd);
  for (const [prefix, fn] of Object.entries(cmd.buttons ?? {})) client.buttons.set(prefix, fn);
  for (const [prefix, fn] of Object.entries(cmd.modals ?? {})) client.modals.set(prefix, fn);
  for (const [prefix, fn] of Object.entries(cmd.selects ?? {})) client.selects.set(prefix, fn);
}

const eventsDir = path.join(__dirname, 'src', 'events');
for (const file of fs.readdirSync(eventsDir).filter(f => f.endsWith('.js'))) {
  const event = require(path.join(eventsDir, file));
  const run = (...args) => event.execute(...args, client);
  if (event.once) client.once(event.name, run);
  else client.on(event.name, run);
}

client.on('error', error => console.error('Discord client error:', error));
process.on('unhandledRejection', error => console.error('Unhandled promise rejection:', error));

client.login(process.env.DISCORD_TOKEN);
