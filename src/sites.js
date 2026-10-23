/**
 * sites.js — the casinos we pay out for. Every claim / lossback / reward belongs to one of them,
 * so staff (and the website) can keep Stake and Moon payouts apart.
 */
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, TextDisplayBuilder } = require('discord.js');

const SITES = {
  stake: { label: 'Stake', emoji: '🟢', style: ButtonStyle.Success },
  moon: { label: 'Moon', emoji: '🌙', style: ButtonStyle.Primary },
};
const SITE_KEYS = Object.keys(SITES);

/** Unknown / missing (old records) -> 'stake', which is all there was before Moon. */
const siteOf = s => (SITES[s] ? s : 'stake');
const siteLabel = s => SITES[siteOf(s)].label;
const siteTag = s => `${SITES[siteOf(s)].emoji} ${siteLabel(s)}`;

/** A bit of text that hints at a site (free-text labels of the manual rewards tracker). */
const guessSite = text => (/\bmoon\b/i.test(String(text ?? '')) ? 'moon' : 'stake');

const ETH_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

const WALLET_RULE = 'Use your own **personal** wallet (MetaMask, Trust Wallet, Ledger…) for **USDT on Ethereum (ERC-20)**. '
  + '**Never** a Stake or Moon wallet / deposit address: payouts sent there can be lost and can\'t be reversed.';

/**
 * Added to every "you've been paid" message: payouts go to a personal wallet and must then be deposited on the site they are for.
 * The website's ticket payouts use the same text (tk_payout_reminder in tickets_lib.php): change both together.
 */
const payoutReminder = s => `⚠️ **Reminder:** deposit this payout from your personal wallet into your **${siteLabel(s)}** account. `
  + 'Not depositing it (for example keeping it or cashing it out) counts as abuse and can get you banned from future giveaways and bonuses.';

/** Shown at the top of every form that asks for a wallet. */
const walletNotice = () => new TextDisplayBuilder().setContent(`⚠️ ${WALLET_RULE}`);

const BAD_ADDRESS = '❌ That doesn\'t look like a valid **USDT (ETH)** address. It must start with `0x` followed by 40 characters (letters a–f and numbers).\n'
  + 'Use your **own personal wallet**, not a Stake or Moon deposit address. Please press the button and try again.';

/** One button per site, e.g. `tk:details:giveaway:<site>` — `idFor(site)` builds the custom id. */
const siteButtons = (idFor, labelFor = s => `${SITES[s].label}`) => new ActionRowBuilder().addComponents(
  SITE_KEYS.map(s => new ButtonBuilder().setCustomId(idFor(s)).setLabel(labelFor(s)).setEmoji(SITES[s].emoji).setStyle(SITES[s].style)));

module.exports = { SITES, SITE_KEYS, siteOf, siteLabel, siteTag, guessSite, ETH_ADDRESS, WALLET_RULE, walletNotice, BAD_ADDRESS, siteButtons, payoutReminder };
