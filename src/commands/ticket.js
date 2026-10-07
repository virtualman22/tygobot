const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { db, getSettings } = require('../db');
const { eph, isMod, logToGuild, truncate, ts } = require('../utils');

const P = PermissionFlagsBits;

// claim: true      -> "Submit claim details" form is available
// screenshot: true -> member is asked to upload a screenshot
const CATEGORIES = {
  giveaway: {
    label: 'Giveaway Claim', emoji: '🎁', style: ButtonStyle.Success, channel: 'giveaway', claim: true,
    whatName: 'What they won', whatLabel: 'What did you win?', whatPh: 'e.g. Weekly giveaway', amountPh: 'e.g. $25 or 0.001 BTC',
    help: 'Congrats on winning! Press **Submit claim details** below and fill in what you won, the amount, your crypto address and your Stake username.',
  },
  milestone: {
    label: 'Milestones', emoji: '🏆', style: ButtonStyle.Primary, channel: 'milestone', claim: true, screenshot: true,
    whatName: 'Milestone', whatLabel: 'Which milestone did you hit?', whatPh: 'e.g. $10,000 wagered', amountPh: 'Reward amount, e.g. $25',
    help: 'Press **Submit claim details** below and fill in the milestone you hit, the reward amount, your crypto address and your Stake username.\nThen **upload your screenshot in this chat** (or use `/screenshot`).',
  },
  tech: {
    label: 'Technical Assistance', emoji: '🛠️', style: ButtonStyle.Secondary, channel: 'support', claim: false,
    help: 'Please describe:\n• What is going wrong\n• What you expected to happen\n• Screenshots or error messages, if any',
  },
  bonus: {
    label: 'Bonuses', emoji: '💰', style: ButtonStyle.Primary, channel: 'bonus', claim: true,
    whatName: 'Bonus', whatLabel: 'Which bonus is this for?', whatPh: 'e.g. Weekly reload bonus', amountPh: 'e.g. $25 or 0.001 BTC',
    help: 'Press **Submit claim details** below and fill in which bonus it is, the amount, your crypto address and your Stake username.',
  },
};
const SCREENSHOT_CATEGORIES = Object.keys(CATEGORIES).filter(k => CATEGORIES[k].screenshot);

const data = new SlashCommandBuilder()
  .setName('ticket')
  .setDescription('Support tickets')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addSubcommand(s => s.setName('panel').setDescription('Post the ticket panel (4 category buttons) in this channel')
    .addStringOption(o => o.setName('title').setDescription('Panel title').setMaxLength(100))
    .addStringOption(o => o.setName('description').setDescription('Panel text').setMaxLength(500)));

async function execute(interaction) {
  const row = new ActionRowBuilder().addComponents(Object.entries(CATEGORIES).map(([key, c]) =>
    new ButtonBuilder().setCustomId(`tk:open:${key}`).setLabel(c.label).setEmoji(c.emoji).setStyle(c.style)));
  const intro = interaction.options.getString('description')
    ?? 'Pick the option that fits your request and a private channel will open for you and our staff.';
  await interaction.channel.send({
    embeds: [new EmbedBuilder().setColor('#9146FF').setTitle(interaction.options.getString('title') ?? '🎫 Open a ticket')
      .setDescription(`${intro}\n\n${Object.values(CATEGORIES).map(c => `${c.emoji} **${c.label}**`).join('\n')}`)],
    components: [row],
  });
  return interaction.reply(eph({ content: '✅ Ticket panel posted.' }));
}

const ticketInfo = topic => {
  const [tag, userId, cat] = String(topic ?? '').split(':');
  return tag === 'ticket' ? { userId, cat } : null;
};

/** Where claim cards from normal (non-ticket) chats go: a private staff channel. */
const cardDestination = guildId => {
  const s = getSettings(guildId);
  return s.claims_channel || s.log_channel || null;
};

// ---------- claim form ----------

function claimModal(cat, claimId, v = {}) {
  const c = CATEGORIES[cat];
  const f = (id, label, ph, max) => {
    const t = new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(ph)
      .setStyle(TextInputStyle.Short).setMaxLength(max).setRequired(true);
    if (v[id]) t.setValue(String(v[id]).slice(0, max));
    return new ActionRowBuilder().addComponents(t);
  };
  return new ModalBuilder().setCustomId(`tkclaim:${cat}:${claimId}`).setTitle(`${c.label} — details`).addComponents(
    f('what', c.whatLabel, c.whatPh, 150),
    f('amount', 'How much?', c.amountPh, 60),
    f('address', 'Crypto address', 'Double check it — payments cannot be reversed', 200),
    f('stake_user', 'Stake username', 'Your exact Stake username', 80),
  );
}

