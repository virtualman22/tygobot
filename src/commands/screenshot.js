const { SlashCommandBuilder } = require('discord.js');
const { db } = require('../db');
const { eph } = require('../utils');
const { SCREENSHOT_CATEGORIES, attachScreenshot } = require('./ticket');

const data = new SlashCommandBuilder()
  .setName('screenshot')
  .setDescription('Attach a screenshot to your milestone claim')
  .addAttachmentOption(o => o.setName('image').setDescription('Your screenshot').setRequired(true));

async function execute(interaction) {
  const image = interaction.options.getAttachment('image');
  if (!image.contentType?.startsWith('image/')) return interaction.reply(eph({ content: '❌ That file isn\'t an image.' }));

  const marks = SCREENSHOT_CATEGORIES.map(() => '?').join(',');
  const claim = db.prepare(`SELECT * FROM claims WHERE channel_id = ? AND user_id = ? AND paid = 0 AND category IN (${marks}) ORDER BY id DESC LIMIT 1`)
    .get(interaction.channelId, interaction.user.id, ...SCREENSHOT_CATEGORIES);
  if (!claim) return interaction.reply(eph({ content: '❌ You have no unpaid milestone claim in this chat. Submit your claim details first.' }));

  await interaction.deferReply({ flags: 64 });
  try {
    // Re-post the image as a normal message so the link stays valid
    const sent = await interaction.channel.send({ content: `📎 Screenshot from <@${interaction.user.id}>`, files: [image.url], allowedMentions: { parse: [] } });
    await attachScreenshot(interaction.client, claim, sent.url);
    return interaction.editReply('✅ Screenshot added to your claim.');
  } catch (e) {
    return interaction.editReply(`❌ Couldn't add the screenshot: ${e.message}`);
  }
}

module.exports = { data, execute };
