#!/usr/bin/env bash
# Message Assistant — one-command installer / updater for Ubuntu 22.04/24.04 and Debian 12 (x86_64 + arm64).
#   curl -fsSL https://raw.githubusercontent.com/eliazer2499-max/Message-Assistant/main/install.sh | sudo MSA_ADMIN_PHONE=+16465550100 bash
# It runs BESIDE "My Assistant" on the same server: its own user, service, port (8788), folders and address.
# Options (environment variables):
#   MSA_ADMIN_PHONE=+1...      the admin's phone (gets the sign-in codes); can be set later: sudo messageassistant admin-phone +1...
#   MSA_DOMAIN=msg.example.com its own address (point the A record here first). Default: msg.<ip>.sslip.io
#   MSA_EMAIL=you@example.com  email for the HTTPS certificate (optional)
#   MSA_SOURCE=https://...     where releases come from (default: the GitHub repo's /docs folder)
#   MSA_LOCAL_TARBALL=/path    install this release file instead of downloading
#   MSA_SKIP_BROWSER=1         don't install Chromium now (Google Messages needs it; run the installer again later)
#   DRY_RUN=1                  print what would be done, change nothing
#   MSA_UPDATE=1               update the app only (keeps data, keys, pairing, address)
# Safe to run again: it keeps your data, keys, settings and the Google Messages pairing.
set -Eeuo pipefail

SOURCE="${MSA_SOURCE:-https://raw.githubusercontent.com/eliazer2499-max/Message-Assistant/main/docs}"
APP_USER=messageassistant
OPT=/opt/messageassistant
DATA=/var/lib/messageassistant
ETC=/etc/messageassistant
BROWSERS=/opt/messageassistant-browser
PORT=8788
PW_VERSION="${MSA_PLAYWRIGHT_VERSION:-1.64.1}"
DRY="${DRY_RUN:-0}"
UPDATE="${MSA_UPDATE:-0}"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!! \033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx \033[0m %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY" = "1" ]; then printf '[dry-run] %s\n' "$*"; else "$@"; fi; }
write_file() { # write_file <path> <mode> <owner>  (content on stdin)
  local path="$1" mode="$2" owner="$3"
  if [ "$DRY" = "1" ]; then printf '[dry-run] write %s (%s %s)\n' "$path" "$mode" "$owner"
    if [ -n "${MSA_RENDER_DIR:-}" ]; then mkdir -p "$MSA_RENDER_DIR$(dirname "$path")"; cat >"$MSA_RENDER_DIR$path"; else cat >/dev/null; fi; return; fi
  local tmp; tmp="$(mktemp)"; cat >"$tmp"; install -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$tmp" "$path"; rm -f "$tmp"
}
trap 'warn "Install stopped at line $LINENO. Nothing is half-deleted; run the same command again to continue."' ERR

# ---------- checks ----------
if [ "$DRY" != "1" ] && [ "$(id -u)" -ne 0 ]; then die "Run as root: curl -fsSL <install.sh> | sudo bash"; fi
[ -r /etc/os-release ] && . /etc/os-release || die "Cannot read /etc/os-release"
case "${ID:-}:${VERSION_ID:-}" in
  ubuntu:22.04|ubuntu:24.04|debian:12) ;;
  ubuntu:*|debian:*) warn "Tested on Ubuntu 22.04/24.04 and Debian 12; you have ${PRETTY_NAME:-unknown}. Trying anyway." ;;
  *) die "This installer supports Ubuntu (22.04/24.04) and Debian 12. You have ${PRETTY_NAME:-unknown}." ;;
esac
ARCH="$(uname -m)"; case "$ARCH" in x86_64|aarch64|arm64) ;; *) die "Unsupported CPU: $ARCH (need x86_64 or arm64)";; esac
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
[ "${MEM_MB:-0}" -lt 1500 ] && warn "Only ${MEM_MB} MB RAM. Two Chromium browsers run here; 2 GB or more (or swap) is wise."
say "Message Assistant installer — ${PRETTY_NAME} on ${ARCH}$([ "$DRY" = 1 ] && echo ' (DRY RUN: nothing will change)')"
export DEBIAN_FRONTEND=noninteractive

