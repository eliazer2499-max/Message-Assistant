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
#   MSA_FORCE=1                with MSA_UPDATE=1: reinstall even when the version is not newer
#   MSA_UPDATE=1               update the app only (keeps data, keys, pairing, address)
# Safe to run again: it keeps your data, keys, settings and the Google Messages pairing.
set -Eeuo pipefail

DEFAULT_SOURCE=https://raw.githubusercontent.com/eliazer2499-max/Message-Assistant/main/docs
SOURCE="${MSA_SOURCE:-$DEFAULT_SOURCE}"
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
if [ "$UPDATE" != 1 ] && ! command -v caddy >/dev/null 2>&1; then
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
# 1.0.1: versions only go up on an update (MSA_FORCE=1 to reinstall), the database is copied first, the new
# release goes to releases/<version>, then "current" is switched; the old release stays for the automatic rollback.
vgt() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]; }   # $1 newer than $2
UNIT=/etc/systemd/system/messageassistant.service
CUR_DIR="$(readlink -f "$OPT/current" 2>/dev/null || true)"
if [ ! -f "$CUR_DIR/src/server.js" ] && [ -f "$UNIT" ]; then   # a hand-edited unit may point straight at releases/<v>
  CUR_DIR="$(sed -n 's#^ExecStart=.* \(/[^ ]*\)/src/server\.js.*#\1#p' "$UNIT" | head -1)"; CUR_DIR="$(readlink -f "$CUR_DIR" 2>/dev/null || true)"
