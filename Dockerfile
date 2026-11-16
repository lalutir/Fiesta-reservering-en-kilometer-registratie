# syntax=docker/dockerfile:1
#
# Shared car app. Zero runtime npm dependencies: the final image only needs the
# compiled JavaScript, the browser files and Node itself (node:sqlite is built in).
#
# NODE_VERSION is the ONE place the Node version is set (docker-compose.yml does
# not override it). It is pinned to a minor so two builds of the same commit run
# the same Node: node:sqlite is still experimental in Node 22, so move this up
# deliberately, see docs/DEPLOYMENT.md "Pinning the Node version". Patch and
# Alpine security updates arrive with `docker compose build --pull`.
ARG NODE_VERSION=22.23

# ---- build: install dev tooling, compile TypeScript to dist/ -------------------
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY shared ./shared
COPY src ./src
RUN npm run build

# ---- runtime: no npm install, no dev tooling -----------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production \
    BIND_HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data
WORKDIR /app
# package.json marks the project root (the app finds public/ and shared/ from it)
# and declares "type": "module".
COPY package.json ./
COPY --from=build /app/dist ./dist
# shared/ is needed twice: compiled in dist/shared for the server, and as the
# source file the browser downloads from /shared/time.js.
COPY shared ./shared
COPY public ./public
# The data directory must exist and be writable by the unprivileged user BEFORE
# it is declared a volume, so a fresh named volume inherits this ownership.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/src/server.js"]
