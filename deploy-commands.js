require('dotenv').config();

const { REST, Routes } = require('discord.js');
const loadCommands = require('./src/loadCommands');

const commands = loadCommands().map(c => c.data.toJSON());
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log(`Deploying ${commands.length} slash commands...`);
    const route = process.env.GUILD_ID
      ? Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID)
      : Routes.applicationCommands(process.env.CLIENT_ID);
    await rest.put(route, { body: commands });
    console.log(`Slash commands deployed ${process.env.GUILD_ID ? 'to your server' : 'globally'}.`);
  } catch (error) {
    console.error(error);
  }
})();