# ---------- packages ----------
if [ "$UPDATE" != 1 ]; then
  say "Installing system packages"
  run apt-get update -y -q
  run apt-get install -y -q ca-certificates curl gnupg tar gzip iptables debian-keyring debian-archive-keyring apt-transport-https fonts-noto-core fonts-noto-color-emoji
fi
need_node=1
if command -v node >/dev/null 2>&1; then
  v="$(node -v | sed 's/^v//')"; major="${v%%.*}"; minor="$(echo "$v" | cut -d. -f2)"
  if [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 13 ]; }; then need_node=0; fi
fi
if [ "$need_node" = 1 ]; then
  say "Installing Node.js 22"
  if [ "$DRY" = 1 ]; then echo "[dry-run] curl -fsSL https://deb.nodesource.com/setup_22.x | bash -"; else curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; fi
  run apt-get install -y -q nodejs
fi
if ! command -v caddy >/dev/null 2>&1; then
  say "Installing Caddy (automatic HTTPS)"
  if [ "$DRY" = 1 ]; then echo "[dry-run] add Caddy apt repo + apt-get install caddy"; else
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y -q && apt-get install -y -q caddy
  fi
fi

# ---------- user and folders ----------
say "Creating the service user and folders"
id "$APP_USER" >/dev/null 2>&1 || run useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin --user-group "$APP_USER"
run install -d -m 755 -o root -g root "$OPT" "$OPT/releases" "$ETC"
run install -d -m 700 -o "$APP_USER" -g "$APP_USER" "$DATA"

# ---------- the release ----------
TMPD="$(mktemp -d)"; trap 'rm -rf "$TMPD"' EXIT
if [ "$DRY" = 1 ]; then echo "[dry-run] download $SOURCE/messageassistant-latest.tar.gz (+ .sha256), unpack to $OPT/releases/<version>, npm install playwright-core"; VERSION="(dry-run)"
else
  if [ -n "${MSA_LOCAL_TARBALL:-}" ] && [ -f "${MSA_LOCAL_TARBALL:-}" ]; then cp "$MSA_LOCAL_TARBALL" "$TMPD/app.tgz"
  else
    say "Downloading the app from $SOURCE"
    curl -fsSL --max-time 300 "$SOURCE/messageassistant-latest.tar.gz" -o "$TMPD/app.tgz" || die "Could not download $SOURCE/messageassistant-latest.tar.gz. Check the internet connection and try again."
    curl -fsSL --max-time 30 "$SOURCE/messageassistant-latest.tar.gz.sha256" -o "$TMPD/app.sha256" || die "Could not download the .sha256 check file."
    want="$(awk '{print $1}' "$TMPD/app.sha256")"; got="$(sha256sum "$TMPD/app.tgz" | awk '{print $1}')"
    [ "$want" = "$got" ] || die "Download check failed (sha256 mismatch). Not installing; try again in a minute."
  fi
  mkdir -p "$TMPD/x" && tar -xzf "$TMPD/app.tgz" -C "$TMPD/x"
  [ -f "$TMPD/x/messageassistant/VERSION" ] || die "The download has no messageassistant/VERSION."
  VERSION="$(cat "$TMPD/x/messageassistant/VERSION")"
  say "Installing the browser driver (playwright-core $PW_VERSION, no browser download here)"
  ( cd "$TMPD/x/messageassistant" && HOME=/root npm install --omit=dev --no-audit --no-fund --loglevel=error "playwright-core@$PW_VERSION" >/dev/null ) || die "npm could not install playwright-core. Check the internet connection and run again."
  rm -rf "$OPT/releases/$VERSION" && mv "$TMPD/x/messageassistant" "$OPT/releases/$VERSION"
  chown -R root:root "$OPT/releases/$VERSION" && chmod -R u=rwX,go=rX "$OPT/releases/$VERSION"
  ln -sfn "$OPT/releases/$VERSION" "$OPT/current.new" && mv -T "$OPT/current.new" "$OPT/current"
  ls -1dt "$OPT"/releases/*/ 2>/dev/null | tail -n +4 | xargs -r rm -rf          # keep the 3 newest for rollback
fi
say "App version: $VERSION"

# ---------- Chromium (for Google Messages and the assistant's own browser) ----------
if [ "${MSA_SKIP_BROWSER:-0}" != 1 ]; then
  if [ "$DRY" = 1 ]; then echo "[dry-run] PLAYWRIGHT_BROWSERS_PATH=$BROWSERS npx playwright@$PW_VERSION install --with-deps chromium"
  elif ls -d "$BROWSERS"/chromium-*/ >/dev/null 2>&1 && [ "$UPDATE" = 1 ] && [ -z "${MSA_BROWSER_REFRESH:-}" ]; then say "Chromium already installed"
  else
    free_mb=$(df -BM --output=avail /opt | tail -1 | tr -dc '0-9')
    [ "${free_mb:-0}" -ge 1500 ] || die "Need about 1.5 GB free on /opt for Chromium (have ${free_mb} MB). Free some space and run again."
    say "Installing Chromium (about 400 MB, one time)"
    mkdir -p "$BROWSERS"
    PLAYWRIGHT_BROWSERS_PATH="$BROWSERS" HOME=/root timeout -k 10 1800 npx --yes "playwright@$PW_VERSION" install --with-deps chromium || die "Chromium did not install. Run the installer again."
    rm -rf "$BROWSERS"/ffmpeg-* /root/.npm/_npx 2>/dev/null || true
    chmod -R a+rX "$BROWSERS"
  fi
