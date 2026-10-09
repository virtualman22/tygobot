const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { db, getSettings } = require('../db');
const { eph, isMod, requireMod, logToGuild, truncate, ts } = require('../utils');

const P = PermissionFlagsBits;

// claim: true      -> "Submit claim details" form is available
// screenshot: true -> member is asked to upload a screenshot
const CATEGORIES = {
  giveaway: {
    label: 'Giveaway Claim', category: 'Giveaway Claims', emoji: '🎁', style: ButtonStyle.Success, channel: 'giveaway', claim: true,
    whatName: 'What they won', whatLabel: 'What did you win?', whatPh: 'e.g. Weekly giveaway', amountPh: 'e.g. $25 or 0.001 BTC',
    help: 'Congrats on winning! Press **Submit claim details** below and fill in what you won, the amount, your USDT ETH address and your Stake username.',
  },
  milestone: {
    label: 'Milestones', category: 'Milestones', emoji: '🏆', style: ButtonStyle.Primary, channel: 'milestone', claim: true, screenshot: true,
    whatName: 'Milestone', whatLabel: 'Which milestone did you hit?', whatPh: 'e.g. $10,000 wagered', amountPh: 'Reward amount, e.g. $25',
    help: 'Press **Submit claim details** below and fill in the milestone you hit, the reward amount, your USDT ETH address and your Stake username.\nThen **upload your screenshot in this chat** (or use `/screenshot`).',
  },
  tech: {
    label: 'Technical Assistance', category: 'Technical Assistance', emoji: '🛠️', style: ButtonStyle.Secondary, channel: 'support', claim: false,
    help: 'Please describe:\n• What is going wrong\n• What you expected to happen\n• Screenshots or error messages, if any',
  },
  bonus: {
    label: 'Bonuses', category: 'Bonuses', emoji: '💰', style: ButtonStyle.Primary, channel: 'bonus', claim: true,
    whatName: 'Bonus', whatLabel: 'Which bonus is this for?', whatPh: 'e.g. Weekly reload bonus', amountPh: 'e.g. $25 or 0.001 BTC',
    help: 'Press **Submit claim details** below and fill in which bonus it is, the amount, your USDT ETH address and your Stake username.',
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

/** Every submitted claim form goes to the claims channel (/setup set claims_channel) and nowhere else. */
const cardDestination = guildId => getSettings(guildId).claims_channel || null;

// ---------- one Discord category per ticket type ----------

const normName = n => String(n ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const pendingCategories = new Map();

/** Finds the server category for a ticket type (e.g. "Bonuses"), creating it (private) if it doesn't exist yet. */
async function ticketParent(guild, c, s) {
  const key = `${guild.id}:${c.category}`;
  if (pendingCategories.has(key)) return pendingCategories.get(key);
  const job = (async () => {
    const channels = await guild.channels.fetch();
    const want = normName(c.category);
    const found = channels.find(ch => ch?.type === ChannelType.GuildCategory && normName(ch.name) === want);
    if (found) return found;
    const overwrites = [
      { id: guild.id, deny: [P.ViewChannel] },
      { id: guild.client.user.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageChannels] },
    ];
    if (s.mod_role) overwrites.push({ id: s.mod_role, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageMessages] });
    return guild.channels.create({ name: c.category, type: ChannelType.GuildCategory, permissionOverwrites: overwrites });
  })();
  pendingCategories.set(key, job);
  try { return await job; } finally { pendingCategories.delete(key); }
}

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
    f('address', 'USDT ETH address', 'USDT on Ethereum (ERC-20) — double check, payments can\'t be reversed', 200),
    f('stake_user', 'Stake username', 'Your exact Stake username', 80),
  );
}

