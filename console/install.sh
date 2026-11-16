#!/usr/bin/env bash
# Installs or updates the Argus console on this droplet. Safe to run again.
#   1. user argus-web, /var/lib/argus-console (its data), /opt/argus-console (app copy)
#   2. systemd: argus-agent (root) + argus-console (argus-web), (re)started
#   3. Caddy site argus.fusioneta.com.my -> 127.0.0.1:3200 (added once; Caddyfile backed
#      up and validated before reload)
# First admin afterwards: node /root/argus/console/admin.js add-admin <email> "<Name>"
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
SITE="argus.fusioneta.com.my"
CADDYFILE=/etc/caddy/Caddyfile

id argus-web >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin argus-web
install -d -o argus-web -g argus-web -m 0700 /var/lib/argus-console
install -d -o root -g root -m 0755 /opt/argus-console /opt/argus-console/public
install -o root -g root -m 0644 server.js store.js /opt/argus-console/
install -o root -g root -m 0644 public/* /opt/argus-console/public/
install -o root -g root -m 0644 systemd/argus-agent.service systemd/argus-console.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now argus-agent.service argus-console.service
systemctl restart argus-agent.service argus-console.service
echo "== services: agent $(systemctl is-active argus-agent), console $(systemctl is-active argus-console)"

if ! grep -q "^${SITE} {" "$CADDYFILE"; then
  cp -p "$CADDYFILE" "${CADDYFILE}.bak-$(date +%Y%m%d%H%M%S)"
  printf '\n# Argus console (web app on 127.0.0.1:3200; code in /root/argus/console)\n%s {\n\treverse_proxy 127.0.0.1:3200\n}\n' "$SITE" >> "$CADDYFILE"
  if caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1; then
    systemctl reload caddy
    echo "== Caddy: added ${SITE} and reloaded"
  else
    mv "$(ls -t ${CADDYFILE}.bak-* | head -1)" "$CADDYFILE"
    echo "== Caddy: the new config didn't validate, so the old one was restored. Console not published." >&2
    exit 1
  fi
else
  echo "== Caddy: ${SITE} already configured"
fi
