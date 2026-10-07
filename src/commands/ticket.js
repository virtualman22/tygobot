const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { db, getSettings } = require('../db');
const { eph, isMod, logToGuild, truncate, ts } = require('../utils');

const P = PermissionFlagsBits;

// claim: true -> the ticket gets "Submit claim details" + "Mark as paid" buttons
const CATEGORIES = {
  giveaway: {
    label: 'Giveaway Claim', emoji: '🎁', style: ButtonStyle.Success, channel: 'giveaway', claim: true,
    help: 'Congrats on winning! Press **Submit claim details** below and fill in what you won, the amount, your crypto address and your Stake username.',
  },
  milestone: {
    label: 'Milestones', emoji: '🏆', style: ButtonStyle.Primary, channel: 'milestone', claim: false,
    help: 'Please tell us:\n• Which milestone you reached\n• Proof (screenshot or link)\n• Your username',
  },
  tech: {
    label: 'Technical Assistance', emoji: '🛠️', style: ButtonStyle.Secondary, channel: 'support', claim: false,
    help: 'Please describe:\n• What is going wrong\n• What you expected to happen\n• Screenshots or error messages, if any',
  },
  bonus: {
    label: 'Bonuses', emoji: '💰', style: ButtonStyle.Primary, channel: 'bonus', claim: true,
    help: 'Press **Submit claim details** below and fill in which bonus it is, the amount, your crypto address and your Stake username.',
  },
};

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

// ---------- claim details ----------

function claimModal(v = {}) {
  const f = (id, label, ph, max) => {
    const t = new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(ph)
      .setStyle(TextInputStyle.Short).setMaxLength(max).setRequired(true);
    if (v[id]) t.setValue(String(v[id]).slice(0, max));
    return new ActionRowBuilder().addComponents(t);
  };
  return new ModalBuilder().setCustomId('tkclaim').setTitle('Claim details').addComponents(
    f('what', 'What did you win?', 'e.g. Weekly giveaway / Deposit bonus', 150),
    f('amount', 'How much?', 'e.g. $25 or 0.001 BTC', 60),
    f('address', 'Crypto address', 'Double check it — payments cannot be reversed', 200),
    f('stake_user', 'Stake username', 'Your exact Stake username', 80),
  );
}

function claimEmbed(c, row) {
  const paid = Boolean(row.paid);
  return new EmbedBuilder().setColor(paid ? '#2ECC71' : '#F1C40F')
    .setTitle(`${c.emoji} ${c.label} — claim details`)
    .addFields(
      { name: 'What they won', value: truncate(row.what, 1024) },
      { name: 'How much', value: truncate(row.amount, 1024), inline: true },
      { name: 'Stake username', value: truncate(row.stake_user, 1024), inline: true },
      { name: 'Member', value: `<@${row.user_id}>`, inline: true },
      { name: 'Crypto address', value: `\`\`\`${row.address.replace(/`/g, '')}\`\`\`` },
      { name: 'Status', value: paid ? `✅ **Paid** by <@${row.paid_by}> ${ts(row.paid_at, 'R')}` : '⏳ Waiting for payment' },
    )
    .setFooter({ text: `Rewards tracker entry #${row.reward_id}` });
}

const claimRow = paid => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('tk:paid').setLabel(paid ? 'Paid' : 'Mark as paid').setEmoji('✅')
    .setStyle(ButtonStyle.Success).setDisabled(paid),
  new ButtonBuilder().setCustomId('tk:details').setLabel('Edit details').setStyle(ButtonStyle.Secondary).setDisabled(paid),
);

// ---------- buttons ----------