function claimEmbed(row) {
  const c = CATEGORIES[row.category];
  const paid = Boolean(row.paid);
  const fields = [
    { name: c.whatName, value: truncate(row.what, 1024) },
    { name: 'How much', value: truncate(row.amount, 1024), inline: true },
    { name: 'Stake username', value: truncate(row.stake_user, 1024), inline: true },
    { name: 'Member', value: `<@${row.user_id}>`, inline: true },
  ];
  if (row.channel_id !== row.card_channel_id) fields.push({ name: 'Submitted in', value: `<#${row.channel_id}>`, inline: true });
  fields.push({ name: 'Crypto address', value: `\`\`\`${row.address.replace(/`/g, '')}\`\`\`` });
  if (c.screenshot) {
    fields.push({
      name: 'Screenshot',
      value: row.screenshot ? `📎 [View screenshot](${row.screenshot})` : `⏳ Not uploaded yet — the member can post it in <#${row.channel_id}> or use \`/screenshot\``,
    });
  }
  fields.push({ name: 'Status', value: paid ? `✅ **Paid** by <@${row.paid_by}> ${ts(row.paid_at, 'R')}` : '⏳ Waiting for payment' });
  return new EmbedBuilder().setColor(paid ? '#2ECC71' : '#F1C40F')
    .setTitle(`${c.emoji} ${c.label} — claim details`).addFields(fields)
    .setFooter({ text: `Rewards tracker entry #${row.reward_id}` });
}

const claimRow = paid => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('tk:paid').setLabel(paid ? 'Paid' : 'Mark as paid').setEmoji('✅')
    .setStyle(ButtonStyle.Success).setDisabled(paid),
  new ButtonBuilder().setCustomId('tk:edit').setLabel('Edit details').setStyle(ButtonStyle.Secondary).setDisabled(paid),
);

const claimNotes = (r) =>
  `Crypto address: ${r.address}\nDiscord: <@${r.user_id}>\nSubmitted in: <#${r.channel_id}>${r.screenshot ? `\nScreenshot: ${r.screenshot}` : ''}`;

async function refreshCard(client, row) {
  try {
    const ch = await client.channels.fetch(row.card_channel_id);
    const msg = await ch.messages.fetch(row.message_id);
    await msg.edit({ embeds: [claimEmbed(row)], components: [claimRow(Boolean(row.paid))] });
  } catch { /* card was deleted */ }
}

/** Saves a screenshot link on a claim, updates its card and the rewards tracker. */
async function attachScreenshot(client, claim, url) {
  db.prepare('UPDATE claims SET screenshot = ? WHERE id = ?').run(url, claim.id);
  const row = db.prepare('SELECT * FROM claims WHERE id = ?').get(claim.id);
  db.prepare('UPDATE rewards SET notes = ?, updated_at = ? WHERE id = ?').run(claimNotes(row), Date.now(), row.reward_id);
  await refreshCard(client, row);
}

// ---------- buttons ----------

