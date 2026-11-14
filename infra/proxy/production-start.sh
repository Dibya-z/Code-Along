#!/bin/sh
set -eu

# Only explicit deployment configuration reaches envsubst/sed, never Host input.
validate_host() {
  printf '%s\n' "$1" | awk '
    length($0) > 253 || $0 !~ /^[a-z0-9.-]+$/ { exit 1 }
    {
      n = split($0, labels, ".")
      if (n < 2 || labels[n] == "localhost" ||
          labels[n] !~ /^[a-z][a-z0-9-]*[a-z0-9]$/) exit 1
      for (i = 1; i <= n; i++)
        if (length(labels[i]) > 63 ||
            labels[i] !~ /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/) exit 1
    }'
}

APP_HOST="${APP_ORIGIN#https://}"
RUNNER_HOST="${RUNNER_ORIGIN#https://}"
validate_host "$APP_HOST"
validate_host "$RUNNER_HOST"
[ "$APP_ORIGIN" = "https://$APP_HOST" ]
[ "$RUNNER_ORIGIN" = "https://$RUNNER_HOST" ]
APP_SITE=$(printf '%s\n' "$APP_HOST" | awk -F. '{print $(NF-1) "." $NF}')
RUNNER_SITE=$(printf '%s\n' "$RUNNER_HOST" | awk -F. '{print $(NF-1) "." $NF}')
[ "$APP_SITE" != "$RUNNER_SITE" ]
export APP_HOST RUNNER_HOST
[ "${1:-}" != "--check" ] || exit 0

# The image/static trees remain read-only. Only this generated bootstrap is
# served at the runner's exact / route; /index.html is not exposed.
sed "s|%APP_ORIGIN%|$APP_ORIGIN|g" /srv/runner/index.html > /tmp/code-along-runner-index.html
mkdir -p /etc/nginx/conf.d/app
# Whitelist substitutions; preserve Nginx's own $uri/$request_uri variables.
variables='${APP_HOST} ${RUNNER_HOST} ${APP_ORIGIN} ${RUNNER_ORIGIN}'
envsubst "$variables" < /etc/code-along/production.conf.template > /etc/nginx/conf.d/default.conf
envsubst "$variables" < /etc/nginx/templates/app/csp.conf.template > /etc/nginx/conf.d/app/csp.conf
envsubst "$variables" < /etc/nginx/templates/app/content.conf.template > /etc/nginx/conf.d/app/content.conf
exec "$@"