function claimEmbed(row) {
  const c = CATEGORIES[row.category];
  const paid = Boolean(row.paid);
  const dq = Boolean(row.disqualified);
  const fields = [
    { name: c.whatName, value: truncate(row.what, 1024) },
    { name: 'How much', value: truncate(row.amount, 1024), inline: true },
    { name: 'Stake username', value: truncate(row.stake_user, 1024), inline: true },
    { name: 'Member', value: `<@${row.user_id}>`, inline: true },
  ];
  if (row.channel_id !== row.card_channel_id) fields.push({ name: 'Submitted in', value: `<#${row.channel_id}>`, inline: true });
  fields.push({ name: 'USDT ETH address', value: `\`\`\`${row.address.replace(/`/g, '')}\`\`\`` });
  if (c.screenshot) {
    fields.push({
      name: 'Screenshot',
      value: row.screenshot ? `📎 [View screenshot](${row.screenshot})` : `⏳ Not uploaded yet — the member can post it in <#${row.channel_id}> or use \`/screenshot\``,
    });
  }
  fields.push({
    name: 'Status',
    value: dq
      ? `🚫 **Disqualified** by <@${row.dq_by}> ${ts(row.dq_at, 'R')}${row.dq_reason ? `\nReason: ${truncate(row.dq_reason, 500)}` : ''}`
      : paid ? `✅ **Paid** by <@${row.paid_by}> ${ts(row.paid_at, 'R')}` : '⏳ Waiting for payment',
  });
  return new EmbedBuilder().setColor(dq ? '#E74C3C' : paid ? '#2ECC71' : '#F1C40F')
    .setTitle(`${c.emoji} ${c.label} — claim details`).addFields(fields)
    .setFooter({ text: `Rewards tracker entry #${row.reward_id}` });
}

/** Card buttons: Mark as paid · Edit details · Disqualify. All lock once the claim is paid or disqualified. */
const claimRow = (paid, dq = false) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('tk:paid').setLabel(paid ? 'Paid' : 'Mark as paid').setEmoji('✅')
    .setStyle(ButtonStyle.Success).setDisabled(paid || dq),
  new ButtonBuilder().setCustomId('tk:edit').setLabel('Edit details').setStyle(ButtonStyle.Secondary).setDisabled(paid || dq),
  new ButtonBuilder().setCustomId('tk:dq').setLabel(dq ? 'Disqualified' : 'Disqualify').setEmoji('🚫')
    .setStyle(ButtonStyle.Danger).setDisabled(paid || dq),
);

const claimNotes = (r) =>
  `USDT ETH address: ${r.address}\nDiscord: <@${r.user_id}>\nSubmitted in: <#${r.channel_id}>${r.screenshot ? `\nScreenshot: ${r.screenshot}` : ''}`;

async function refreshCard(client, row) {
  try {
    const ch = await client.channels.fetch(row.card_channel_id);
    const msg = await ch.messages.fetch(row.message_id);
    await msg.edit({ embeds: [claimEmbed(row)], components: [claimRow(Boolean(row.paid), Boolean(row.disqualified))] });
  } catch { /* card was deleted */ }
}

/** Marks a claim (and its rewards-tracker entry) as paid, updates the card and tells the member where they submitted it. */
async function payClaim(client, claim, userId) {
  const now = Date.now();
  db.prepare('UPDATE claims SET paid = 1, paid_by = ?, paid_at = ? WHERE id = ?').run(userId, now, claim.id);
  db.prepare("UPDATE rewards SET status = 'Paid', updated_at = ? WHERE id = ?").run(now, claim.reward_id);
  const fresh = db.prepare('SELECT * FROM claims WHERE id = ?').get(claim.id);
  await refreshCard(client, fresh);

  let notified = false;
  let origin = null;
  try {
    origin = await client.channels.fetch(claim.channel_id);
    const isTicket = String(origin.topic ?? '').startsWith('ticket:');
    await origin.send({
      content: `✅ <@${claim.user_id}> your payment of **${claim.amount}** has been sent. Thanks!${isTicket ? ' A mod can close this ticket now.' : ''}`,
      allowedMentions: { users: [claim.user_id] },
    });
    notified = true;
  } catch { /* channel deleted or no access */ }

  // Paid tickets are renamed to paid-<name> so staff can spot them (Discord limits renames to 2 per 10 min, so don't wait on it)
  if (origin && String(origin.topic ?? '').startsWith('ticket:') && !/^paid-/.test(origin.name)) {
    const rest = origin.name.replace(/^[a-z]+-/, '');
    origin.setName(`paid-${rest}`.slice(0, 100)).catch(() => {});
  }

  await logToGuild(client, claim.guild_id, `💸 <@${userId}> marked **${claim.amount}** (${claim.stake_user}) as paid. Rewards entry #${claim.reward_id}.`);
  return { fresh, notified };
}