const buttons = {
  async tk(interaction, [action, cat]) {
    const guild = interaction.guild;
    const byCard = () => db.prepare('SELECT * FROM claims WHERE message_id = ?').get(interaction.message.id);

    if (action === 'open') {
      const c = CATEGORIES[cat];
      if (!c) return interaction.reply(eph({ content: '❌ Unknown ticket type.' }));

      const existing = guild.channels.cache.find(ch => ch.topic === `ticket:${interaction.user.id}:${cat}`);
      if (existing) return interaction.reply(eph({ content: `You already have an open **${c.label}** ticket: ${existing}` }));

      const s = getSettings(guild.id);
      const me = interaction.client.user.id;
      const overwrites = [
        { id: guild.id, deny: [P.ViewChannel] },
        { id: interaction.user.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles] },
        { id: me, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageChannels, P.AttachFiles] },
      ];
      if (s.mod_role) overwrites.push({ id: s.mod_role, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageMessages] });

      try {
        const name = `${c.channel}-${interaction.user.username.toLowerCase().replace(/[^a-z0-9_-]/g, '')}`.slice(0, 90);
        const ch = await guild.channels.create({
          name, type: ChannelType.GuildText, parent: s.ticket_category || undefined,
          topic: `ticket:${interaction.user.id}:${cat}`, permissionOverwrites: overwrites,
        });
        const buttonsRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('tk:claim').setLabel('Claim').setStyle(ButtonStyle.Success),
          ...(c.claim ? [new ButtonBuilder().setCustomId(`tk:details:${cat}`).setLabel('Submit claim details').setEmoji('📝').setStyle(ButtonStyle.Primary)] : []),
          new ButtonBuilder().setCustomId('tk:close').setLabel('Close ticket (staff)').setStyle(ButtonStyle.Danger),
        );
        await ch.send({
          content: `<@${interaction.user.id}>${s.mod_role ? ` <@&${s.mod_role}>` : ''}`,
          embeds: [new EmbedBuilder().setColor('#9146FF').setTitle(`${c.emoji} ${c.label}`).setDescription(`${c.help}\n\nA staff member will be with you soon.`)],
          components: [buttonsRow],
          allowedMentions: { users: [interaction.user.id], roles: s.mod_role ? [s.mod_role] : [] },
        });
        await logToGuild(interaction.client, guild.id, `🎫 **${c.label}** ticket opened by <@${interaction.user.id}>: ${ch}`);
        return interaction.reply(eph({ content: `✅ Your ticket is ready: ${ch}` }));
      } catch (e) {
        return interaction.reply(eph({ content: `❌ Couldn't create the ticket (I need the Manage Channels permission): ${e.message}` }));
      }
    }

    if (action === 'claim') {
      if (!isMod(interaction)) return interaction.reply(eph({ content: '❌ Only staff can claim tickets.' }));
      return interaction.reply({ content: `🙋 <@${interaction.user.id}> is handling this ticket.`, allowedMentions: { parse: [] } });
    }

    // "Submit claim details": works in tickets and in any chat where a mod posted /claimform
    if (action === 'details') {
      const info = ticketInfo(interaction.channel.topic);
      const key = cat ?? info?.cat;
      if (!CATEGORIES[key]?.claim) return interaction.reply(eph({ content: '❌ Claim details aren\'t available here.' }));
      if (info && info.userId !== interaction.user.id && !isMod(interaction)) {
        return interaction.reply(eph({ content: '❌ Only the ticket owner or staff can fill this in.' }));
      }
      if (!info && !cardDestination(guild.id)) {
        return interaction.reply(eph({ content: '❌ Staff haven\'t set a claims channel yet. Please ask a mod to run `/setup set claims_channel`.' }));
      }
      return interaction.showModal(claimModal(key, 0));
    }

    if (action === 'edit') {
      const claim = byCard();
      if (!claim) return interaction.reply(eph({ content: '❌ Claim not found.' }));
      if (claim.paid) return interaction.reply(eph({ content: '✅ This claim has already been paid.' }));
      if (claim.user_id !== interaction.user.id && !isMod(interaction)) return interaction.reply(eph({ content: '❌ Only the member or staff can edit this.' }));
      return interaction.showModal(claimModal(claim.category, claim.id, claim));
    }

    if (action === 'paid') {
      if (!isMod(interaction)) return interaction.reply(eph({ content: '❌ Only staff can mark a claim as paid.' }));
      const claim = byCard();
      if (!claim) return interaction.reply(eph({ content: '❌ No claim found for this card.' }));
      if (claim.paid) return interaction.reply(eph({ content: 'Already marked as paid.' }));

      const now = Date.now();
      db.prepare('UPDATE claims SET paid = 1, paid_by = ?, paid_at = ? WHERE id = ?').run(interaction.user.id, now, claim.id);
      db.prepare("UPDATE rewards SET status = 'Paid', updated_at = ? WHERE id = ?").run(now, claim.reward_id);
      const fresh = db.prepare('SELECT * FROM claims WHERE id = ?').get(claim.id);

      await interaction.update({ embeds: [claimEmbed(fresh)], components: [claimRow(true)] });

      const note = `✅ <@${claim.user_id}> your payment of **${claim.amount}** has been sent. Thanks!`;
      if (claim.channel_id === claim.card_channel_id) {
        await interaction.followUp({ content: `${note} A mod can close this ticket now.`, allowedMentions: { users: [claim.user_id] } });
      } else {
        try {
          const origin = await interaction.client.channels.fetch(claim.channel_id);
          await origin.send({ content: note, allowedMentions: { users: [claim.user_id] } });
          await interaction.followUp(eph({ content: `✅ Marked as paid. I told the member in <#${claim.channel_id}>.` }));
        } catch {
          await interaction.followUp(eph({ content: '✅ Marked as paid, but I couldn\'t notify the member in their channel.' }));
        }
      }
      await logToGuild(interaction.client, guild.id, `💸 <@${interaction.user.id}> marked **${claim.amount}** (${claim.stake_user}) as paid. Rewards entry #${claim.reward_id}.`);
      return;
    }

    if (action === 'close') {
      if (!isMod(interaction)) return interaction.reply(eph({ content: '❌ Only staff can close tickets.' }));
      if (!ticketInfo(interaction.channel.topic)) return interaction.reply(eph({ content: '❌ This isn\'t a ticket channel.' }));
      await interaction.reply('🔒 Closing this ticket in 5 seconds…');
      await logToGuild(interaction.client, guild.id, `🎫 Ticket **${interaction.channel.name}** closed by <@${interaction.user.id}>.`);
      setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
    }
  },
};

