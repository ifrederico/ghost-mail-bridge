FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json .
RUN npm install --production
COPY server.js .
COPY lib/ lib/
COPY dashboard-lab/public/ dashboard-lab/public/

RUN mkdir -p /data

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --spider -q http://localhost:${PORT:-3003}/health || exit 1

EXPOSE 3003

CMD ["node", "server.js"]
