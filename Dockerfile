FROM alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b AS build
RUN apk upgrade --no-cache \
    && apk add --no-cache nodejs=24.18.1-r0 npm 'libssl3>=3.5.8-r0' 'libcrypto3>=3.5.8-r0'
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
COPY shared ./shared
COPY public ./public
COPY scripts/build-pwa.mjs ./scripts/build-pwa.mjs
RUN npm run build \
    && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b AS runtime
# Alpine's Node package dynamically links OpenSSL. Upgrade the shared libraries
# independently of the Node Docker tag, which currently contains OpenSSL 3.5.7.
# This runtime has no npm, yarn, compiler or Node development headers.
RUN apk upgrade --no-cache \
    && apk add --no-cache nodejs=24.18.1-r0 'libssl3>=3.5.8-r0' 'libcrypto3>=3.5.8-r0' \
    && addgroup -g 1000 -S node \
    && adduser -S -D -H -u 1000 -G node node
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /build/dist ./dist
COPY --from=build --chown=node:node /build/node_modules ./node_modules
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node server ./server
# The root filesystem remains read-only. ECS mounts a dedicated writable
# ephemeral volume here for atomically refreshed, read-only SQLite catalog files.
RUN chmod 1777 /tmp
VOLUME ["/tmp"]
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/server.mjs"]
