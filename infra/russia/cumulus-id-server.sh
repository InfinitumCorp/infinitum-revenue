#!/bin/bash
# Cumulus://ID sign-in from Russia, served from its own Yandex server (cumulus-id-russia).
# Runs the +SPCTR mirror (InfinitumCorp/infinitum-nexus apps/spectre/mirror/server.mjs, pinned and
# checksum-verified) behind nginx + Let's Encrypt at ru.id.cumuluscloud.app. The mirror is stateless:
# it streams each request to id.cumuluscloud.app, and the Worker already accepts this origin
# (SPECTRE_EXTRA_ORIGINS), so moving the name from Cloud Run to here needs no Cumulus ID change.
# Run on the server; re-runnable. If GitHub is unreachable from the server, copy server.mjs to
# /tmp/spctr-mirror.mjs first (the checksum is still verified).
set -euo pipefail
DOMAIN=${DOMAIN:-ru.id.cumuluscloud.app}
NEXUS_SHA=${NEXUS_SHA:-b40afee0f114e173c522caf12ab9ba073c419e7c}
MIRROR_SHA256=${MIRROR_SHA256:-e4b0feef2a8cb37d9b52c532ec9f018bfe048dc43b626d5901041e9baa904e95}
NODE_VERSION=v24.11.0
PORT=8080
log() { echo "[$(date -u +%H:%M:%S)] $*"; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

sudo DEBIAN_FRONTEND=noninteractive apt-get -qq update >/dev/null
sudo DEBIAN_FRONTEND=noninteractive apt-get -qq install -y nginx certbot xz-utils >/dev/null

# Node (official build, checksum-verified)
if [ "$(/usr/local/bin/node -v 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  f="node-$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSL -o "$TMP/$f" "https://nodejs.org/dist/$NODE_VERSION/$f"
  curl -fsSL -o "$TMP/SHASUMS256.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
  (cd "$TMP" && grep " $f\$" SHASUMS256.txt | sha256sum -c - >/dev/null)
  sudo tar -xJf "$TMP/$f" -C /usr/local --strip-components=1 --no-same-owner
fi
log "node $(/usr/local/bin/node -v)"

# The mirror, pinned by commit and checksum
if [ -f /tmp/spctr-mirror.mjs ]; then cp /tmp/spctr-mirror.mjs "$TMP/server.mjs"
else curl -fsSL -o "$TMP/server.mjs" "https://raw.githubusercontent.com/InfinitumCorp/infinitum-nexus/$NEXUS_SHA/apps/spectre/mirror/server.mjs"; fi
echo "$MIRROR_SHA256  $TMP/server.mjs" | sha256sum -c - >/dev/null || { echo "server.mjs checksum mismatch"; exit 1; }
id spctr >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin spctr
sudo install -D -m 0644 "$TMP/server.mjs" /opt/spctr-mirror/server.mjs
echo '{"type":"module"}' | sudo tee /opt/spctr-mirror/package.json >/dev/null

sudo tee /etc/systemd/system/spctr-mirror.service >/dev/null <<UNIT
[Unit]
Description=Cumulus ID mirror for Russia (ru.id.cumuluscloud.app)
After=network-online.target
Wants=network-online.target
[Service]
User=spctr
WorkingDirectory=/opt/spctr-mirror
Environment=NODE_ENV=production PORT=$PORT UPSTREAM=https://id.cumuluscloud.app
ExecStart=/usr/local/bin/node server.mjs
Restart=always
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload && sudo systemctl enable spctr-mirror >/dev/null 2>&1 && sudo systemctl restart spctr-mirror
for _ in $(seq 1 15); do curl -fsS -o /dev/null "http://127.0.0.1:$PORT/.well-known/openid-configuration" 2>/dev/null && break; sleep 1; done
log "mirror -> upstream: $(curl -s -o /dev/null -w '%{http_code}' -H "Host: $DOMAIN" "http://127.0.0.1:$PORT/.well-known/openid-configuration")"

# HTTP: ACME only, rest to HTTPS
sudo mkdir -p /var/www/acme
sudo tee /etc/nginx/sites-available/default >/dev/null <<NGX
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    server_tokens off;
    location /.well-known/acme-challenge/ { root /var/www/acme; }
    location / { return 301 https://$DOMAIN\$request_uri; }
}
NGX
sudo nginx -t -q && sudo systemctl reload nginx

MYIP=$(curl -fsS --max-time 10 https://api.ipify.org || true)
resolves() { for _ in 1 2 3 4 5; do [ -n "$MYIP" ] && [ "$(getent ahostsv4 "$DOMAIN" | awk '{print $1; exit}')" = "$MYIP" ] && return 0; sleep 3; done; return 1; }
if ! resolves; then
  log "DNS for $DOMAIN does not point at ${MYIP:-this server} yet (it still points at Cloud Run); HTTPS skipped. Move the record, then re-run."
  exit 0
fi
sudo test -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" || \
  sudo certbot certonly --webroot -w /var/www/acme -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --quiet

sudo tee /etc/nginx/sites-available/cumulus-id-russia >/dev/null <<NGX
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name $DOMAIN;
    server_tokens off;
    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    add_header Strict-Transport-Security "max-age=31536000" always;
    client_max_body_size 10M;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_buffering off;
        proxy_read_timeout 120s;
    }
}
NGX
sudo ln -sf /etc/nginx/sites-available/cumulus-id-russia /etc/nginx/sites-enabled/cumulus-id-russia
sudo nginx -t -q && sudo systemctl reload nginx
echo -e '#!/bin/sh\nsystemctl reload nginx' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh >/dev/null
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
log "https://$DOMAIN: $(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/.well-known/openid-configuration")"
log "cert: $(sudo openssl x509 -in "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" -noout -enddate)"