fi

# ---------- address ----------
if [ -f "$ETC/env" ] && [ -z "${MSA_DOMAIN:-}" ]; then DOMAIN="$(sed -n 's#^MSA_PUBLIC_URL=https\?://##p' "$ETC/env" | head -1)"; fi
if [ -z "${DOMAIN:-}" ]; then
  if [ -n "${MSA_DOMAIN:-}" ]; then DOMAIN="$MSA_DOMAIN"; else
    IP=""
    for u in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
      IP="$(curl -4 -fsS --max-time 8 "$u" 2>/dev/null | tr -d '[:space:]')" || true
      [[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && break || IP=""
    done
    [ -n "$IP" ] || die "Could not find this server's public IPv4. Re-run with MSA_DOMAIN=your.domain"
    DOMAIN="msg.${IP//./-}.sslip.io"
  fi
fi
PUBLIC_URL="https://$DOMAIN"
say "Dashboard address: $PUBLIC_URL"

# ---------- settings file (AI keys you add at the bottom are kept on every update) ----------
KEEP=""
if [ -f "$ETC/env" ]; then KEEP="$(sed -n '/^# ---- your AI keys/,$p' "$ETC/env" | tail -n +2)"; fi
ADMIN_LINE="$( [ -f "$ETC/env" ] && sed -n 's/^MSA_ADMIN_PHONE=//p' "$ETC/env" | head -1 || true)"
[ -n "${MSA_ADMIN_PHONE:-}" ] && ADMIN_LINE="$MSA_ADMIN_PHONE"
if [ -z "$KEEP" ]; then KEEP='# One or more keys per line; several keys may be separated by commas. Imported (encrypted) on start, in this order:
# Gemini main → Groq → Cloudflare → OpenRouter → Gemini 2 → others. The dashboard (AI keys) does the same.
#GEMINI_API_KEY=
#GROQ_API_KEY=
#CLOUDFLARE_ACCOUNT_ID=
#CLOUDFLARE_API_TOKEN=
#OPENROUTER_API_KEY=
#GEMINI_API_KEY_2=
#MISTRAL_API_KEY=
#CEREBRAS_API_KEY=
#GITHUB_MODELS_TOKEN=
#COHERE_API_KEY=
#HF_TOKEN=
#NVIDIA_API_KEY='; fi
write_file "$ETC/env" 640 "root:$APP_USER" <<EOF
# Message Assistant settings (managed by its installer; this file is readable only by root and the service)
MSA_PUBLIC_URL=$PUBLIC_URL
MSA_DATA_DIR=$DATA
MSA_PORT=$PORT
MSA_HOST=127.0.0.1
MSA_ADMIN_PHONE=$ADMIN_LINE
PLAYWRIGHT_BROWSERS_PATH=$BROWSERS
NODE_ENV=production
# ---- your AI keys (kept on update) ----
$KEEP
EOF

# ---------- systemd ----------
write_file /etc/systemd/system/messageassistant.service 644 root:root <<EOF
[Unit]
Description=Message Assistant (multi-user AI assistant over Google Messages)
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
Group=$APP_USER
EnvironmentFile=$ETC/env
Environment=NODE_OPTIONS=--max-old-space-size=384
WorkingDirectory=$OPT/current
ExecStart=/usr/bin/env node --disable-warning=ExperimentalWarning $OPT/current/src/server.js
Restart=always
RestartSec=5
UMask=0077
PrivateTmp=yes
ProtectSystem=full
ProtectHome=yes
NoNewPrivileges=yes
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
EOF
write_file /usr/local/sbin/messageassistant-update 755 root:root <<EOF
#!/usr/bin/env bash
# sudo messageassistant update: a copy of the database, then the newest release from the source (sha256-checked).
set -euo pipefail
exec > >(tee "$DATA/update.log") 2>&1
echo "=== update started \$(date -Is) ==="
mkdir -p "$DATA/backups" && chown $APP_USER:$APP_USER "$DATA/backups"
( cd /tmp && runuser -u $APP_USER -- node --disable-warning=ExperimentalWarning -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('$DATA/messageassistant.db');d.exec(\"VACUUM INTO '$DATA/backups/pre-update-\"+Date.now()+\".db'\")" ) && echo "database backed up" || echo "(database backup skipped)"
SRC="\${MSA_SOURCE:-$SOURCE}"
W="\$(mktemp -d)"; trap 'rm -rf "\$W"' EXIT
curl -fsSL --max-time 60 "\$SRC/install.sh" -o "\$W/install.sh" || { echo "Could not reach \$SRC"; exit 1; }
MSA_UPDATE=1 MSA_SOURCE="\$SRC" bash "\$W/install.sh"
echo "=== update finished \$(date -Is) ==="
EOF
write_file /usr/local/bin/messageassistant 755 root:root <<'EOF'
#!/usr/bin/env bash
# Message Assistant helper. Usage: sudo messageassistant {status|url|logs|restart|update|backup|reset-password|admin-phone|users|approve|block|remove|keys|uninstall}
set -euo pipefail
DATA=/var/lib/messageassistant
cli() { cd /tmp && set -a && . /etc/messageassistant/env && set +a && runuser -u messageassistant -- node --disable-warning=ExperimentalWarning /opt/messageassistant/current/src/cli.js "$@"; }
url() { sed -n 's/^MSA_PUBLIC_URL=//p' /etc/messageassistant/env; }
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo messageassistant ${1:-status}"; exit 1; }
case "${1:-status}" in
  status) systemctl --no-pager status messageassistant | head -8; echo; cli info; echo "Dashboard: $(url)";;
  url) url;;
  logs) journalctl -u messageassistant -n "${2:-100}" --no-pager;;
  restart) systemctl restart messageassistant && echo "Restarted.";;
  update) /usr/local/sbin/messageassistant-update;;
  backup) f="$DATA/backups/manual-$(date +%Y%m%d-%H%M%S).db"; mkdir -p "$DATA/backups"; chown messageassistant:messageassistant "$DATA/backups"; cd /tmp && runuser -u messageassistant -- node --disable-warning=ExperimentalWarning -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('$DATA/messageassistant.db').exec(\"VACUUM INTO '$f'\")" && echo "Saved $f (keep master.key with it: $DATA/master.key)";;
  reset-password|admin-phone|users|approve|block|remove|keys) shift_cmd="$1"; shift; cli "$shift_cmd" "$@";;
  uninstall) bash /opt/messageassistant/current/uninstall.sh "${2:-}";;
  *) echo "Usage: sudo messageassistant {status|url|logs|restart|update|backup|reset-password [new]|admin-phone +1...|users|approve <#>|block <#>|remove <#>|keys|uninstall [--purge]}";;
