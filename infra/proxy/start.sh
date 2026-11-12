#!/bin/sh
set -eu
# This is an explicitly configured development origin, never request input.
case "$APP_ORIGIN" in https://127.0.0.1:[0-9]*|https://localhost:[0-9]*) ;; *) exit 1 ;; esac
sed -i "s|%APP_ORIGIN%|$APP_ORIGIN|g" /srv/runner/index.html