fi
[ -f "$CUR_DIR/VERSION" ] || CUR_DIR=""
CUR_VER="$( [ -n "$CUR_DIR" ] && cat "$CUR_DIR/VERSION" || true)"
NEW_DIR=""; PREV_DIR=""; NOCHANGE=0
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
  if [ "$UPDATE" = 1 ] && [ -n "$CUR_VER" ] && ! vgt "$VERSION" "$CUR_VER" && [ "${MSA_FORCE:-0}" != 1 ]; then
    if [ "$VERSION" = "$CUR_VER" ]; then say "Already on the newest version ($CUR_VER). Checking the service files only."
    else say "This server has $CUR_VER, newer than the source's $VERSION. Not going back. Checking the service files only."; fi
    NOCHANGE=1; VERSION="$CUR_VER"; NEW_DIR="$CUR_DIR"
  else
    [ -n "$CUR_VER" ] && say "Updating $CUR_VER → $VERSION"
    if [ -f "$DATA/messageassistant.db" ]; then
      install -d -m 700 -o "$APP_USER" -g "$APP_USER" "$DATA/backups"
      BK="$DATA/backups/pre-update-${CUR_VER:-none}-to-$VERSION-$(date +%Y%m%d-%H%M%S).db"
      ( cd /tmp && runuser -u "$APP_USER" -- node --disable-warning=ExperimentalWarning -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('$DATA/messageassistant.db').exec(\"VACUUM INTO '$BK'\")" ) && say "Database backed up: $BK" || die "Could not back up the database first; not updating."
    fi
    say "Installing the browser driver (playwright-core $PW_VERSION, no browser download here)"
    ( cd "$TMPD/x/messageassistant" && HOME=/root npm install --omit=dev --no-audit --no-fund --loglevel=error "playwright-core@$PW_VERSION" >/dev/null ) || die "npm could not install playwright-core. Check the internet connection and run again."
    STAGE="$OPT/releases/.new-$VERSION"; rm -rf "$STAGE"; mv "$TMPD/x/messageassistant" "$STAGE"
    chown -R root:root "$STAGE" && chmod -R u=rwX,go=rX "$STAGE"
    if [ -e "$OPT/releases/$VERSION" ]; then   # reinstalling the same version: keep the old copy for the rollback
      OLDSAME="$OPT/releases/$VERSION.old-$(date +%s)"; mv "$OPT/releases/$VERSION" "$OLDSAME"
      [ "$CUR_DIR" = "$OPT/releases/$VERSION" ] && CUR_DIR="$OLDSAME"
    fi
    mv "$STAGE" "$OPT/releases/$VERSION"; touch "$OPT/releases/$VERSION"
    NEW_DIR="$OPT/releases/$VERSION"; PREV_DIR="$CUR_DIR"
    ln -sfn "$NEW_DIR" "$OPT/current.new" && mv -T "$OPT/current.new" "$OPT/current"
  fi
fi
say "App version: $VERSION"

# ---------- Chromium (for Google Messages and the assistant's own browser) ----------
full_chromium() { ls "$BROWSERS"/chromium-*/chrome-linux*/chrome >/dev/null 2>&1; }
if [ "${MSA_SKIP_BROWSER:-0}" != 1 ]; then
  if [ "$DRY" = 1 ]; then echo "[dry-run] PLAYWRIGHT_BROWSERS_PATH=$BROWSERS npx playwright@$PW_VERSION install --with-deps chromium"
  # 1.0.6: "installed" means the FULL build is there (chromium-*/chrome-linux*/chrome), not just any chromium folder
  elif full_chromium && [ "$UPDATE" = 1 ] && [ -z "${MSA_BROWSER_REFRESH:-}" ]; then say "Chromium already installed (full build)"
  else
    free_mb=$(df -BM --output=avail /opt | tail -1 | tr -dc '0-9')
    [ "${free_mb:-0}" -ge 1500 ] || die "Need about 1.5 GB free on /opt for Chromium (have ${free_mb} MB). Free some space and run again."
    say "Installing Chromium (about 400 MB, one time)"
    mkdir -p "$BROWSERS"
    PLAYWRIGHT_BROWSERS_PATH="$BROWSERS" HOME=/root timeout -k 10 1800 npx --yes "playwright@$PW_VERSION" install --with-deps chromium || die "Chromium did not install. Run the installer again."
    rm -rf "$BROWSERS"/ffmpeg-* /root/.npm/_npx 2>/dev/null || true
    chmod -R a+rX "$BROWSERS"
    full_chromium || warn "The full Chromium build is missing after the install; the browser will run in basic mode. Run the update again."
  fi
  # 1.0.6: the virtual screen the browser runs on, visible (Google refuses sign-in from more automated browsers).
  # Installed on every install and update (also "Update now" in the dashboard) when it is missing.
  if [ "$DRY" = 1 ]; then echo "[dry-run] apt-get install -y xvfb (if Xvfb is missing)"
  elif command -v Xvfb >/dev/null 2>&1; then say "Virtual screen (Xvfb) already installed"
  else
    say "Installing the virtual screen (Xvfb)"
    apt_xvfb() { DEBIAN_FRONTEND=noninteractive timeout -k 10 900 apt-get -o DPkg::Lock::Timeout=300 install -y -q --no-install-recommends xvfb >/dev/null 2>&1; }
    apt_xvfb || { DEBIAN_FRONTEND=noninteractive timeout -k 10 600 apt-get -o DPkg::Lock::Timeout=300 update -q >/dev/null 2>&1; apt_xvfb; } \
      || warn "Xvfb did not install. The browser runs in basic mode (Google may refuse the sign-in). Press Update now again later, or: sudo apt-get install xvfb"
  fi
fi

# ---------- address + settings file ----------
# 1.0.1: an update never touches /etc/messageassistant/env. A fresh run of the installer keeps the values you set
# (MSA_HOST, MSA_PUBLIC_URL, MSA_PORT and any other lines), and your AI keys at the bottom.
KEEP_ENV=0; [ "$UPDATE" = 1 ] && [ -f "$ETC/env" ] && KEEP_ENV=1
envval() { [ -f "$ETC/env" ] && sed -n "s/^$1=//p" "$ETC/env" | head -1 || true; }
if [ "$KEEP_ENV" = 1 ]; then
  say "Keeping your settings file as it is ($ETC/env)"
  PUBLIC_URL="$(envval MSA_PUBLIC_URL)"; ADMIN_LINE="$(envval MSA_ADMIN_PHONE)"
else
  PUBLIC_URL=""
  if [ -n "${MSA_DOMAIN:-}" ]; then PUBLIC_URL="https://$MSA_DOMAIN"; else PUBLIC_URL="$(envval MSA_PUBLIC_URL)"; fi
  if [ -z "$PUBLIC_URL" ]; then
    IP=""
    for u in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
      IP="$(curl -4 -fsS --max-time 8 "$u" 2>/dev/null | tr -d '[:space:]')" || true
      [[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && break || IP=""
    done
    [ -n "$IP" ] || die "Could not find this server's public IPv4. Re-run with MSA_DOMAIN=your.domain"
    PUBLIC_URL="https://msg.${IP//./-}.sslip.io"
  fi
  HOST_LINE="${MSA_HOST:-$(envval MSA_HOST)}"; HOST_LINE="${HOST_LINE:-127.0.0.1}"
  PORT_LINE="$(envval MSA_PORT)"; PORT_LINE="${PORT_LINE:-$PORT}"
  ADMIN_LINE="$(envval MSA_ADMIN_PHONE)"
  [ -n "${MSA_ADMIN_PHONE:-}" ] && ADMIN_LINE="$MSA_ADMIN_PHONE"
  KEEP=""; EXTRA=""
  if [ -f "$ETC/env" ]; then
    KEEP="$(sed -n '/^# ---- your AI keys/,$p' "$ETC/env" | tail -n +2)"
    EXTRA="$(sed -n '1,/^# ---- your AI keys/p' "$ETC/env" | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' | grep -vE '^(MSA_PUBLIC_URL|MSA_DATA_DIR|MSA_PORT|MSA_HOST|MSA_ADMIN_PHONE|PLAYWRIGHT_BROWSERS_PATH|NODE_ENV)=' || true)"
  fi
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
MSA_PORT=$PORT_LINE
MSA_HOST=$HOST_LINE
MSA_ADMIN_PHONE=$ADMIN_LINE
PLAYWRIGHT_BROWSERS_PATH=$BROWSERS
NODE_ENV=production
${EXTRA:+$EXTRA
}# ---- your AI keys (kept on update) ----
$KEEP
EOF
fi
DOMAIN="$(printf '%s' "$PUBLIC_URL" | sed 's#^https\?://##; s#/.*##')"
say "Dashboard address: $PUBLIC_URL"
PORT="$(envval MSA_PORT)"; PORT="${PORT:-8788}"
HC_HOST="$(envval MSA_HOST)"; case "$HC_HOST" in ""|0.0.0.0|::|"[::]") HC_HOST=127.0.0.1;; esac

# ---------- systemd ----------
# 1.0.1: the unit is rewritten on every install AND update, so ExecStart always points at current/src/server.js
# (a hand-edited releases/<version> path is repaired).
UNIT_BEFORE="$(cat "$UNIT" 2>/dev/null || true)"
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
UNIT_CHANGED=0; [ "$DRY" != 1 ] && [ "$UNIT_BEFORE" != "$(cat "$UNIT")" ] && UNIT_CHANGED=1
[ "$UNIT_CHANGED" = 1 ] && [ -n "$UNIT_BEFORE" ] && say "Repaired the service file (ExecStart → $OPT/current/src/server.js)"

# ---------- updates (1.0.1): only when the admin asks ("Update now" in the dashboard, or sudo messageassistant update) ----------
write_file /usr/local/sbin/messageassistant-update 755 root:root <<EOF
#!/usr/bin/env bash
# Message Assistant updater (1.0.1+). Started by:
#   (no timer: updates only when the admin asks)
#   the dashboard's "Update now" (writes $DATA/update-request; messageassistant-update.path starts this)
#   sudo messageassistant update
# It reads version.json at the source and installs only a NEWER version (sha256-checked) with that version's own
# install.sh in update mode: database backup → releases/<version> → switch "current" → restart → /healthz →
# automatic rollback to the previous release if the new one does not answer. It never changes $ETC/env,
# the Caddy files or your data (it only adds a database backup and its status/log files in $DATA).
set -uo pipefail
AUTO=0; [ "\${1:-}" = "--auto" ] && AUTO=1
if [ -f "$DATA/update-request" ]; then rm -f "$DATA/update-request"; AUTO=0; REQ=1; else REQ=0; fi
exec 9>/run/messageassistant-update.lock
flock -n 9 || { echo "Another update is already running."; exit 0; }
if [ -n "\${INVOCATION_ID:-}" ]; then exec > >(tee "$DATA/update.log") 2>&1       # under systemd: the journal has it
else exec > >(tee "$DATA/update.log" >(logger -t messageassistant-update)) 2>&1; fi
LATEST=""
vgt() { [ "\$1" != "\$2" ] && [ "\$(printf '%s\n%s\n' "\$1" "\$2" | sort -V | tail -1)" = "\$1" ]; }
status() {
  local m; m="\$(printf '%s' "\$2" | tr -d '"\\\\' | tr '\n' ' ')"
  printf '{"at":"%s","result":"%s","current":"%s","latest":"%s","message":"%s"}\n' "\$(date -Is)" "\$1" "\$(cat $OPT/current/VERSION 2>/dev/null)" "\$LATEST" "\$m" > "$DATA/update-status.json.tmp" \
    && chown $APP_USER:$APP_USER "$DATA/update-status.json.tmp" && chmod 640 "$DATA/update-status.json.tmp" && mv -f "$DATA/update-status.json.tmp" "$DATA/update-status.json"
}
fail() { echo "Not updated: \$1"; status failed "\$1"; exit 1; }
echo "=== update check \$(date -Is) (\$( [ \$AUTO = 1 ] && echo automatic || { [ \$REQ = 1 ] && echo 'Update now in the dashboard' || echo 'by hand'; } )) ==="
if [ \$AUTO = 1 ] && [ "\$(tr -d '[:space:]' 2>/dev/null < "$DATA/auto-update")" = off ]; then
  echo "Auto-update is off (dashboard → Settings → Updates). Nothing done."; exit 0
fi
CUR="\$(cat $OPT/current/VERSION 2>/dev/null || echo 0.0.0)"
# 1.0.3: the address saved in the dashboard (Settings → Updates → Update source) or with
# `sudo messageassistant update-source set <url>`. Checked again here: https only, nothing else on the line.
SAVED=""
if [ -f "$DATA/update-source" ]; then
  SAVED="\$(head -c 400 "$DATA/update-source" | head -1 | tr -d '\r[:space:]')"
  if ! printf '%s' "\$SAVED" | grep -Eq '^https://[A-Za-z0-9.-]+[.][A-Za-z]{2,}(:[0-9]{1,5})?(/[A-Za-z0-9._~%+=,/-]*)?\$'; then
    [ -n "\$SAVED" ] && echo "Ignoring the saved update source (it is not an https address)."; SAVED=""
  fi
fi
SRCS="\${MSA_SOURCE:-} \$SAVED \$(sed -n 's/^MSA_UPDATE_SOURCE=//p' $ETC/env 2>/dev/null | head -1) $DEFAULT_SOURCE"
BASE=""; SEEN=" "
for b in \$SRCS; do
  b="\${b%/}"; case "\$SEEN" in *" \$b "*) continue;; esac; SEEN="\$SEEN\$b "
  v="\$(curl -fsSL --max-time 20 -H 'Cache-Control: no-cache' "\$b/version.json?t=\$(date +%s)" 2>/dev/null | tr -d '\n' | sed -n 's/.*"version" *: *"v\{0,1\}\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p')"
  if [ -z "\$v" ]; then echo "source \$b: no answer"; continue; fi
  if [ -z "\$LATEST" ] || vgt "\$v" "\$LATEST"; then LATEST="\$v"; BASE="\$b"; fi
  vgt "\$LATEST" "\$CUR" && break
done
[ -n "\$LATEST" ] || fail "no update source answered (will try again later)"
echo "This server: \$CUR · newest at \$BASE: \$LATEST"
if ! vgt "\$LATEST" "\$CUR"; then echo "Up to date."; status up_to_date "Up to date (\$CUR)"; exit 0; fi
if [ \$AUTO = 1 ] && grep -qx "\$LATEST" "$DATA/update-skip" 2>/dev/null; then
  echo "Version \$LATEST did not start here before; the timer skips it. To try again: sudo messageassistant update"; exit 0
fi
status running "Installing \$LATEST"
W="\$(mktemp -d)"; trap 'rm -rf "\$W"' EXIT
GOT=0
for name in "messageassistant-\$LATEST.tar.gz" messageassistant-latest.tar.gz; do
  if curl -fsSL --max-time 300 "\$BASE/\$name" -o "\$W/app.tgz" && curl -fsSL --max-time 30 "\$BASE/\$name.sha256" -o "\$W/app.sha256"; then GOT=1; break; fi
done
[ \$GOT = 1 ] || fail "could not download version \$LATEST from \$BASE"
want="\$(awk '{print tolower(\$1)}' "\$W/app.sha256")"; got="\$(sha256sum "\$W/app.tgz" | awk '{print \$1}')"
{ [ \${#want} = 64 ] && [ "\$want" = "\$got" ]; } || fail "the download did not match its sha256; not installing"
mkdir -p "\$W/x" && tar -xzf "\$W/app.tgz" -C "\$W/x" || fail "the download could not be unpacked"
[ "\$(cat "\$W/x/messageassistant/VERSION" 2>/dev/null)" = "\$LATEST" ] && [ -f "\$W/x/messageassistant/install.sh" ] || fail "the download is not version \$LATEST"
MSA_UPDATE=1 MSA_LOCAL_TARBALL="\$W/app.tgz" MSA_SOURCE="\$BASE" bash "\$W/x/messageassistant/install.sh"
RC=\$?
if [ \$RC != 0 ] && grep -q '"result":"running"' "$DATA/update-status.json" 2>/dev/null; then status failed "the installer stopped (exit \$RC); see: sudo messageassistant logs"; fi
echo "=== update finished \$(date -Is) (exit \$RC) ==="
exit \$RC
EOF
write_file /etc/systemd/system/messageassistant-update.service 644 root:root <<EOF
[Unit]
Description=Message Assistant update (Update now in the dashboard)
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/bin/messageassistant update --auto
TimeoutStartSec=45min
EOF
# No automatic timer: updates run only when the admin presses "Update now" or types `sudo messageassistant update`.
if [ "$DRY" != 1 ] && [ -e /etc/systemd/system/messageassistant-update.timer ]; then systemctl disable --now messageassistant-update.timer >/dev/null 2>&1 || true; rm -f /etc/systemd/system/messageassistant-update.timer; fi
write_file /etc/systemd/system/messageassistant-update.path 644 root:root <<EOF
[Unit]
Description=Message Assistant "Update now" button
[Path]
PathExists=$DATA/update-request
Unit=messageassistant-update.service
[Install]
WantedBy=multi-user.target
EOF
write_file /usr/local/bin/messageassistant 755 root:root <<'EOF'
#!/usr/bin/env bash
# Message Assistant helper. Usage: sudo messageassistant {status|url|logs|restart|update|update-source|check-update|version|backup|reset-password|admin-phone|users|approve|block|remove|keys|sites|sites-approval|sites-access|sites-allow|sites-deny|sites-limits|sites-unpublish|portal|uninstall}
set -euo pipefail
DATA=/var/lib/messageassistant
cli() { cd /tmp && set -a && . /etc/messageassistant/env && set +a && runuser -u messageassistant -- node --disable-warning=ExperimentalWarning /opt/messageassistant/current/src/cli.js "$@"; }
url() { sed -n 's/^MSA_PUBLIC_URL=//p' /etc/messageassistant/env; }
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo messageassistant ${1:-status}"; exit 1; }
case "${1:-status}" in
  status) systemctl --no-pager status messageassistant | head -8; echo; cli info; echo "Dashboard: $(url)";;
  url) url;;
  logs) journalctl -u messageassistant -u messageassistant-update -n "${2:-100}" --no-pager;;
  restart) systemctl restart messageassistant && echo "Restarted.";;
  update) /usr/local/sbin/messageassistant-update "${2:-}";;
  version) echo "Installed: $(cat /opt/messageassistant/current/VERSION)"; echo "Updates: only when you press Update now (dashboard) or run: sudo messageassistant update"
           [ -f $DATA/update-status.json ] && echo "Last check: $(cat $DATA/update-status.json)" || true;;
  backup) f="$DATA/backups/manual-$(date +%Y%m%d-%H%M%S).db"; mkdir -p "$DATA/backups"; chown messageassistant:messageassistant "$DATA/backups"; cd /tmp && runuser -u messageassistant -- node --disable-warning=ExperimentalWarning -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('$DATA/messageassistant.db').exec(\"VACUUM INTO '$f'\")" && echo "Saved $f (keep master.key with it: $DATA/master.key)";;
  reset-password|admin-phone|users|approve|block|remove|keys|has-password|sites|sites-approval|sites-access|sites-allow|sites-deny|sites-limits|sites-unpublish|check-update|update-source|portal) shift_cmd="$1"; shift; cli "$shift_cmd" "$@";;
  uninstall) bash /opt/messageassistant/current/uninstall.sh "${2:-}";;
  *) echo "Usage: sudo messageassistant {status|url|logs|restart|update|check-update|update-source show|set <url>|reset|version|backup|reset-password [new]|admin-phone +1...|users|approve <#>|block <#>|remove <#>|keys|sites|sites-approval on|off|show|sites-access all|chosen|off|sites-allow <#>|sites-deny <#>|sites-limits [MB] [sites]|sites-unpublish <#|name>|portal on|off|show|uninstall [--purge]}";;
