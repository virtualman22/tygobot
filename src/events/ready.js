const { Events } = require('discord.js');
const loadCommands = require('../loadCommands');

// Register slash commands every time the bot starts, so new/changed commands
// (like /claimform and /screenshot) always show up without running `npm run deploy`.
async function registerCommands(client) {
  const body = loadCommands().map(c => c.data.toJSON());
  try {
    if (process.env.GUILD_ID) {
      await client.application.commands.set(body, process.env.GUILD_ID);
      // Clear old global copies so commands don't show up twice
      await client.application.commands.set([]);
      console.log(`Registered ${body.length} slash commands to guild ${process.env.GUILD_ID}.`);
    } else {
      await client.application.commands.set(body);
      console.log(`Registered ${body.length} slash commands globally.`);
    }
  } catch (e) {
    console.error('Failed to register slash commands:', e);
  }
}

module.exports = {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    console.log('\n================================');
    console.log(`Bot: ${client.user.tag}`);
    console.log(`Servers: ${client.guilds.cache.size}`);
    console.log('Status: Online');
    console.log('================================\n');
    await registerCommands(client);
    require('../scheduler').start(client);
    require('../commands/ticket').refreshOpenCards(client).catch(e => console.error('Claim card refresh failed:', e.message));
  },
};