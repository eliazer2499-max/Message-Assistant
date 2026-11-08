# Message Assistant

A multi-user AI assistant that people use by **texting** a phone number (RCS / Google Messages).
It runs on your own Ubuntu server, **beside My Assistant** (its own service, port 8788, folders, address and command), and it stays $0: it uses only the free AI keys you give it.

- **Channel:** the server signs in to Google Messages for web with its own Google account, paired with the phone that has RCS. People text that phone's number; the assistant reads the chat and answers in the same chat. One hidden Chromium browser does this, gently (it reads the chat list every few seconds, one action at a time).
- **Approval:** anyone who texts is *waiting* until you approve them. They get one polite "waiting for approval" text, then nothing. You approve, block or remove people in the dashboard (or by text: `APPROVE 12`).
- **Admin login:** your phone number → a 6-digit code is texted to you through the same Google Messages session. Backup: username + password.
- **Per person:** each approved number has its own conversation history, notes, reminders, settings, usage and browser cookies. Nobody sees anybody else's.
- **AI:** one agent thinks for every message, using your list of free AI keys in your order (Gemini → Groq → Cloudflare → OpenRouter → Gemini 2 → any others). A key that hits its limit rests and comes back by itself; the next key answers meanwhile. If every key is resting, the person gets one "Busy right now, one moment" text and the answer follows when a key is free.
- **Tools:** web search, reading pages, a real browser (open, click, type, scroll, screenshot), calculator, reminders, notes. Answers from the web include the source link.

## Install (one command)

On the Ubuntu 22.04/24.04 (or Debian 12) server, as a user with sudo:

```
curl -fsSL https://raw.githubusercontent.com/eliazer2499-max/Message-Assistant/main/install.sh | sudo MSA_ADMIN_PHONE=+1XXXXXXXXXX bash
```

- Replace `+1XXXXXXXXXX` with **your** phone (it receives the admin sign-in codes). You can set or change it later: `sudo messageassistant admin-phone +1XXXXXXXXXX`
- It installs Node 22, Caddy (HTTPS), Chromium (~400 MB, once) and the app. About 5–10 minutes.
- At the end it prints the **dashboard address** (`https://msg.<your-ip>.sslip.io`) and an **admin password** (shown once).
- Your own domain instead: add `MSA_DOMAIN=msg.yourdomain.com` (point its A record at the server first).
- Ports 80 and 443 must reach the server (same as My Assistant).

My Assistant keeps working as before: Message Assistant only *adds* its own site to Caddy (`/etc/caddy/messageassistant.caddy`, imported from the Caddyfile; the import line is put back by itself if another installer rewrites the Caddyfile).

## Pair the phone (one time)

You need: the phone with RCS that will be the assistant's number, and the Google account on it.

1. Open the dashboard → **Connect**. You see the server's own browser, live.
2. Tap **Sign in** in the picture and sign in with that phone's Google account. Tap a box in the picture, type in the box under it, press **Send keys**, then **Enter**. (What you type goes straight to the browser; it is not saved or logged.)
3. On the phone: Google Messages → profile picture → **Device pairing**. Scan the QR code shown in the dashboard, or confirm on the phone if it asks.
4. When the browser shows the list of chats, the top of the dashboard turns green: **Connected**.

It stays paired across restarts and updates. If the connection drops (phone off, signed out, opened somewhere else), the dashboard shows a red banner, texts wait in a queue (none are lost), and you get an alert (see *Alerts*). The assistant presses "Use here" by itself if Messages was opened in another browser.

Tip: don't keep messages.google.com open in your own browser with the same account; Google allows one web session at a time.

## Add AI keys

Dashboard → **AI keys** → **+ Add key**. Pick the provider; the address and a free model are filled in for you:

| Provider | Free key from |
|---|---|
| Gemini | aistudio.google.com/apikey |
| Groq (openai/gpt-oss-120b) | console.groq.com/keys |
| Cloudflare Workers AI | dash.cloudflare.com (Account ID + API token) |
| OpenRouter (`:free` models) | openrouter.ai/keys |
| Mistral, Cerebras, GitHub Models, Cohere, Hugging Face, NVIDIA NIM | see the hint under each |
| Other | any OpenAI-compatible server: base URL + model |

