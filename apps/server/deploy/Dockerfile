# Build from the repository root:  docker build -f apps/server/deploy/Dockerfile -t tm-hub-server .
# Not built on the development PC (no Docker there); the systemd setup is the tested path.
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared packages/shared
COPY packages/catalog packages/catalog
COPY apps/server apps/server
COPY apps/launcher/src/generated/hub/mods.json apps/launcher/src/generated/hub/mods.json
RUN npm install --omit=dev --no-audit --no-fund --workspace @tm-hub/server --include-workspace-root=false \
 && useradd --system --uid 10010 tmhub && mkdir -p /var/lib/tm-hub && chown tmhub /var/lib/tm-hub
USER tmhub
WORKDIR /app/apps/server
EXPOSE 8787
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
