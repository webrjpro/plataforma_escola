#!/bin/sh
set -eu

: "${PORT:=8080}"
: "${API_PORT:=4000}"
: "${DATABASE_URL:?DATABASE_URL não configurada}"
: "${JWT_SECRET:?JWT_SECRET não configurada}"
: "${RTMP_STREAM_KEY:?RTMP_STREAM_KEY não configurada}"

if [ -z "${FRONTEND_URL:-}" ]; then
  if [ -n "${RAILWAY_PUBLIC_DOMAIN:-}" ]; then
    FRONTEND_URL="https://${RAILWAY_PUBLIC_DOMAIN}"
    export FRONTEND_URL
  else
    echo "FRONTEND_URL ou RAILWAY_PUBLIC_DOMAIN deve estar configurado." >&2
    exit 1
  fi
fi

if [ -z "${BROADCAST_INTERNAL_URL:-}" ]; then
  BROADCAST_INTERNAL_URL="http://127.0.0.1:${PORT}"
  export BROADCAST_INTERNAL_URL
fi

case "$PORT" in
  ''|*[!0-9]*)
    echo "PORT deve ser uma porta numérica válida." >&2
    exit 1
    ;;
esac

mkdir -p \
  /data/images \
  /data/videos \
  /data/documents \
  /data/hls \
  /data/temp \
  /run/nginx \
  /var/cache/nginx/hls \
  /var/lib/nginx/tmp/body \
  /var/lib/nginx/tmp/proxy

# Application files are already copied with the correct owner at build time.
# Only the mounted data volume can arrive with host/Railway ownership.
chown -R eduvault:eduvault /data
chown -R nginx:nginx /run/nginx /var/cache/nginx /var/lib/nginx

echo "[railway] aguardando PostgreSQL e aplicando migrações Prisma..."
attempt=0
until su-exec eduvault sh -c 'cd /app/api && ./node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma'; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "[railway] migração falhou após 30 tentativas" >&2
    exit 1
  fi
  echo "[railway] banco ainda indisponível; tentativa $attempt/30..."
  sleep 3
done

if [ "${SEED_ON_START:-false}" = "true" ]; then
  echo "[railway] garantindo administrador inicial..."
  su-exec eduvault sh -c 'cd /app/api && node dist/prisma/seed.js'
fi

envsubst '$PORT' \
  < /app/deploy/nginx.conf.template \
  > /etc/nginx/nginx.conf

nginx -t

exec /usr/bin/supervisord -c /etc/supervisord.conf
