FROM node:24-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-slim
WORKDIR /app

# Libs de sistema que Chromium headless necesita — `agent-browser install
# --with-deps` intenta instalarlas solo pero corre `sudo apt-get`, y esta
# imagen ya es root sin sudo instalado. Se instalan a mano acá y se deja que
# el comando de abajo sólo baje el binario del browser.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6 libxrandr2 libxcomposite1 \
    libxcursor1 libxdamage1 libxfixes3 libxi6 libgtk-3-0 libpangocairo-1.0-0 \
    libpango-1.0-0 libatk1.0-0 libcairo-gobject2 libcairo2 libgdk-pixbuf-2.0-0 \
    libxrender1 libasound2 libfreetype6 libfontconfig1 libdbus-1-3 libnss3 \
    libnspr4 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libatspi2.0-0 libcups2 \
    libxshmfence1 libgbm1 fonts-noto-color-emoji fonts-noto-cjk fonts-freefont-ttf \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g agent-browser@0.34.0

COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

# Corre como `node` (no root): Chromium headless como root necesitaría
# --no-sandbox y ampliaría el impacto de cualquier RCE en el proceso web.
# El browser se instala DESPUÉS del chown para que quede en el $HOME de
# `node`, no en el de root.
RUN chown -R node:node /app
USER node
RUN agent-browser install

ENV NODE_ENV=production
ENV PORT=8790
EXPOSE 8790

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8790/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/src/restServerIndex.js"]
