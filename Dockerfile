FROM node:20-alpine AS deps
WORKDIR /app
# better-sqlite3 requires node-gyp which needs python3 + build tools
RUN apk add --no-cache python3 make g++
COPY package.json ./
RUN npm install --omit=dev

FROM node:20-alpine AS production
WORKDIR /app

# Non-root user for security
RUN addgroup -S tradeflow && adduser -S tradeflow -G tradeflow

COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY public ./public
COPY package.json ./

# SQLite data directory — mount a volume here in production
RUN mkdir -p /app/data && chown -R tradeflow:tradeflow /app

USER tradeflow
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/server.js"]
