#!/bin/bash
# One Infinitum product's static site on its own Yandex server: nginx + Let's Encrypt.
# Run on the product's server. Re-runnable.
#   DOMAIN=ru.example.app SITE=example bash static-site-server.sh
# The site's files go in /var/www/$SITE (owned by the non-root `runner` user, so a
# self-hosted GitHub runner can rsync into it). HTTPS is set up only once DOMAIN
# resolves to this server; until then port 80 serves ACME challenges and redirects.
set -euo pipefail
: "${DOMAIN:?set DOMAIN, e.g. ru.scalvs.app}"
: "${SITE:?set SITE, e.g. scalvs-ru}"
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

if ! command -v nginx >/dev/null || ! command -v certbot >/dev/null; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get -qq update >/dev/null
  sudo DEBIAN_FRONTEND=noninteractive apt-get -qq install -y nginx certbot rsync >/dev/null
fi
id runner >/dev/null 2>&1 || sudo useradd --create-home --shell /bin/bash runner
sudo mkdir -p /var/www/acme "/var/www/$SITE"
sudo chown runner:runner "/var/www/$SITE"
sudo test -f "/var/www/$SITE/index.html" || echo "<!doctype html><title>$DOMAIN</title>" | sudo -u runner tee "/var/www/$SITE/index.html" >/dev/null

# HTTP: ACME challenges only, everything else to HTTPS
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
resolves() {
  for _ in 1 2 3 4 5; do
    [ -n "$MYIP" ] && [ "$(getent ahostsv4 "$DOMAIN" | awk '{print $1; exit}')" = "$MYIP" ] && return 0
    sleep 3
  done
  return 1
}
if ! resolves; then
  log "DNS for $DOMAIN does not point at ${MYIP:-this server} yet; HTTPS skipped. Re-run after the A record moves."
  exit 0
fi
if ! sudo test -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem"; then
  sudo certbot certonly --webroot -w /var/www/acme -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --quiet
fi

sudo tee "/etc/nginx/sites-available/$SITE" >/dev/null <<NGX
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
    add_header X-Content-Type-Options nosniff always;
    root /var/www/$SITE;
    index index.html;
    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
    location / { try_files \$uri \$uri/ \$uri.html =404; }
    error_page 404 /404.html;
}
NGX
sudo ln -sf "/etc/nginx/sites-available/$SITE" "/etc/nginx/sites-enabled/$SITE"
sudo nginx -t -q && sudo systemctl reload nginx
echo -e '#!/bin/sh\nsystemctl reload nginx' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh >/dev/null
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
log "https://$DOMAIN -> /var/www/$SITE"
log "cert: $(sudo openssl x509 -in "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" -noout -enddate)"
