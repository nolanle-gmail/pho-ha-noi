# Pho Ha Noi — Waitlist app.
# Node 24 ships the built-in node:sqlite driver (no flag, no native build step),
# and every dependency is pure JS, so a slim image with production deps is enough.
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

# Install production dependencies first for better layer caching.
COPY package*.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

# The SQLite database lives on a mounted Fly volume (see fly.toml [mounts]).
ENV DB_PATH=/data/phohanoi_waitlist.db
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