Add as many as you like (several of the same provider is fine). Use ↑ ↓ to set the order, **Switch off/on**, **Test**, **Try now** (wake a resting key), **Delete**. Each key shows **ok / cooling down (until …) / bad / off**, and only its last 4 characters.

Or put keys in `/etc/messageassistant/env` (bottom section, kept on updates), e.g. `GROQ_API_KEY=gsk_one,gsk_two`, then `sudo messageassistant restart`. They are imported once, encrypted, in the chain order. You may then delete them from the file.

## Approve people

- Someone texts the number → they get the "waiting for approval" text, and you get an alert (dashboard + a text to your phone).
- Dashboard → **People** → **Approve** (they get a welcome text), **Block** (silence), **Remove** (deletes them and all their data; if they text again they start as waiting).
- By text from your admin phone: `PENDING`, `APPROVE 12`, `BLOCK 12`.
- **Details** on an approved person: today's and total usage, daily limit, pause, their notes (delete any), reminders, recent messages.

What people can text: any question or task, plus `HELP`, `STOP` / `START` (pause), `RESET` (fresh conversation), `NOTES` (what it remembers), `FORGET 3`, `FORGET ALL`.

## Admin sign-in

- **Phone:** type your number → a 6-digit code arrives by text (valid 10 minutes, one code a minute, 5 an hour, 5 wrong tries per code).
- **Password:** username `admin` + the password printed at install. Change it in Settings. Lost it? `sudo messageassistant reset-password` prints a new one (or `sudo messageassistant reset-password 'my new password'`).
- Wrong passwords: 5 tries per 15 minutes per address and per username. Sessions last 12 hours.

## Settings

Assistant name, admin phone(s), timezone, the waiting / welcome / busy texts, messages per person per day (default 60, protects the free keys), how many messages think at once, browser on/off and browser time per message, and an optional **alert address**: put `https://ntfy.sh/<a-secret-topic-name>` and install the free ntfy app on your phone, subscribed to the same topic, to get a push when Messages disconnects (any https URL that accepts a POST works).

## Commands on the server

```
sudo messageassistant status          # service + Messages state + people + keys
sudo messageassistant logs            # last 100 log lines
sudo messageassistant restart
sudo messageassistant update          # check now; backs up the database, installs a newer release (rolls back if it fails)
sudo messageassistant version         # installed version and the last update check
sudo messageassistant backup          # a copy in /var/lib/messageassistant/backups
sudo messageassistant users           # list; approve|block|remove <#>
sudo messageassistant keys            # AI keys (masked) and their status
sudo messageassistant admin-phone +1…
sudo messageassistant reset-password
sudo messageassistant check-update    # installed vs available (does not install)
sudo messageassistant portal on|off|show          # people's own web chat at /me
sudo messageassistant sites           # every published site; sites-unpublish <#|name>
sudo messageassistant sites-approval on|off|show   # does the admin approve each publish?
sudo messageassistant sites-access all|chosen|off  # who can build sites; sites-allow <#> / sites-deny <#>
sudo messageassistant sites-limits 50 5            # MB and sites per person
sudo messageassistant uninstall       # keeps data; add --purge to delete it
```

## Web chat for each person (1.0.2)

Approved people can open `https://<this address>/me`, type their phone number and the 6-digit code that is texted to them, and see their own chat (texts, pictures, site links) and chat from there. What they type there is answered there **and** texted to their phone; what they text from the phone shows up there. Only their own chat, ever; the sign-in never opens the admin dashboard. 30-day sign-in, one code a minute, 5 an hour. Turn it off in Settings or with `sudo messageassistant portal off` (everyone is signed out).

## Websites (1.0.2)

Approved people can ask for a simple website ("make me a page for my bakery"). The assistant writes the HTML, CSS and JavaScript in that person's **own** folder (`/var/lib/messageassistant/workspaces/<#>/`; nobody can read or touch anyone else's), and sends a phone-size **picture** of the page with 1–2 lines, never code (code only when asked, as a file).

To put it online the person gets **one** question with the link (`Reply YES to publish`; a code like `S12` only when two are waiting; a new request for the same site replaces the old one; it runs out after 30 min).