esac
EOF

if [ "$UPDATE" != 1 ]; then   # 1.0.1: an update never touches the Caddy files or the firewall
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

fi

# ---------- start ----------
health_ok() { # health_ok <version>: /healthz answers with that version within ~60 s
  local i out
  for i in $(seq 1 60); do
    out="$(curl -fsS --max-time 3 "http://$HC_HOST:$PORT/healthz" 2>/dev/null || true)"
    case "$out" in *'"ok":true'*'"version":"'"$1"'"'*) return 0;; esac
    sleep 1
  done
  return 1
}
upd_status() { # the dashboard reads this (Settings → Updates)
  [ "$DRY" = 1 ] && return 0
  local m; m="$(printf '%s' "$2" | tr -d '"\\' | tr '\n' ' ')"
  printf '{"at":"%s","result":"%s","current":"%s","latest":"%s","message":"%s"}\n' "$(date -Is)" "$1" "$(cat "$OPT/current/VERSION" 2>/dev/null)" "$VERSION" "$m" > "$DATA/update-status.json.tmp" \
    && chown "$APP_USER:$APP_USER" "$DATA/update-status.json.tmp" && chmod 640 "$DATA/update-status.json.tmp" && mv -f "$DATA/update-status.json.tmp" "$DATA/update-status.json" || true
}
say "Starting"
run systemctl daemon-reload
run systemctl enable messageassistant >/dev/null 2>&1 || true
run systemctl enable messageassistant-update.path >/dev/null 2>&1 || true
run systemctl restart messageassistant-update.path || warn "Could not start the Update now watcher."
if [ "$NOCHANGE" = 1 ] && [ "$UNIT_CHANGED" = 0 ] && [ "$DRY" != 1 ] && health_ok "$VERSION"; then
  say "Running $VERSION; nothing to restart."
  upd_status up_to_date "Up to date ($VERSION)"
