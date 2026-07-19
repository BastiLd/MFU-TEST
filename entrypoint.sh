#!/bin/sh
# WebHafen — Container-Start: Ordner anlegen, dann alle Dienste starten.
set -e

mkdir -p /data/sites /data/logs /data/analytics /data/caddy/data /data/caddy/config /data/tmp

exec supervisord -c /etc/supervisord.conf
