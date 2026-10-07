const { Events } = require('discord.js');

module.exports = {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    console.log('\n================================');
    console.log(`Bot: ${client.user.tag}`);
    console.log(`Servers: ${client.guilds.cache.size}`);
    console.log('Status: Online');
    console.log('================================\n');
    require('../scheduler').start(client);
  },
};
