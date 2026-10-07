const { EmbedBuilder, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { db } = require('./db');
const { truncate, logToGuild } = require('./utils');

const STYLES = {
  text: 'Free text (embed)',
  plain: 'Plain message (no embed)',
  event: 'Event layout (leaderboard / rewards)',
};
const BAR = '━━━━━━━━━━━━━━━━━━━━';

/** Older saved announcements have no style: treat them as the event layout. */
function normalizeFields(f) {
  if (f.style) return f;
  return { ...f, style: f.introduction ? 'event' : 'text' };
}

/** "Label | https://link" (or just a link) -> { label, url } */
function parseButton(input) {
  if (!input) return null;
  const parts = input.split('|').map(x => x.trim());
  const url = parts.length > 1 ? parts[1] : parts[0];
  const label = parts.length > 1 ? parts[0] : 'Open link';
  if (!/^https?:\/\/\S+$/i.test(url)) return null;
  return { label: (label || 'Open link').slice(0, 80), url };
}

function eventEmbed(f, color, image) {
  let d = `${f.introduction}\n\n${BAR}\n\n`;
  if (f.standings) {
    const parts = f.standings.split('|');
    const linkText = parts[0]?.trim() || 'View the Leaderboard';
    const url = parts[1]?.trim();
    d += `📊 **View Live Standings**\n`;
    d += url && /^https?:\/\/.+/i.test(url) ? `👉 **[${linkText}](${url})**\n` : `👉 **${linkText}**\n`;
    d += `*Check the latest rankings and your current position.*\n\n`;
  }
  if (f.participation) d += `📝 **How to Participate**\n\n${f.participation}\n\n`;
  if (f.rewards) d += `💰 **Rewards & Rules**\n${f.rewards}\n\n`;
  d += BAR;
  const e = new EmbedBuilder().setColor(color).setTitle(truncate(f.title, 256)).setDescription(truncate(d, 4096)).setTimestamp();
  if (image) e.setImage(image);
  return e;
}

/** Builds the message body (without any role ping). */
function buildPayload(rawFields, color = '#9146FF', image) {
  const f = normalizeFields(rawFields);

  if (f.style === 'plain') {
    const embeds = image ? [new EmbedBuilder().setColor(color).setImage(image)] : [];
    return { content: truncate(f.message, 1900), embeds, components: [] };
  }

  if (f.style === 'text') {
    const e = new EmbedBuilder().setColor(color).setDescription(truncate(f.message, 4096)).setTimestamp();
    if (f.title) e.setTitle(truncate(f.title, 256));
    if (image) e.setImage(image);
    const btn = parseButton(f.button);
    const components = btn
      ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(btn.label).setURL(btn.url))]
      : [];
    return { embeds: [e], components };
  }

  return { embeds: [eventEmbed(f, color, image)], components: [] };
}

/** Full message including the optional role ping, ready for send() or edit(). */
function composeMessage(fields, color, image, roleId) {
  const p = buildPayload(fields, color, image);
  const content = [roleId ? `<@&${roleId}>` : '', p.content ?? ''].filter(Boolean).join('\n') || undefined;
  return {
    content, embeds: p.embeds, components: p.components,
    allowedMentions: roleId ? { roles: [roleId] } : { parse: [] },
  };
}

/** One-line description used in lists. */
function summarize(rawFields) {
  const f = normalizeFields(rawFields);
  return truncate(f.title || f.message || f.introduction || '(untitled)', 60).replace(/\n/g, ' ');
}

async function sendAnnouncement(client, { guildId, channelId, roleId, fields, color, image, authorId }) {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased()) throw new Error('Channel not found or not text-based.');

  const msg = await channel.send(composeMessage(fields, color, image, roleId));
  if (channel.type === ChannelType.GuildAnnouncement) {
    try { await msg.crosspost(); } catch { /* already published or no permission */ }
  }

  db.prepare(`INSERT INTO announcements (guild_id, channel_id, message_id, author_id, data, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(guildId, channelId, msg.id, authorId ?? null, JSON.stringify({ fields, color, image, roleId }), Date.now());

  await logToGuild(client, guildId, `📢 Announcement **${summarize(fields)}** posted in <#${channelId}>${authorId ? ` by <@${authorId}>` : ' (scheduled)'}.`);
  return msg;
}

module.exports = { STYLES, normalizeFields, buildPayload, composeMessage, summarize, sendAnnouncement };
