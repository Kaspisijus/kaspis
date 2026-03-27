FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends dumb-init && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist/ dist/
COPY src/brunas_logo.png src/brunas_logo.png

EXPOSE 3002

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/agent-server.js"]
