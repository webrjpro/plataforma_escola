FROM node:22.18.0-alpine3.22 AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
# Ignore env vars for build time, we can handle dynamic config via window.CONFIG or relative paths
RUN npm run build

FROM node:22.18.0-alpine3.22 AS backend-build
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npx prisma generate && npm run build && npm prune --omit=dev

FROM node:22.18.0-alpine3.22 AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    API_PORT=4000 \
    RTMP_PORT=1935 \
    MIGRATION_MODE=deploy \
    VIDEO_STORAGE_PATH=/data/videos \
    HLS_STORAGE_PATH=/data/hls \
    IMAGE_STORAGE_PATH=/data/images \
    PDF_STORAGE_PATH=/data/documents

WORKDIR /app

RUN apk upgrade --no-cache \
    && apk add --no-cache \
      ffmpeg \
      gettext-envsubst \
      nginx \
      nginx-mod-rtmp \
      supervisor \
      su-exec \
      tini \
    && addgroup -S eduvault \
    && adduser -S -G eduvault -h /app eduvault \
    && mkdir -p \
      /app/api \
      /var/www/eduvault \
      /data/images \
      /data/videos \
      /data/documents \
      /data/hls \
      /data/temp \
      /run/nginx \
      /var/cache/nginx/hls \
      /var/lib/nginx/tmp/body \
      /var/lib/nginx/tmp/proxy \
    && chown -R eduvault:eduvault /app /data /var/www/eduvault \
    && chown -R nginx:nginx /run/nginx /var/cache/nginx /var/lib/nginx \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx

COPY --from=backend-build --chown=eduvault:eduvault /app/backend/node_modules /app/api/node_modules
COPY --from=backend-build --chown=eduvault:eduvault /app/backend/dist /app/api/dist
COPY --from=backend-build --chown=eduvault:eduvault /app/backend/package.json /app/api/package.json
COPY --from=backend-build --chown=eduvault:eduvault /app/backend/prisma /app/api/prisma

COPY --from=frontend-build --chown=eduvault:eduvault /app/frontend/dist /var/www/eduvault

COPY deploy/nginx.conf.template /app/deploy/nginx.conf.template
COPY deploy/supervisord.conf /etc/supervisord.conf
COPY deploy/entrypoint.sh /app/deploy/entrypoint.sh

RUN chmod +x /app/deploy/entrypoint.sh

EXPOSE 8080 1935
STOPSIGNAL SIGTERM
ENTRYPOINT ["/sbin/tini", "--", "/app/deploy/entrypoint.sh"]
