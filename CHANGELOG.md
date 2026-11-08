# Changelog

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