/** On startup, re-draw cards still waiting for payment so older ones also get the Disqualify button. */
async function refreshOpenCards(client) {
  const rows = db.prepare('SELECT * FROM claims WHERE paid = 0 AND disqualified = 0 AND message_id IS NOT NULL ORDER BY id DESC LIMIT 100').all();
  for (const row of rows) {
    await refreshCard(client, row);
    await new Promise(r => setTimeout(r, 1000));
  }
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
        const parent = await ticketParent(guild, c, s);
        const ch = await guild.channels.create({
          name, type: ChannelType.GuildText, parent: parent.id,
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
      if (!cardDestination(guild.id)) {
        return interaction.reply(eph({ content: '❌ Staff haven\'t set a claims channel yet. Please ask a mod to run `/setup set claims_channel`.' }));
      }
      return interaction.showModal(claimModal(key, 0));
    }

    if (action === 'edit') {
      const claim = byCard();
      if (!claim) return interaction.reply(eph({ content: '❌ Claim not found.' }));
      if (claim.paid) return interaction.reply(eph({ content: '✅ This claim has already been paid.' }));
      if (claim.disqualified) return interaction.reply(eph({ content: '🚫 This claim was disqualified.' }));
      if (claim.user_id !== interaction.user.id && !isMod(interaction)) return interaction.reply(eph({ content: '❌ Only the member or staff can edit this.' }));
      return interaction.showModal(claimModal(claim.category, claim.id, claim));
    }

    if (action === 'paid') {
      if (!isMod(interaction)) return interaction.reply(eph({ content: '❌ Only staff can mark a claim as paid.' }));
      const claim = byCard();
      if (!claim) return interaction.reply(eph({ content: '❌ No claim found for this card.' }));
      if (claim.paid) return interaction.reply(eph({ content: 'Already marked as paid.' }));
      if (claim.disqualified) return interaction.reply(eph({ content: '🚫 This claim was disqualified.' }));

      await interaction.deferUpdate();
      const { notified } = await payClaim(interaction.client, claim, interaction.user.id);
      return interaction.followUp(eph({ content: notified
        ? `✅ Marked as paid. I told the member in <#${claim.channel_id}>.`
        : '✅ Marked as paid, but I couldn\'t notify the member in their channel.' }));
    }

    if (action === 'dq') {
      if (!isMod(interaction)) return interaction.reply(eph({ content: '❌ Only staff can disqualify a claim.' }));
      const claim = byCard();
      if (!claim) return interaction.reply(eph({ content: '❌ No claim found for this card.' }));
      if (claim.paid) return interaction.reply(eph({ content: '✅ This claim is already paid, so it can\'t be disqualified.' }));
      if (claim.disqualified) return interaction.reply(eph({ content: '🚫 Already disqualified.' }));
      return interaction.showModal(new ModalBuilder().setCustomId(`tkdq:${claim.id}`).setTitle('Disqualify this claim').addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason (sent to the member)')
          .setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(false)
          .setPlaceholder('Optional, e.g. Duplicate claim / wrong screenshot'))));
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
      if (row.disqualified) return interaction.reply(eph({ content: '🚫 This claim was disqualified.' }));
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
    const destId = cardDestination(interaction.guildId);
    if (!destId) return interaction.reply(eph({ content: '❌ Staff haven\'t set a claims channel yet (`/setup set claims_channel`).' }));

    // One active submission per member per category: a new one is allowed once the old one is paid or disqualified
    const active = db.prepare('SELECT id FROM claims WHERE guild_id = ? AND user_id = ? AND category = ? AND paid = 0 AND disqualified = 0 LIMIT 1')
      .get(interaction.guildId, userId, cat);
    if (active) {
      return interaction.reply(eph({ content: `❌ ${userId === interaction.user.id ? 'You already have' : 'This member already has'} an active **${c.label}** submission that hasn't been paid yet. `
        + 'Staff are handling it — a new one can be submitted once it is paid or removed. To change the details, ask staff to edit it.' }));
    }

    const draft = { ...f, guild_id: interaction.guildId, channel_id: interaction.channelId, user_id: userId, category: cat, card_channel_id: destId, paid: 0, screenshot: null };
    const res = db.prepare(`INSERT INTO rewards (guild_id, label, username, reward, notes, status, created_by, created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, 'Pending', ?, ?, ?)`)
      .run(interaction.guildId, c.label, f.stake_user, truncate(`${f.what} (${f.amount})`, 200), claimNotes(draft), userId, now, now);
    draft.reward_id = Number(res.lastInsertRowid);
    // Saved before the card is posted, so two quick submissions can't both slip past the check above
    const claimRes = db.prepare(`INSERT INTO claims (guild_id, channel_id, user_id, category, what, amount, address, stake_user, reward_id, card_channel_id)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(interaction.guildId, interaction.channelId, userId, cat, f.what, f.amount, f.address, f.stake_user, draft.reward_id, destId);
    const newClaimId = Number(claimRes.lastInsertRowid);

    await interaction.deferReply(eph());
    try {
      const dest = await interaction.client.channels.fetch(destId);
      const msg = await dest.send({ embeds: [claimEmbed(draft)], components: [claimRow(false)] });
      db.prepare('UPDATE claims SET message_id = ? WHERE id = ?').run(msg.id, newClaimId);
    } catch (e) {
      db.prepare('DELETE FROM claims WHERE id = ?').run(newClaimId);
      db.prepare('DELETE FROM rewards WHERE id = ?').run(draft.reward_id);
      return interaction.editReply({ content: `❌ I couldn't post your claim to the staff channel (${e.message}). Please tell a mod.` });
    }

    const shot = c.screenshot ? '\n📎 **Now upload your screenshot in this chat** (or use `/screenshot`).' : '';
    return interaction.editReply({ content: `✅ Your details were submitted to staff.${shot}` });
  },

  // Staff pressed Disqualify on a claim card and filled in the (optional) reason
  async tkdq(interaction, [claimIdStr]) {
    if (!requireMod(interaction)) return;
    const row = db.prepare('SELECT * FROM claims WHERE id = ? AND guild_id = ?').get(Number(claimIdStr), interaction.guildId);
    if (!row) return interaction.reply(eph({ content: '❌ Claim not found.' }));
    if (row.paid) return interaction.reply(eph({ content: '✅ This claim is already paid, so it can\'t be disqualified.' }));
    if (row.disqualified) return interaction.reply(eph({ content: '🚫 Already disqualified.' }));
    await interaction.deferReply(eph());

    const reason = interaction.fields.getTextInputValue('reason').trim();
    const now = Date.now();
    db.prepare('UPDATE claims SET disqualified = 1, dq_by = ?, dq_reason = ?, dq_at = ? WHERE id = ?').run(interaction.user.id, reason || null, now, row.id);
    db.prepare("UPDATE rewards SET status = 'Cancelled', updated_at = ? WHERE id = ?").run(now, row.reward_id);
    await refreshCard(interaction.client, db.prepare('SELECT * FROM claims WHERE id = ?').get(row.id));

    let notified = false;
    try {
      const origin = await interaction.client.channels.fetch(row.channel_id);
      await origin.send({
        content: `🚫 <@${row.user_id}> your **${CATEGORIES[row.category].label}** claim (**${row.amount}**) was disqualified by staff.${reason ? `\n**Reason:** ${reason}` : ''}`,
        allowedMentions: { users: [row.user_id] },
      });
      notified = true;
    } catch { /* channel deleted or no access */ }

    await logToGuild(interaction.client, interaction.guildId, `🚫 <@${interaction.user.id}> disqualified ${row.stake_user}'s **${row.amount}** claim${reason ? ` (${reason})` : ''}. Rewards entry #${row.reward_id} set to Cancelled.`);
    return interaction.editReply({ content: `🚫 Claim disqualified and the rewards entry is now Cancelled. ${notified ? 'The member was told in their chat.' : 'I couldn\'t reach the member\'s chat.'} They can submit a new claim for this category.` });
  },
};

module.exports = { data, execute, buttons, modals, CATEGORIES, SCREENSHOT_CATEGORIES, attachScreenshot, payClaim, refreshOpenCards };
