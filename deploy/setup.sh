#!/bin/bash
# =============================================================================
# ReplAI Server Setup — One-time provisioning for Hetzner VPS (Ubuntu 22.04+)
# Run as root: bash setup.sh
# =============================================================================

set -euo pipefail

APP_DIR="/opt/replai"
APP_USER="replai"
REPO_URL=""  # Set before running, or pass as argument
BACKUP_DIR="$APP_DIR/backups"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ---- Pre-flight checks ----

if [ "$EUID" -ne 0 ]; then
  error "Please run as root: sudo bash setup.sh"
fi

if [ -z "$REPO_URL" ] && [ -n "${1:-}" ]; then
  REPO_URL="$1"
fi

if [ -z "$REPO_URL" ]; then
  error "Set REPO_URL at the top of this script or pass it as an argument:\n  bash setup.sh git@github.com:user/replai.git"
fi

# ---- 1. System packages ----

info "Updating system packages..."
apt update && apt upgrade -y

info "Installing dependencies..."
apt install -y \
  build-essential \
  git \
  curl \
  nginx \
  certbot \
  python3-certbot-nginx \
  sqlite3 \
  jq \
  ufw

# ---- 2. Node.js 22 LTS ----

if ! command -v node &>/dev/null || [[ "$(node -v)" != v22* ]]; then
  info "Installing Node.js 22 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt install -y nodejs
else
  info "Node.js 22 already installed: $(node -v)"
fi

# ---- 3. Create app user ----

if ! id "$APP_USER" &>/dev/null; then
  info "Creating system user: $APP_USER"
  useradd --system --shell /bin/bash --home-dir "$APP_DIR" --create-home "$APP_USER"
else
  info "User $APP_USER already exists"
fi

# ---- 4. Firewall ----

info "Configuring UFW firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
info "Firewall enabled — only SSH and Nginx (80/443) open"

# ---- 5. SSH deploy key ----

SSH_DIR="$APP_DIR/.ssh"
KEY_FILE="$SSH_DIR/id_ed25519"

if [ ! -f "$KEY_FILE" ]; then
  info "Generating SSH deploy key..."
  mkdir -p "$SSH_DIR"
  ssh-keygen -t ed25519 -f "$KEY_FILE" -N "" -C "replai-deploy@$(hostname)"
  chown -R "$APP_USER:$APP_USER" "$SSH_DIR"
  chmod 700 "$SSH_DIR"
  chmod 600 "$KEY_FILE"

  # Configure SSH to use this key for GitHub
  cat > "$SSH_DIR/config" <<SSHEOF
Host github.com
  IdentityFile $KEY_FILE
  StrictHostKeyChecking accept-new
SSHEOF
  chown "$APP_USER:$APP_USER" "$SSH_DIR/config"
  chmod 600 "$SSH_DIR/config"

  echo ""
  warn "=== ADD THIS DEPLOY KEY TO GITHUB ==="
  echo "Go to: GitHub repo → Settings → Deploy Keys → Add deploy key"
  echo "Title: replai-deploy-$(hostname)"
  echo ""
  cat "${KEY_FILE}.pub"
  echo ""
  warn "=== Press Enter after adding the key to GitHub ==="
  read -r
else
  info "Deploy key already exists"
fi

# ---- 6. Clone repo ----

if [ ! -d "$APP_DIR/.git" ]; then
  info "Cloning repository..."
  sudo -u "$APP_USER" git clone "$REPO_URL" "$APP_DIR"
else
  info "Repository already cloned, pulling latest..."
  cd "$APP_DIR"
  sudo -u "$APP_USER" git fetch origin main
  sudo -u "$APP_USER" git reset --hard origin/main
fi

# ---- 7. Install dependencies ----

info "Installing npm dependencies..."
cd "$APP_DIR"
sudo -u "$APP_USER" npm install --production

# ---- 8. Create directories ----

