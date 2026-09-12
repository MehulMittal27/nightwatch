# NightWatch Channel listener.
#
# This is a LONG-RUNNING WORKER holding an outbound websocket, not a request
# handler. Deploy it like a queue consumer: one instance, always on, never
# scaled to zero. The listening port exists only to satisfy a host health
# check - managed deliveries arrive over the Channel's own socket.
#
# Run exactly ONE of these at a time, and not alongside a local runtime on the
# same Channel: two runtimes declaring one Channel race per delivery and the
# loser silently gets nothing.

FROM node:22-slim

WORKDIR /app

# Install with the lockfile first so the dependency layer caches independently
# of source changes.
COPY package.json package-lock.json ./
COPY apps/channel/package.json ./apps/channel/
COPY apps/web/package.json ./apps/web/
COPY packages ./packages
RUN npm ci --omit=dev --ignore-scripts || npm ci --ignore-scripts

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# server.ts refuses to start unless the Channel reports online, so a broken
# deploy fails loudly rather than serving an agent that never answers.
CMD ["npm", "run", "start:prod", "--workspace", "channel"]