const buttons = {
  async tk(interaction, [action, cat]) {
    const guild = interaction.guild;

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
        { id: me, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.ManageChannels] },
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
          ...(c.claim ? [new ButtonBuilder().setCustomId('tk:details').setLabel('Submit claim details').setEmoji('📝').setStyle(ButtonStyle.Primary)] : []),
          new ButtonBuilder().setCustomId('tk:close').setLabel('Close ticket').setStyle(ButtonStyle.Danger),
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

    if (action === 'details') {
      const info = ticketInfo(interaction.channel.topic);
      if (!info || !CATEGORIES[info.cat]?.claim) return interaction.reply(eph({ content: '❌ Claim details are only for Giveaway Claim and Bonuses tickets.' }));
      if (info.userId !== interaction.user.id && !isMod(interaction)) return interaction.reply(eph({ content: '❌ Only the ticket owner or staff can fill this in.' }));
      const row = db.prepare('SELECT * FROM ticket_claims WHERE channel_id = ?').get(interaction.channelId);
      if (row?.paid) return interaction.reply(eph({ content: '✅ This claim has already been paid.' }));
      return interaction.showModal(claimModal(row ?? {}));
    }

    if (action === 'paid') {
      if (!isMod(interaction)) return interaction.reply(eph({ content: '❌ Only staff can mark a claim as paid.' }));
      const row = db.prepare('SELECT * FROM ticket_claims WHERE channel_id = ?').get(interaction.channelId);
      if (!row) return interaction.reply(eph({ content: '❌ No claim details found in this ticket.' }));
      if (row.paid) return interaction.reply(eph({ content: 'Already marked as paid.' }));

      const now = Date.now();
      db.prepare('UPDATE ticket_claims SET paid = 1, paid_by = ?, paid_at = ? WHERE channel_id = ?').run(interaction.user.id, now, row.channel_id);
      db.prepare("UPDATE rewards SET status = 'Paid', updated_at = ? WHERE id = ?").run(now, row.reward_id);
      const fresh = db.prepare('SELECT * FROM ticket_claims WHERE channel_id = ?').get(row.channel_id);

      await interaction.update({ embeds: [claimEmbed(CATEGORIES[row.category], fresh)], components: [claimRow(true)] });
      await interaction.followUp({
        content: `✅ <@${row.user_id}> your payment of **${row.amount}** has been sent. Thanks! You can close this ticket.`,
        allowedMentions: { users: [row.user_id] },
      });
      await logToGuild(interaction.client, guild.id, `💸 <@${interaction.user.id}> marked **${row.amount}** (${row.stake_user}) as paid. Rewards entry #${row.reward_id}.`);
      return;
    }

    if (action === 'close') {
      const info = ticketInfo(interaction.channel.topic);
      if (!info) return interaction.reply(eph({ content: '❌ This isn\'t a ticket channel.' }));
      if (info.userId !== interaction.user.id && !isMod(interaction)) {
        return interaction.reply(eph({ content: '❌ Only staff or the ticket owner can close this.' }));
      }
      const claim = db.prepare('SELECT paid FROM ticket_claims WHERE channel_id = ?').get(interaction.channelId);
      if (claim && !claim.paid && !isMod(interaction)) {
        return interaction.reply(eph({ content: '⚠️ Your claim hasn\'t been paid yet. Please wait for staff before closing.' }));
      }
      await interaction.reply('🔒 Closing this ticket in 5 seconds…');
      await logToGuild(interaction.client, guild.id, `🎫 Ticket **${interaction.channel.name}** closed by <@${interaction.user.id}>.`);
      setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
    }
  },
};

// ---------- modal ----------

const modals = {
  async tkclaim(interaction) {
    const info = ticketInfo(interaction.channel?.topic);
    const c = info && CATEGORIES[info.cat];
    if (!c?.claim) return interaction.reply(eph({ content: '❌ This isn\'t a claim ticket.' }));
    if (info.userId !== interaction.user.id && !isMod(interaction)) return interaction.reply(eph({ content: '❌ Only the ticket owner or staff can do that.' }));

    const v = id => interaction.fields.getTextInputValue(id).trim();
    const f = { what: v('what'), amount: v('amount'), address: v('address'), stake_user: v('stake_user') };
    const notes = `Crypto address: ${f.address}\nDiscord: <@${info.userId}>\nTicket: <#${interaction.channelId}>`;
    const rewardText = truncate(`${f.what} (${f.amount})`, 200);
    const now = Date.now();

    let row = db.prepare('SELECT * FROM ticket_claims WHERE channel_id = ?').get(interaction.channelId);
    if (row?.paid) return interaction.reply(eph({ content: '✅ This claim has already been paid.' }));

    if (row) { // update details before payment
      db.prepare('UPDATE rewards SET username = ?, reward = ?, notes = ?, updated_at = ? WHERE id = ?').run(f.stake_user, rewardText, notes, now, row.reward_id);
      db.prepare('UPDATE ticket_claims SET what = ?, amount = ?, address = ?, stake_user = ? WHERE channel_id = ?')
        .run(f.what, f.amount, f.address, f.stake_user, row.channel_id);
      row = db.prepare('SELECT * FROM ticket_claims WHERE channel_id = ?').get(row.channel_id);
      try {
        const old = await interaction.channel.messages.fetch(row.message_id);
        await old.edit({ embeds: [claimEmbed(c, row)], components: [claimRow(false)] });
      } catch { /* old message was deleted */ }
      return interaction.reply(eph({ content: '✅ Claim details updated.' }));
    }

    const res = db.prepare(`INSERT INTO rewards (guild_id, label, username, reward, notes, status, created_by, created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, 'Pending', ?, ?, ?)`)
      .run(interaction.guildId, c.label, f.stake_user, rewardText, notes, info.userId, now, now);

    const draft = { ...f, channel_id: interaction.channelId, user_id: info.userId, category: info.cat, reward_id: Number(res.lastInsertRowid), paid: 0 };
    await interaction.reply({ embeds: [claimEmbed(c, draft)], components: [claimRow(false)] });
    const msg = await interaction.fetchReply();
    db.prepare(`INSERT INTO ticket_claims (channel_id, guild_id, user_id, category, what, amount, address, stake_user, reward_id, message_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(interaction.channelId, interaction.guildId, info.userId, info.cat, f.what, f.amount, f.address, f.stake_user, draft.reward_id, msg.id);

    await logToGuild(interaction.client, interaction.guildId, `📝 New **${c.label}** claim from <@${info.userId}>: ${f.amount} (${f.stake_user}). Rewards entry #${draft.reward_id}.`);
  },
};

module.exports = { data, execute, buttons, modals };
