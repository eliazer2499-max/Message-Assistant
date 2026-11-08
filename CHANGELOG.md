# Changelog

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
