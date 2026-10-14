# Website <-> Discord bot link

What it does
- **Guess The Balance (website)** -> bot posts in your GTB channel: new hunt, guessing opened, **every guess** as it comes in, guessing closed, and the **final result** (top 3 + full ranking, winner pinged).
- **Website tickets <-> Discord**: every website ticket gets a **thread in a private staff channel** with the whole chat mirrored (member messages, staff replies, internal notes, rewards/paid, status). Staff can press **Reply to member / Internal note / Claim / Close / Reopen** on the card in Discord and it happens on the website. Closing or deleting a ticket on the site updates/removes the thread.
- The bot's own Discord tickets (claim forms, `/ticket panel`) are unchanged and stay separate.

## 1. Website (upload files)
`bridge_lib.php` and `api_bridge.php` (new), `tickets_lib.php`, `api_gtb.php`, `config.example.php` (changed).
In `config.local.php` add a long random secret (e.g. 40+ characters):

    'bridge_secret' => 'paste-a-long-random-string-here',

Without it the website behaves exactly as before. Check that `https://yoursite/data/bridge_events.json` returns 403 (your `data/` rule already covers it).
Apache with PHP-CGI sometimes drops the Authorization header; if the bot says "Unauthorized" add this line to `.htaccess`:
`SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1`

## 2. Bot (Railway variables, then push the changed files to GitHub)
    SITE_URL=https://tygogambles.com
    BRIDGE_SECRET=<the same string>
Optional: `GTB_GUESS_MODE=close` (hold guesses back and post them all when guessing closes; default `live` = post each guess immediately), `BRIDGE_POLL_MS=4000`.
Changed bot files: `src/bridge.js` (new), `src/commands/sitelink.js` (new), `src/db.js`, `src/commands/setup.js`, `src/events/ready.js`. Commands re-register themselves on start.

## 3. In Discord (once)
    /setup set gtb_channel:#guess-the-balance site_tickets_channel:#website-tickets
`site_tickets_channel` must be **private to staff** (threads inherit who can see the channel). The bot needs View Channel, Send Messages, Create Public Threads, Send Messages in Threads, Manage Threads, Embed Links, Mention Roles there.
Check it with `/sitelink status` (green = connected) and `/sitelink test`.
Staff who press the buttons must be on the website's staff list (`mod_discord_ids` / `admin_discord_ids`) and must have logged in to the website once. The same rules as the web desk apply (e.g. nobody handles their own ticket).

## Good to know
- Guesses are posted **live by default**, which means later guessers can see earlier guesses. If that matters for a hunt, use `GTB_GUESS_MODE=close`.
- If the bot is offline or redeploys, nothing is lost or posted twice: the website remembers how far the bot got. If a channel is not set, those events are skipped (and `/sitelink status` shows the count).
- Tickets that were already open before you switch this on are not mirrored (only new ones).
- Don't run the bot's own `/gtb` in the same channel as the website GTB.

# Payout tracking on the website (claim forms, lossbacks, ledger)

Needs the same link as above (SITE_URL + BRIDGE_SECRET). Nothing else to configure.

What the bot now copies to the website (about a minute after it starts, then every minute), **old records included**:
- claim forms from Discord tickets (giveaway / bonus / milestone), with the screenshot link and disqualified ones
- the manual `/rewards` tracker (only entries that are not already a claim form, so nothing is counted twice)
- weekly lossback lists (`/lossback`), every entry from every list

On the website (Tickets page in the admin):
- **To pay** tab: new box "Discord claim forms & rewards waiting" under the website rewards.
- **Lossbacks** tab (next to To pay): Waiting / Paid / All, grouped by list, with address copy buttons and totals.
- **Payout ledger**: cards for Giveaways, Bonuses, Lossbacks (plus Milestones / Other when there are some) and **All categories**. Each shows the total per currency, the combined "USD & stablecoins" figure (USD + USDT + USDC) and the number of payouts. Category chips filter the table; the CSV export has a category and source column and includes the Discord rows.
- Paying still happens where it did (Mark paid in Discord, or on the website for website rewards). Paid rows appear in the ledger by themselves.

Things to know
- The amount is read from the text people/staff typed (`$25`, `25 USDT`, `0.001 BTC`, `1,250`, `25k`; a bare number counts as USD). Anything it can't read (e.g. "VIP role") is shown as **NOT COUNTED** and left out of the totals until an admin presses **Fix** and gives it an amount, currency and category. Fixes survive every bot update.
- For lossbacks the amount is the **Loss** column that staff fill in on the list. If you pay a percentage of it, the lossback total shows losses, not the payout.
- Old lossbacks that were already paid have no payment date in the bot, so they get the date of their list and are marked "(approx.)". From now on the real date is recorded.
- Old manual `/rewards` entries have no category, so it is guessed from the label ("…bonus…" = Bonuses, "…lossback…", "…giveaway…"); otherwise Other. Use Fix to change one.
- Website rewards have a Category dropdown when you add them; older website payouts are guessed from the reward name (default Giveaways).
- The site never deletes these records, so history stays even if something is removed in Discord.