info "Creating data and backup directories..."
mkdir -p "$APP_DIR/data" "$BACKUP_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR/data" "$BACKUP_DIR"

# ---- 9. Environment file ----

if [ ! -f "$APP_DIR/.env" ]; then
  info "Copying .env.production template..."
  cp "$APP_DIR/deploy/.env.production" "$APP_DIR/.env"
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  warn "Edit /opt/replai/.env with your production secrets before starting!"
else
  info ".env already exists — not overwriting"
fi

# ---- 10. Sudoers — allow replai user to restart the app ----

info "Configuring sudoers for deploy..."
cat > /etc/sudoers.d/replai <<SUDOEOF
# Allow replai user to restart the app service (for deploy webhook)
$APP_USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart replai
SUDOEOF
chmod 440 /etc/sudoers.d/replai

# ---- 11. Install systemd services ----

info "Installing systemd services..."
cp "$APP_DIR/deploy/replai.service" /etc/systemd/system/replai.service
cp "$APP_DIR/deploy/deploy-webhook.service" /etc/systemd/system/replai-deploy.service
systemctl daemon-reload
systemctl enable replai replai-deploy

# ---- 12. Install Nginx config ----

info "Installing Nginx config..."
cp "$APP_DIR/deploy/nginx-replai.conf" /etc/nginx/sites-available/replai
ln -sf /etc/nginx/sites-available/replai /etc/nginx/sites-enabled/replai
rm -f /etc/nginx/sites-enabled/default

# Test Nginx config
nginx -t || error "Nginx config test failed!"
systemctl reload nginx

# ---- 13. Install backup cron ----

info "Installing daily backup cron..."
CRON_LINE="0 3 * * * /opt/replai/deploy/backup.sh >> /opt/replai/backups/cron.log 2>&1"
(crontab -u "$APP_USER" -l 2>/dev/null | grep -v 'backup.sh'; echo "$CRON_LINE") | crontab -u "$APP_USER" -

chmod +x "$APP_DIR/deploy/backup.sh"

# ---- 14. Start services ----

info "Starting services..."
systemctl start replai-deploy

# Don't start the app yet — .env needs secrets first
if grep -q "^GEMINI_API_KEY=$" "$APP_DIR/.env"; then
  warn "App NOT started — edit /opt/replai/.env first, then: sudo systemctl start replai"
else
  systemctl start replai
  info "App started!"
fi

# ---- Done ----

echo ""
echo "============================================="
echo -e "${GREEN}Setup complete!${NC}"
echo "============================================="
echo ""
echo "Next steps:"
echo ""
echo "1. Edit secrets:"
echo "   nano /opt/replai/.env"
echo ""
echo "2. Start the app (if not already running):"
echo "   sudo systemctl start replai"
echo ""
echo "3. Point your domain DNS (A record) to this server's IP"
echo ""
echo "4. Set up SSL:"
echo "   Edit /etc/nginx/sites-available/replai — replace YOUR_DOMAIN"
echo "   sudo nginx -t && sudo systemctl reload nginx"
echo "   sudo certbot --nginx -d YOUR_DOMAIN"
echo ""
echo "5. Update .env with BASE_URL=https://YOUR_DOMAIN"
echo "   sudo systemctl restart replai"
echo ""
echo "6. Add GitHub webhook:"
echo "   URL: https://YOUR_DOMAIN/hooks/deploy"
echo "   Secret: (same as DEPLOY_WEBHOOK_SECRET in .env)"
echo "   Events: Just the push event"
echo ""
echo "7. Update Meta WhatsApp webhook URL:"
echo "   https://YOUR_DOMAIN/webhook"
echo ""
echo "Useful commands:"
echo "  sudo systemctl status replai          # App status"
echo "  sudo systemctl status replai-deploy   # Webhook status"
echo "  journalctl -u replai -f               # App logs"
echo "  journalctl -u replai-deploy -f        # Deploy logs"
echo "  curl localhost:3000/health             # Health check"
echo ""