- **Site publishing (Dashboard → Sites, or `sites-approval on|off`)**: **off** (default) = the person's YES publishes. **On** = after their YES you get the name, the site, a picture and a private preview link by text and on the Sites page; reply **YES** or **NO** (or tap Approve / Reject). They are told "Waiting for admin approval" once, then the outcome. Your own sites skip the queue.
- **Who can build**: everyone (default), only chosen people, or nobody.
- **Limits**: 50 MB per person (their files + their published sites) and 5 sites per person by default.
- Sites are at `https://<this address>/sites/<name><#>-<site>/` (e.g. `/sites/moshe7-bakery/`), with a "Page not found" page (or the site's own `404.html`). They are served by this app behind Caddy, so nothing in Caddy changes. Every site page runs sealed off from the dashboard (a sandbox policy), so a site's JavaScript can never read your sign-in. (Because of that seal, a site can't use browser storage like localStorage.)
- **Sites page**: every published site (person, name, link, size, date) with **Unpublish** (the person gets a short text).
- Pictures need the server's Chromium (installed with the app). If Google's page won't take a picture, the private link to it is sent instead.

## Updates (only when you ask)

Nothing updates by itself. Press **Update now** in Dashboard → Settings → Updates, or type `sudo messageassistant update`. It:

1. reads `docs/version.json` in this repo and stops if there is no **newer** version (it never goes back to an older one);
2. downloads `docs/messageassistant-<version>.tar.gz` and checks its `.sha256`;
3. backs up the database (`/var/lib/messageassistant/backups/pre-update-…db`);
4. installs it in `/opt/messageassistant/releases/<version>` and switches `current` to it;
5. restarts and checks `/healthz`; if the new version does not answer within a minute, it switches back to the previous release by itself.

It never changes `/etc/messageassistant/env`, the Caddy files or your data, and it repairs the service file if `ExecStart` was changed by hand.
Dashboard → **Settings → Updates** shows this server's version and the latest, with **Update now** and **Check again**.
Logs: `sudo messageassistant logs` (or `journalctl -u messageassistant-update`). While it runs, the dashboard shows the update log live.
Once a day the app only *checks*: a new version shows as "update available" and you get one short text (Settings → "Text me when a new version is out" turns the text off). It never installs by itself.

From 1.0.0: type `sudo messageassistant update` once; after that you can update from the dashboard. See CHANGELOG.md.

## Backup and restore

A daily copy is made automatically (7 kept) in `/var/lib/messageassistant/backups`. To move to a new server, copy the whole `/var/lib/messageassistant` folder (it includes `master.key`, which unlocks the saved keys, and `gm-profile`, the Google Messages pairing) and `/etc/messageassistant/env`, then run the installer there.

## Where things are

| | |
|---|---|
| App | `/opt/messageassistant/current` (3 releases kept) |
| Data | `/var/lib/messageassistant` (database, master.key, gm-profile, browser-users, backups, workspaces, sites) |
| Settings | `/etc/messageassistant/env` |
| Service | `messageassistant.service`, port 8788 on 127.0.0.1, behind Caddy |
| Chromium | `/opt/messageassistant-browser` |

## Safety

- AI keys and the admin password hash are encrypted at rest (AES-256-GCM, `master.key`); keys are never shown in full or written to logs.
- Each person's browser has its own cookies; private/internal addresses (this server, your LAN) are blocked for the browser and web reads.
- The assistant never types passwords or card numbers, never buys anything, never creates accounts, and has no access to anyone's Google account.
- If Google changes its Messages page: the page selectors are in `src/channels/gmweb.js` and can be overridden without an update in `/var/lib/messageassistant/gm-selectors.json` (same names).

## Tests

```
npm test
```
Unit tests: websites (isolation incl. ../ tricks, limits, one YES, admin approval YES/NO, 404, unpublish), the updater (no downgrade, sha256, failed install), approval flow, admin code + password login and rate limits, per-user isolation, the key chain (12 fake keys, limits, cooldown, return, all-busy queue), message routing with a mocked Messages channel, the browser queue and safety. With Playwright and a Chromium available (`MSA_PLAYWRIGHT_PATH=…/playwright-core/index.mjs MSA_CHROMIUM=…/chrome npm test`) the real Messages driver and a full end-to-end round trip run against a stand-in Messages page.

**Only a real paired account can test:** that Google's real Messages page matches the driver's selectors (chat list, unread marks, message ids, the text box, starting a new chat), Google's sign-in from the server, QR / phone pairing, how long the pairing lasts, and RCS delivery itself.