else
  run systemctl restart messageassistant
fi
if [ "$UPDATE" != 1 ]; then run systemctl enable caddy >/dev/null 2>&1 || true; run systemctl restart caddy; fi
NEWPW=""
if [ "$DRY" != 1 ]; then
  if ! health_ok "$VERSION"; then
    journalctl -u messageassistant -n 30 --no-pager || true
    if [ -n "$PREV_DIR" ] && [ -f "$PREV_DIR/src/server.js" ] && [ "$PREV_DIR" != "$NEW_DIR" ]; then
      PREV_VER="$(cat "$PREV_DIR/VERSION")"
      warn "Version $VERSION did not start. Going back to $PREV_VER automatically."
      ln -sfn "$PREV_DIR" "$OPT/current.new" && mv -T "$OPT/current.new" "$OPT/current"
      if ! grep -q realpathSync "$PREV_DIR/src/server.js"; then   # 1.0.0 cannot start through the "current" link
        sed -i "s#^ExecStart=.*#ExecStart=/usr/bin/env node --disable-warning=ExperimentalWarning $PREV_DIR/src/server.js#" "$UNIT"
        systemctl daemon-reload
      fi
      systemctl restart messageassistant
      if health_ok "$PREV_VER"; then
        rm -rf "$NEW_DIR"
        echo "$VERSION" >> "$DATA/update-skip"   # remembered (only an automatic run would skip it)
        upd_status rolled_back "Version $VERSION did not start; went back to $PREV_VER (running)."
        die "Update to $VERSION failed: it did not start. Went back to $PREV_VER, which is running. Nothing was lost."
      fi
      upd_status failed "Version $VERSION did not start, and going back to $PREV_VER did not start either."
      die "Version $VERSION did not start, and going back to $PREV_VER did not start either (log above)."
    fi
    upd_status failed "Version $VERSION did not start."
    die "The app did not start (log above)."
  fi
  [ "$NOCHANGE" = 1 ] || { upd_status ok "Updated to $VERSION$( [ -n "${CUR_VER:-}" ] && echo " (from $CUR_VER)")."; sed -i "/^$VERSION\$/d" "$DATA/update-skip" 2>/dev/null || true; }
  # keep the 3 newest releases (never the running one or the one before it)
  for d in $(ls -1dt "$OPT"/releases/*/ 2>/dev/null | tail -n +4); do d="${d%/}"; [ "$d" = "$NEW_DIR" ] || [ "$d" = "$PREV_DIR" ] || rm -rf "$d"; done
  if [ "$UPDATE" != 1 ] && [ ! -f "$DATA/.password-set" ]; then
    if [ "$(/usr/local/bin/messageassistant has-password 2>/dev/null)" = yes ]; then install -m 600 -o "$APP_USER" -g "$APP_USER" /dev/null "$DATA/.password-set"
    else
      NEWPW="$(/usr/local/bin/messageassistant reset-password | sed -n 's/^Admin password: //p')"
      install -m 600 -o "$APP_USER" -g "$APP_USER" /dev/null "$DATA/.password-set"
    fi
  fi
fi

echo
echo "============================================================"
if [ "$UPDATE" = 1 ]; then echo " Message Assistant $VERSION is running. To update later: dashboard → Settings → Updates → Update now."
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
