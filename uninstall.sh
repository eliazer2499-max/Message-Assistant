#!/usr/bin/env bash
# Removes Message Assistant. Keeps /var/lib/messageassistant (data, pairing, keys) unless you add --purge.
# My Assistant and its Caddy site are not touched.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo"; exit 1; }
PURGE="${1:-}"
systemctl disable --now messageassistant >/dev/null 2>&1 || true
rm -f /etc/systemd/system/messageassistant.service /usr/local/sbin/messageassistant-update /etc/systemd/system/caddy.service.d/messageassistant.conf
rm -f /etc/caddy/messageassistant.caddy /usr/local/sbin/messageassistant-caddy-import
if [ -f /etc/caddy/Caddyfile ]; then sed -i '/^# Message Assistant$/d;/^import \/etc\/caddy\/messageassistant.caddy$/d' /etc/caddy/Caddyfile; fi
systemctl daemon-reload
systemctl restart caddy >/dev/null 2>&1 || true
rm -rf /opt/messageassistant /opt/messageassistant-browser
if [ "$PURGE" = "--purge" ]; then rm -rf /var/lib/messageassistant /etc/messageassistant; userdel messageassistant >/dev/null 2>&1 || true; echo "Removed everything, including data."
else echo "Removed the app. Your data is still in /var/lib/messageassistant (and settings in /etc/messageassistant). Add --purge to delete it too."; fi
rm -f /usr/local/bin/messageassistant