esac
EOF

# ---------- HTTPS (Caddy) — added BESIDE any existing site (My Assistant keeps its own) ----------
say "Configuring HTTPS for $DOMAIN"
GLOBAL_EMAIL=""; [ -n "${MSA_EMAIL:-}" ] && GLOBAL_EMAIL="	tls $MSA_EMAIL"
write_file /etc/caddy/messageassistant.caddy 644 root:root <<EOF
# Message Assistant (managed by its installer)
$DOMAIN {
	encode gzip
$GLOBAL_EMAIL
	reverse_proxy 127.0.0.1:$PORT
}
EOF
write_file /usr/local/sbin/messageassistant-caddy-import 755 root:root <<'EOF'
#!/usr/bin/env bash
# Keeps "import /etc/caddy/messageassistant.caddy" in /etc/caddy/Caddyfile (another installer may rewrite that file).
F=/etc/caddy/Caddyfile
[ -f /etc/caddy/messageassistant.caddy ] || exit 0
[ -f "$F" ] || : > "$F"
grep -q '^import /etc/caddy/messageassistant.caddy' "$F" || printf '\n# Message Assistant\nimport /etc/caddy/messageassistant.caddy\n' >> "$F"
exit 0
EOF
run install -d -m 755 /etc/systemd/system/caddy.service.d
write_file /etc/systemd/system/caddy.service.d/messageassistant.conf 644 root:root <<'EOF'
[Service]
ExecStartPre=/usr/local/sbin/messageassistant-caddy-import
EOF
if [ "$DRY" != 1 ]; then
  # a fresh Caddy package ships a demo site on :80 — keep any real config, drop only that demo
  if [ -f /etc/caddy/Caddyfile ] && grep -q '^:80 {' /etc/caddy/Caddyfile && grep -q 'file_server' /etc/caddy/Caddyfile && ! grep -qi 'assistant' /etc/caddy/Caddyfile; then cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.before-messageassistant; : > /etc/caddy/Caddyfile; fi
  /usr/local/sbin/messageassistant-caddy-import
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || { warn "Caddy says the web config has a problem:"; caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile || true; }
fi