// ---------- modal ----------

const modals = {
  async tkclaim(interaction, [cat, claimIdStr]) {
    const c = CATEGORIES[cat];
    if (!c?.claim) return interaction.reply(eph({ content: '❌ Unknown claim type.' }));
    const claimId = Number(claimIdStr);
    const info = ticketInfo(interaction.channel?.topic);

    const v = id => interaction.fields.getTextInputValue(id).trim();
    const f = { what: v('what'), amount: v('amount'), address: v('address'), stake_user: v('stake_user') };
    const now = Date.now();

    // ----- editing an existing claim -----
    if (claimId) {
      const row = db.prepare('SELECT * FROM claims WHERE id = ? AND guild_id = ?').get(claimId, interaction.guildId);
      if (!row) return interaction.reply(eph({ content: '❌ Claim not found.' }));
      if (row.paid) return interaction.reply(eph({ content: '✅ This claim has already been paid.' }));
      if (row.user_id !== interaction.user.id && !isMod(interaction)) return interaction.reply(eph({ content: '❌ Not allowed.' }));
      db.prepare('UPDATE claims SET what = ?, amount = ?, address = ?, stake_user = ? WHERE id = ?').run(f.what, f.amount, f.address, f.stake_user, row.id);
      const fresh = db.prepare('SELECT * FROM claims WHERE id = ?').get(row.id);
      db.prepare('UPDATE rewards SET username = ?, reward = ?, notes = ?, updated_at = ? WHERE id = ?')
        .run(f.stake_user, truncate(`${f.what} (${f.amount})`, 200), claimNotes(fresh), now, row.reward_id);
      await refreshCard(interaction.client, fresh);
      return interaction.reply(eph({ content: '✅ Claim details updated.' }));
    }

    // ----- new claim -----
    if (info && info.userId !== interaction.user.id && !isMod(interaction)) {
      return interaction.reply(eph({ content: '❌ Only the ticket owner or staff can do that.' }));
    }
    const userId = info ? info.userId : interaction.user.id;
    const destId = info ? interaction.channelId : cardDestination(interaction.guildId);
    if (!destId) return interaction.reply(eph({ content: '❌ Staff haven\'t set a claims channel yet (`/setup set claims_channel`).' }));

    const draft = { ...f, guild_id: interaction.guildId, channel_id: interaction.channelId, user_id: userId, category: cat, card_channel_id: destId, paid: 0, screenshot: null };
    const res = db.prepare(`INSERT INTO rewards (guild_id, label, username, reward, notes, status, created_by, created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, 'Pending', ?, ?, ?)`)
      .run(interaction.guildId, c.label, f.stake_user, truncate(`${f.what} (${f.amount})`, 200), claimNotes(draft), userId, now, now);
    draft.reward_id = Number(res.lastInsertRowid);

    let msg;
    try {
      const dest = await interaction.client.channels.fetch(destId);
      msg = await dest.send({ embeds: [claimEmbed(draft)], components: [claimRow(false)] });
    } catch (e) {
      db.prepare('DELETE FROM rewards WHERE id = ?').run(draft.reward_id);
      return interaction.reply(eph({ content: `❌ I couldn't post your claim to the staff channel (${e.message}). Please tell a mod.` }));
    }

    db.prepare(`INSERT INTO claims (guild_id, channel_id, user_id, category, what, amount, address, stake_user, reward_id, card_channel_id, message_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(interaction.guildId, interaction.channelId, userId, cat, f.what, f.amount, f.address, f.stake_user, draft.reward_id, destId, msg.id);

    await logToGuild(interaction.client, interaction.guildId, `📝 New **${c.label}** claim from <@${userId}>: ${f.amount} (${f.stake_user}). Rewards entry #${draft.reward_id}.`);

    const shot = c.screenshot ? '\n📎 **Now upload your screenshot in this chat** (or use `/screenshot`).' : '';
    return interaction.reply(eph({ content: `✅ Your details were submitted${info ? ' above' : ' to staff'}.${shot}` }));
  },
};

module.exports = { data, execute, buttons, modals, CATEGORIES, SCREENSHOT_CATEGORIES, attachScreenshot };
