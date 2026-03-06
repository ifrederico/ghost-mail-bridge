FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js .
COPY lib/ lib/

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD sh -c 'if [ "${APP_ROLE:-all}" = "worker" ]; then exit 0; fi; wget --spider -q "http://localhost:${PORT:-3003}/health" || exit 1'

EXPOSE 3003

CMD ["node", "server.js"]
