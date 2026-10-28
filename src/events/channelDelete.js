const { Events } = require('discord.js');

// A ticket channel was deleted (Close button or by hand): close its mirror on the website
module.exports = {
  name: Events.ChannelDelete,
  async execute(channel) {
    if (!String(channel?.topic ?? '').startsWith('ticket:')) return;
    await require('../siteTickets').mirrorState(channel.id, true, '').catch(() => {});
    await require('../transcripts').markDeleted(channel);
  },
};