# ---------- firewall on this machine ----------
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then run ufw allow 80/tcp; run ufw allow 443/tcp; fi
if command -v iptables >/dev/null 2>&1; then
  for p in 80 443; do iptables -C INPUT -p tcp --dport "$p" -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null || run iptables -I INPUT 1 -p tcp --dport "$p" -m conntrack --ctstate NEW -j ACCEPT; done
fi

# ---------- start ----------
say "Starting"
run systemctl daemon-reload
run systemctl enable messageassistant >/dev/null 2>&1 || true
run systemctl restart messageassistant
run systemctl enable caddy >/dev/null 2>&1 || true
run systemctl restart caddy
NEWPW=""
if [ "$DRY" != 1 ]; then
  for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 || { journalctl -u messageassistant -n 30 --no-pager; die "The app did not start (log above)."; }
  if [ ! -f "$DATA/.password-set" ]; then
    NEWPW="$(/usr/local/bin/messageassistant reset-password | sed -n 's/^Admin password: //p')"
    install -m 600 -o "$APP_USER" -g "$APP_USER" /dev/null "$DATA/.password-set"
  fi
fi

echo
echo "============================================================"
if [ "$UPDATE" = 1 ]; then echo " Updated Message Assistant to version $VERSION."
else
  echo " Message Assistant $VERSION is installed (beside My Assistant)."
  echo
  echo " Dashboard:  $PUBLIC_URL"
  if [ -n "$NEWPW" ]; then echo " Username:   admin"; echo " Password:   $NEWPW   (shown once; change it in Settings)"; fi
  echo
  echo " Next: open the dashboard → Connect → sign in to Google and pair the phone."
  [ -z "$ADMIN_LINE" ] && echo " Set the admin phone: sudo messageassistant admin-phone +1XXXXXXXXXX"
  echo " Help: sudo messageassistant status | logs | keys | users"
fi
echo "============================================================"
