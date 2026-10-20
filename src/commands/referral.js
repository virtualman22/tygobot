const { SlashCommandBuilder, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const { eph, isMod, requireMod } = require('../utils');
const bridge = require('../bridge');
const { rewardWhat, money, clip, STATUS, RW_STATUS } = require('../referrals');

// The website keeps the referral program (referrals_lib.php): every subcommand here asks the site, so Discord and the site always agree.
const COLOR = '#1FFF87';
const RULES = '• All referred players must be verified by Stake.\n• No wager abuse or self-referrals (any abuse = immediate disqualification).\n'
  + '• Do not target or poach players from other Stake streamers\' communities.\n• Tygo can void a referral if he sees fit.';

const data = new SlashCommandBuilder()
  .setName('referral')
  .setDescription('Referral program: who referred who, progress and rewards')
  .addSubcommand(s => s.setName('me').setDescription('Your referrals, their progress this month and your rewards'))
  .addSubcommand(s => s.setName('ladder').setDescription('How the referral program pays')
    .addBooleanOption(o => o.setName('public').setDescription('Staff: post it in this channel for everyone')))
  .addSubcommand(s => s.setName('add').setDescription('Staff: register who referred who')
    .addUserOption(o => o.setName('referrer').setDescription('Who brought them in (gets the rewards)').setRequired(true))
    .addUserOption(o => o.setName('referee').setDescription('The new player'))
    .addStringOption(o => o.setName('stake').setDescription('The new player\'s Stake username (not needed if linked on the website)').setMaxLength(32))
    .addBooleanOption(o => o.setName('verified').setDescription('Already verified by Stake? (default: no, verify it later)'))
    .addStringOption(o => o.setName('note').setDescription('Optional note').setMaxLength(200)))
  .addSubcommand(s => s.setName('verify').setDescription('Staff: the referee is verified by Stake, start counting')
    .addIntegerOption(o => o.setName('id').setDescription('Referral #').setRequired(true).setMinValue(1)))
  .addSubcommand(s => s.setName('void').setDescription('Staff: disqualify a referral (its unpaid rewards are voided too)')
    .addIntegerOption(o => o.setName('id').setDescription('Referral #').setRequired(true).setMinValue(1))
    .addStringOption(o => o.setName('reason').setDescription('Why').setMaxLength(200)))
  .addSubcommand(s => s.setName('restore').setDescription('Staff: undo a void')
    .addIntegerOption(o => o.setName('id').setDescription('Referral #').setRequired(true).setMinValue(1)))
  .addSubcommand(s => s.setName('list').setDescription('Staff: registered referrals')
    .addUserOption(o => o.setName('referrer').setDescription('Only this referrer'))
    .addStringOption(o => o.setName('status').setDescription('Only this status')
      .addChoices({ name: 'Waiting for verification', value: 'pending' }, { name: 'Active', value: 'active' }, { name: 'Void', value: 'void' })))
  .addSubcommand(s => s.setName('stats').setDescription('Staff: someone else\'s referrals and rewards')
    .addUserOption(o => o.setName('user').setDescription('The referrer').setRequired(true)))
  .addSubcommand(s => s.setName('rewards').setDescription('Staff: referral rewards (to pay by default)')
    .addStringOption(o => o.setName('status').setDescription('Which ones')
      .addChoices({ name: 'To pay', value: 'pending' }, { name: 'Paid', value: 'paid' }, { name: 'Void', value: 'void' }, { name: 'All', value: 'all' }))
    .addUserOption(o => o.setName('referrer').setDescription('Only this referrer')))
  .addSubcommand(s => s.setName('pay').setDescription('Staff: mark a referral reward as paid')
    .addIntegerOption(o => o.setName('id').setDescription('Reward #').setRequired(true).setMinValue(1))
    .addStringOption(o => o.setName('note').setDescription('Transaction hash or note').setMaxLength(200)))
  .addSubcommand(s => s.setName('check').setDescription('Staff: check the wagers now instead of waiting (normally every 10 minutes)'));

async function ask(body, timeoutMs = 15_000) {
  if (!bridge.enabled()) throw new Error('The website link is off: set SITE_URL and BRIDGE_SECRET.');
  const j = await bridge.api('POST', body, '', timeoutMs);
  if (!j.ok) throw new Error(j.error || 'The website refused that.');
  return j;
}

function ladderEmbed(j) {
  const steps = j.ladder.map(([w, p]) => `• **${money(w)}** ➔ ${money(p)}`).join('\n');
  return new EmbedBuilder().setColor(COLOR).setTitle('🚀 TYGO GAMBLES — Referral program')
    .setDescription('Earn passive income by bringing friends, family or potential highrollers into the server. The more your referrals wager and climb the leaderboards, the more you cash in.')
    .addFields(
      { name: '💵 Monthly weighted wager ladder', value: `${steps}\n${j.basis === 'combined' ? '*All your referrals\' weighted wager counts together.*' : '*Per referral, per leaderboard season. Steps add up: every step reached pays, as soon as it is reached.*'}` },
      { name: '🏆 Bonus', value: `You also get a **${j.cut_pct}% cut** of your referrals' monthly leaderboard cash prizes.` },
      { name: '⚠️ Rules', value: RULES },
      { name: 'How to join', value: 'Bring someone in, then open a ticket so staff can register who you referred. Follow your progress with `/referral me`.' },
    )
    .setFooter({ text: `Current season: ${j.season.label}` });
}

function memberEmbed(j, user) {
  const e = new EmbedBuilder().setColor(COLOR).setTitle(`🤝 ${user.username}'s referrals`).setThumbnail(user.displayAvatarURL());
  if (!j.referrals.length) {
    return e.setDescription('No referrals registered yet.\nBring someone into the server, then open a ticket so staff can register it. See `/referral ladder` for what you can earn.');
  }
  const next = x => (x.next ? `next **${money(x.next[0])}** (${money(x.next[1])}) in ${money(x.next[0] - x.weighted)}` : 'top of the ladder 🎉');
  const lines = j.referrals.slice(0, 20).map(r => {
    if (r.status !== 'active') return `**${clip(r.name, 40)}** · ${STATUS[r.status]}`;
    return j.combined ? `**${clip(r.name, 40)}** · ${money(r.weighted)} weighted` : `**${clip(r.name, 40)}** · ${money(r.weighted)} weighted · ${next(r)}`;
  });
  if (j.referrals.length > 20) lines.push(`…and ${j.referrals.length - 20} more`);
  const data = j.season.data_at ? `wagers from <t:${j.season.data_at}:R>` : 'wagers load within a few minutes';
  let desc = `**${clip(j.season.label, 60)}** · ${data}\nThis season **${money(j.season_earned)}** · To be paid **${money(j.totals.pending)}** · Paid **${money(j.totals.paid)}**`;
  if (j.combined) desc += `\nAll referrals together: **${money(j.combined.weighted)}** weighted · ${next(j.combined)}`;
  e.setDescription(`${desc}\n\n${lines.join('\n')}`);
  if (j.rewards.length) {
    e.addFields({ name: 'Latest rewards', value: j.rewards.slice(0, 6).map(x => `${RW_STATUS[x.status].split(' ')[0]} **${money(x.amount)}** · ${rewardWhat(x)} · ${clip(x.season_label, 30)}`).join('\n').slice(0, 1024) });
  }
  return e.setFooter({ text: `You also get ${j.cut_pct}% of your referrals' leaderboard prizes. Same overview on the website under My Account.` });
}

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const staffOnly = !['me', 'ladder'].includes(sub);
  if (staffOnly && !requireMod(interaction)) return;
  const pub = sub === 'ladder' && interaction.options.getBoolean('public');
  if (pub && !requireMod(interaction)) return;
  await interaction.deferReply(pub ? {} : { flags: 64 });
  const me = interaction.user.id;
  const opt = n => interaction.options.get(n)?.value;

  try {
    if (sub === 'me' || sub === 'stats') {
      const user = sub === 'me' ? interaction.user : interaction.options.getUser('user');
      return interaction.editReply({ embeds: [memberEmbed(await ask({ action: 'ref_me', user_id: user.id }), user)] });
    }
    if (sub === 'ladder') return interaction.editReply({ embeds: [ladderEmbed(await ask({ action: 'ref_info' }))], allowedMentions: { parse: [] } });

    if (sub === 'add') {
      const referrer = interaction.options.getUser('referrer'), referee = interaction.options.getUser('referee');
      if (!referee && !opt('stake')) return interaction.editReply('❌ Give the referee (Discord) and/or their Stake username.');
      const j = await ask({ action: 'ref_add', discord_id: me, referrer_id: referrer.id, referrer_name: referrer.username,
        referee_id: referee?.id ?? '', referee_name: referee?.username ?? '', stake: opt('stake') ?? '', verified: Boolean(opt('verified')), note: opt('note') ?? '' });
      const r = j.referral;
      return interaction.editReply(`✅ Referral **#${r.id}** registered: <@${r.referrer_id}> → **${clip(r.referee_name || r.stake, 40)}** (Stake \`${r.stake}\`).\n`
        + (r.status === 'pending' ? `⏳ It starts earning once it is verified by Stake: \`/referral verify id:${r.id}\` or the button on the staff card.` : '✅ Verified: it counts from the next check (within 10 minutes).'));
    }
    if (sub === 'verify' || sub === 'void' || sub === 'restore') {
      const j = await ask({ action: 'ref_op', discord_id: me, id: opt('id'), op: sub, reason: opt('reason') ?? '' });
      return interaction.editReply(`${{ verify: '✅ Verified', void: '🚫 Voided', restore: '↩️ Restored' }[sub]}: referral **#${j.referral.id}** (${clip(j.referral.referee_name || j.referral.stake, 40)}) is now ${STATUS[j.referral.status]}.`);
    }
    if (sub === 'list') {
      const j = await ask({ action: 'ref_list', referrer_id: interaction.options.getUser('referrer')?.id ?? '', status: opt('status') ?? '' });
      const lines = j.rows.slice(0, 25).map(r => `\`#${r.id}\` <@${r.referrer_id}> → **${clip(r.referee_name || r.stake, 30)}** (\`${clip(r.stake, 30)}\`) · ${STATUS[r.status].split(' ')[0]}`
        + (r.status === 'active' ? ` · ${money(r.weighted)} this season · earned ${money(r.earned)}` : ''));
      if (j.count > 25) lines.push(`…and ${j.count - 25} more on the website (admin → Referrals)`);
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLOR).setTitle(`🤝 Referrals (${j.count})`).setDescription(lines.join('\n') || '*None match.*')
        .setFooter({ text: `Wagers: ${j.live.label}` })], allowedMentions: { parse: [] } });
    }
    if (sub === 'rewards') {
      const st = opt('status') ?? 'pending';
      const j = await ask({ action: 'ref_rewards', status: st === 'all' ? '' : st, referrer_id: interaction.options.getUser('referrer')?.id ?? '' });
      const lines = j.rows.slice(0, 20).map(x => `\`#${x.id}\` ${RW_STATUS[x.status].split(' ')[0]} **${money(x.amount)}** → <@${x.referrer_id}> · ${rewardWhat(x)} · ${clip(x.season_label, 30)}`);
      if (j.count > 20) lines.push(`…and ${j.count - 20} more on the website`);
      const title = { pending: 'to pay', paid: 'paid', void: 'void', all: 'all' }[st];
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLOR).setTitle(`💸 Referral rewards: ${title} (${j.count} · ${money(st === 'pending' ? j.totals.pending : st === 'paid' ? j.totals.paid : st === 'void' ? j.totals.void : j.totals.earned)})`)
        .setDescription(lines.join('\n').slice(0, 4000) || '*Nothing here.*').setFooter({ text: 'Pay with /referral pay id: or the buttons on the staff cards' })], allowedMentions: { parse: [] } });
    }
    if (sub === 'pay') {
      const j = await ask({ action: 'ref_reward', discord_id: me, id: opt('id'), op: 'pay', ref: opt('note') ?? '' });
      return interaction.editReply(`✅ Reward **#${j.reward.id}** (${money(j.reward.amount)} → <@${j.reward.referrer_id}>) marked paid. They get a DM.`);
    }
    if (sub === 'check') {
      const j = await ask({ action: 'ref_check', discord_id: me }, 120_000);
      const res = j.result.skipped ? null : Object.values(j.result);
      if (!res) return interaction.editReply(`ℹ️ Nothing to check: ${j.result.skipped}.`);
      const err = res.find(r => r.error);
      const n = res.reduce((a, r) => a + (r.new || 0), 0);
      return interaction.editReply(err ? `❌ ${err.error}` : n ? `✅ Checked: **${n}** new reward${n === 1 ? '' : 's'} (cards follow in the staff channel).` : '✅ Checked: nothing new.');
    }
  } catch (e) {
    return interaction.editReply(`❌ ${e.message}`);
  }
}

