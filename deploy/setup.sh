#!/usr/bin/env bash
# One-shot installer for the Artists Hub Discord Bot on an Ubuntu or Oracle Linux VM.
#
#   curl -fsSL https://raw.githubusercontent.com/therealssorw/Artists-Hub-Discord-Bot/claude/daily-bot-stats-message-dlozpl/deploy/setup.sh | bash -s -- YOUR_DISCORD_TOKEN
#
# Installs Node.js 20, clones the repo into ~/artists-hub-bot, writes .env,
# backfills the last 60 days of history, and runs the bot as a systemd service
# that starts on boot and restarts on failure. Safe to re-run to update.
set -euo pipefail

REPO_URL="https://github.com/therealssorw/Artists-Hub-Discord-Bot.git"
BRANCH="${BRANCH:-claude/daily-bot-stats-message-dlozpl}"
APP_DIR="${APP_DIR:-$HOME/artists-hub-bot}"
SERVICE="artists-hub-bot"
TOKEN="${1:-${DISCORD_TOKEN:-}}"

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }

if [[ -z "$TOKEN" && ! -f "$APP_DIR/.env" ]]; then
  read -rp "Discord bot token: " TOKEN
fi

log "Installing Node.js 20 and git"
if command -v apt-get >/dev/null; then
  sudo apt-get update -y
  sudo apt-get install -y ca-certificates curl git
  if ! command -v node >/dev/null || [[ "$(node -v | cut -c2-3)" -lt 18 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
elif command -v dnf >/dev/null; then
  sudo dnf install -y git curl
  if ! command -v node >/dev/null || [[ "$(node -v | cut -c2-3)" -lt 18 ]]; then
    sudo dnf module reset -y nodejs || true
    sudo dnf module enable -y nodejs:20
    sudo dnf install -y nodejs
  fi
else
  echo "Unsupported distro: need apt-get or dnf" >&2
  exit 1
fi
node -v

log "Fetching the bot into $APP_DIR"
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout -q "$BRANCH"
  git -C "$APP_DIR" reset -q --hard "origin/$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

log "Installing dependencies"
npm ci --omit=dev

if [[ -n "$TOKEN" ]]; then
  log "Writing .env"
  cat > .env <<ENV
DISCORD_TOKEN=$TOKEN
STATS_CHANNEL_ID=${STATS_CHANNEL_ID:-1548706786893238322}
DATABASE_PATH=$APP_DIR/data/stats.db
TIMEZONE=America/New_York
ENV
  chmod 600 .env
fi

log "Installing systemd service"
NODE_BIN="$(command -v node)"
sed -e "s|__USER__|$(id -un)|g" -e "s|__APP_DIR__|$APP_DIR|g" -e "s|/usr/bin/node|$NODE_BIN|g" \
  deploy/artists-hub-bot.service | sudo tee /etc/systemd/system/$SERVICE.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl stop $SERVICE 2>/dev/null || true

if [[ ! -f data/stats.db ]]; then
  log "Backfilling the last 60 days of message history (one-time)"
  set -a; source .env; set +a
  npm run backfill
fi

log "Starting the bot"
sudo systemctl enable --now $SERVICE
sleep 3
sudo systemctl --no-pager --lines=15 status $SERVICE || true

log "Done. Logs: journalctl -u $SERVICE -f"
