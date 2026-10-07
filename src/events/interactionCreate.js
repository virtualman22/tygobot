const { Events } = require('discord.js');
const { eph } = require('../utils');

async function fail(interaction, error) {
  console.error(error);
  const payload = eph({ content: '❌ Something went wrong running that. Please try again.' });
  try {
    if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch { /* interaction expired */ }
}

module.exports = {
  name: Events.InteractionCreate,
  async execute(interaction, client) {
    try {
      if (!interaction.inGuild()) return;

      if (interaction.isChatInputCommand()) {
        return await client.commands.get(interaction.commandName)?.execute(interaction);
      }
      if (interaction.isAutocomplete()) {
        return await client.commands.get(interaction.commandName)?.autocomplete?.(interaction);
      }
      if (interaction.isButton()) {
        const [prefix, ...args] = interaction.customId.split(':');
        return await client.buttons.get(prefix)?.(interaction, args);
      }
      if (interaction.isStringSelectMenu()) {
        const [prefix, ...args] = interaction.customId.split(':');
        return await client.selects.get(prefix)?.(interaction, args);
      }
      if (interaction.isModalSubmit()) {
        const [prefix, ...args] = interaction.customId.split(':');
        return await client.modals.get(prefix)?.(interaction, args);
      }
    } catch (error) {
      if (!interaction.isAutocomplete()) await fail(interaction, error);
      else console.error(error);
    }
  },
};