// ───────── buttons + modals on the staff cards (src/referrals.js) ─────────
const noStaff = i => i.reply(eph({ content: '❌ You need the Manage Messages permission (or the mod role) for this.' }));

async function relay(interaction, body, okText) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: 64 });
  try { await ask({ ...body, discord_id: interaction.user.id }); }
  catch (e) { return interaction.editReply(`❌ ${e.message}`); }
  return interaction.editReply(okText);
}

const textModal = (id, title, label, required, ph) => new ModalBuilder().setCustomId(id).setTitle(title).addComponents(new ActionRowBuilder().addComponents(
  new TextInputBuilder().setCustomId('text').setLabel(label).setStyle(TextInputStyle.Short).setMaxLength(200).setRequired(required).setPlaceholder(ph)));

const buttons = {
  async rf(interaction, [action, id]) {
    if (!isMod(interaction)) return noStaff(interaction);
    if (action === 'verify') return relay(interaction, { action: 'ref_op', id: Number(id), op: 'verify' }, `✅ Referral #${id} verified. It counts from the next check.`);
    if (action === 'restore') return relay(interaction, { action: 'ref_op', id: Number(id), op: 'restore' }, `↩️ Referral #${id} restored.`);
    if (action === 'void') return interaction.showModal(textModal(`rf:void:${id}`, `Void referral #${id}`, 'Reason', false, 'Unpaid rewards of this referral are voided too'));
    if (action === 'rvoid') return interaction.showModal(textModal(`rf:rvoid:${id}`, `Void reward #${id}`, 'Reason', false, 'It will not be created again'));
    if (action === 'pay') return interaction.showModal(textModal(`rf:pay:${id}`, `Mark reward #${id} paid`, 'Transaction hash or note (optional)', false, '0x…'));
  },
};

const modals = {
  async rf(interaction, [action, id]) {
    if (!isMod(interaction)) return noStaff(interaction);
    const text = interaction.fields.getTextInputValue('text').trim();
    if (action === 'void') return relay(interaction, { action: 'ref_op', id: Number(id), op: 'void', reason: text }, `🚫 Referral #${id} voided. The card updates in a few seconds.`);
    if (action === 'rvoid') return relay(interaction, { action: 'ref_reward', id: Number(id), op: 'void', reason: text }, `🚫 Reward #${id} voided.`);
    if (action === 'pay') return relay(interaction, { action: 'ref_reward', id: Number(id), op: 'pay', ref: text }, `✅ Reward #${id} marked paid. The referrer gets a DM.`);
  },
};

module.exports = { data, execute, buttons, modals };
