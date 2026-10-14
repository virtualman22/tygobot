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
