# Changelog

## 1.0.7 — 2026-11-09
- **Tap and click right in the live picture.** On Connect, the picture of the server's browser now works like the page itself: tap (phone) or click (computer) anywhere and it is clicked at that exact spot. A blue dot shows where.
- **Tap a box and type.** Tapping a text box in the picture (like Google's email or password box) opens your phone's keyboard at once, and what you type goes straight into that box. Enter, Tab and ⌫ work too. Password letters stay hidden. On a computer, click the box and type.
- **Scroll in the picture.** Swipe up or down on the picture (phone) or use the mouse wheel (computer). Two fingers still zoom the picture.
- The "Send keys" box and the buttons under the picture are still there as a backup.
- The browser no longer brings back old tabs after a hard stop, and a window Google opens during sign-in shows in the picture.
- **Typing box fix.** Google Messages changed its typing box (it is no longer a plain text field), so replies could not be typed. Both kinds work now.
- **"Sent" means sent.** A reply counts as sent only when it shows in the chat without Google's clock ("Sending…"). If it left the typing box but is not shown as sent, the app looks at the chat again later (after 15 s, 30 s, 1, 2, 4, 8, 16 minutes) and never types it twice; if it is missing or "Not sent", it is sent again; still stuck after about 30 minutes, the admin gets the usual failed-text report.

## 1.0.6 — 2026-11-09
- **Google sign-in fix, again.** 1.0.4 hid the browser's "automated" flag with a small script, and Google spotted it: "Couldn't sign you in – This browser or app may not be secure". The script is gone; the flag is now the browser's own (and already off).
- **The browser runs visible** on a virtual screen on the server (the full Chromium, started like a normal browser, the app connects to it). The live picture, taps and typing in the dashboard work as before.
- **Connect shows which browser runs:** "Browser: full (visible)" or "Browser: basic". Settings shows the same at the bottom, with the version.
- **Update now installs what it needs.** The update installs the virtual screen (Xvfb) if it is missing, and the full Chromium if only part of it is there (before, any Chromium folder counted as installed). No command line needed.
- If the virtual screen can't start, the app still runs with the basic browser, says so, and tells you to press Update now.

## 1.0.4 — 2026-11-08
- **Google sign-in works from the server again.** 1.0.3 started a stripped-down headless browser, and Google refused to sign in from it ("Couldn't sign you in – This browser or app may not be secure"), whatever name it gave itself. 1.0.4 always starts the full browser the installer already puts on the server (still without a window), with a normal Chrome name and no automation marks. Checked live: Google accepts it.
- **Pairing goes straight to the QR code.** Connect → **Start pairing**. The QR code shows big in the dashboard. On the phone: Google Messages → profile picture → Device pairing → QR code scanner. If Google offers pairing with the Google account or a QR code, the QR code is chosen by itself, and "Remember this computer" is turned on.
- Google now wants the phone's Google account signed in once before it shows any QR code (every pairing page goes to sign-in first). If it asks, the dashboard says so and opens the server's browser live for that one sign-in; otherwise the live picture stays folded away.
- The QR code refreshes by itself every few seconds while it is up (Google changes it), and the dashboard says **Paired ✓** the moment the phone has scanned it. It stays paired after restarts and updates.
- If Google still refuses the sign-in, the dashboard says so in plain words ("Google refused the sign-in from the server's browser") instead of "Not signed in".

## 1.0.3 — 2026-11-08
- **Updates: "Checking…" always finishes.** Settings → Updates now ends every check within about 15 seconds with one of three answers: "Up to date (1.0.3)", "1.0.x available — Update now", or "Couldn't reach the update source" with a short reason (no answer in time, no version.json there, broken version.json, address not found). Before, the line stayed on "Checking…" whenever the check or another part of the Settings page failed or was slow, and "Check again" showed no progress.
- The check asks every source at the same time with one time limit, shares one look when two checks run together, and skips GitHub's few-minutes-old cached copy.
- If "Update now" did not start on the server, the page says so (with `sudo messageassistant update`) instead of "starting…" forever.
- **Editable update source** (Settings → Updates → Update source, like My Assistant): the default GitHub folder or another https address; a GitHub repo link works too (its /docs folder). Save, Reset to default, and the order the sources are tried. The root updater uses the saved address too; it still checks the sha256 of every download and never installs an older or the same version.
- `sudo messageassistant update-source show|set <url>|reset`.
- **Logo no longer fills the page.** On a phone, 1.0.2 could show the old logo full width above Updates: the page was new but the phone kept the old style and logo files. Now every page asks for its files with `?v=<version>` (style, script, logo, icons, manifest), pages are never cached, each logo has its own small size (28 px in the header, 72 px on sign-in) even if the style file fails, and the dashboard reloads itself once after an update. App icon, favicon and home-screen icons are the new logo everywhere.

## 1.0.2 — 2026-11-08
- **Websites for every approved person:** they ask by text, the assistant builds HTML/CSS/JavaScript in their own folder and sends a phone-size picture (no code in the chat; code only on request, as a file). Each person's files are separate (no `..`, no symlinks out, no hidden files).
- **Publishing with one YES:** one question with the link; a code only when two are waiting; same site again replaces the old request; 30-minute expiry. Live at `/sites/<name><#>-<site>/` with a 404 page (or the site's own `404.html`). Unpublish by text or from the dashboard.
- **Admin setting "Site publishing"** (Dashboard → Sites, or `sudo messageassistant sites-approval on|off|show`): off = the person's YES publishes; on = you approve each publish (picture + private preview link by text and in the dashboard; reply YES/NO or tap Approve/Reject).
- **Who can build sites**: everyone, only chosen people, or nobody. Limits per person: 50 MB and 5 sites (changeable).
- **Dashboard → Sites**: every published site (person, name, link, size, date) with Unpublish; requests waiting for you.
- **Pictures over Messages**: the assistant can send a picture (it falls back to a private link if the page won't take it).
- **Web chat for each person** at `https://<address>/me`: they sign in with their phone number and a texted code (approved people only), see their own chat (texts, pictures, site links) and chat from there; every answer is also texted, and texts from the phone show up there. Same one-YES rules. Admin switch: Settings, or `sudo messageassistant portal on|off`.
- **New logo.**
- **Updates:** release notes in the dashboard, the update log live while it runs, a once-a-day check (badge + one text; never installs), `sudo messageassistant check-update`.

## 1.0.1 — 2026-11-05
- **Startup fix:** the service now starts through `/opt/messageassistant/current` (1.0.0 compared plain paths, so through the
  `current` link it never started and restarted in a loop). It now compares real paths.
- **Update from the dashboard:** Settings → Updates → **Update now** (or `sudo messageassistant update`). Nothing updates by itself. It installs only a newer version
  (sha256-checked, never a downgrade): database backup → `releases/<version>` → switch `current` → restart → `/healthz`.
  If the new version does not answer, it goes back to the previous release by itself. Logs: `sudo messageassistant logs`.
- **Dashboard:** Settings → Updates: this server's version and the latest, **Update now** and **Check again**.
- **Installer/updater repair the service file:** `ExecStart` always points at `current/src/server.js` (a hand-edited
  `releases/<version>` path is fixed).
- **Your settings are kept:** an update never changes `/etc/messageassistant/env`, the Caddy files or your data.
  Running the installer again keeps `MSA_HOST`, `MSA_PUBLIC_URL`, `MSA_PORT` and any other lines you added.
- New command: `sudo messageassistant version`.

## 1.0.0 — 2026-11-03
- First release.
