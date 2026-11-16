#!/usr/bin/env bash
# Installs or updates the Aegis console on this droplet. Safe to run again.
#   1. user aegis-web, /var/lib/aegis-console (its data), /opt/aegis-console (app copy)
#   2. systemd: aegis-agent (root) + aegis-console (aegis-web), (re)started
#   3. Caddy site aegis.fusioneta.com.my -> 127.0.0.1:3200, added once its DNS points here;
#      then the old argus.fusioneta.com.my forwards to it (Caddyfile backed up, validated
#      before reload, restored if it doesn't validate)
# First admin afterwards: node /root/aegis/console/admin.js add-admin <email> "<Name>"
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
SITE="aegis.fusioneta.com.my"
CADDYFILE=/etc/caddy/Caddyfile

id aegis-web >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin aegis-web
install -d -o aegis-web -g aegis-web -m 0700 /var/lib/aegis-console
install -d -o root -g root -m 0755 /opt/aegis-console /opt/aegis-console/public
install -o root -g root -m 0644 server.js store.js /opt/aegis-console/
install -o root -g root -m 0644 public/* /opt/aegis-console/public/
install -o root -g root -m 0644 systemd/aegis-agent.service systemd/aegis-console.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now aegis-agent.service aegis-console.service
systemctl restart aegis-agent.service aegis-console.service
echo "== services: agent $(systemctl is-active aegis-agent), console $(systemctl is-active aegis-console)"

# Applies a Caddyfile change made by "$@" (a command editing $CADDYFILE in place): backs it
# up, validates, reloads; restores the backup if it doesn't validate.
caddy_change() {
  local bak="${CADDYFILE}.bak-$(date +%Y%m%d%H%M%S)"
  cp -p "$CADDYFILE" "$bak"
  "$@"
  if caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1; then
    systemctl reload caddy
  else
    cp -p "$bak" "$CADDYFILE"
    echo "== Caddy: the new config didn't validate, so the old one was restored." >&2
    return 1
  fi
}

# The site goes in once its DNS points here; before that Caddy couldn't get a certificate.
HERE="$(curl -s --max-time 5 https://api.ipify.org || true)"
if grep -q "^${SITE} {" "$CADDYFILE"; then
  echo "== Caddy: ${SITE} already configured"
elif [[ -n "$HERE" && "$(getent hosts "$SITE" | awk '{print $1; exit}')" == "$HERE" ]]; then
  caddy_change sh -c "printf '\n# Aegis console (web app on 127.0.0.1:3200; code in /root/aegis/console)\n%s {\n\treverse_proxy 127.0.0.1:3200\n}\n' '$SITE' >> '$CADDYFILE'"
  echo "== Caddy: added ${SITE} and reloaded"
else
  echo "== Caddy: ${SITE} has no DNS record pointing here (${HERE:-unknown IP}) yet, so it was not added. Run this again once it does."
fi

# The old Argus address forwards to the new one, once the new one is configured.
OLD_SITE="argus.fusioneta.com.my"
if grep -q "^${SITE} {" "$CADDYFILE" && grep -qzP "${OLD_SITE//./\\.} \\{\\n\\treverse_proxy" "$CADDYFILE"; then
  caddy_change perl -0pi -e "s|^(\Q${OLD_SITE}\E \\{\\n)\\treverse_proxy 127\\.0\\.0\\.1:3200\\n\\}|\$1\\tredir https://${SITE}{uri} permanent\\n}|m" "$CADDYFILE"
  echo "== Caddy: ${OLD_SITE} now forwards to ${SITE}"
fi
