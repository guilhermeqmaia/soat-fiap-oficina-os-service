# ─── Stage 1: builder ────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx prisma generate && npm run build

# ─── Stage 2: runtime ────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# O npm 10 embutido no node:20 traz tar 6.2.1 (CVE-2026-59873, CRITICAL) e
# bloqueia o scan do Trivy no CD; o npm 11 traz tar >= 7.5.19 e suporta node 20.
RUN npm install -g npm@11 && npm cache clean --force

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --chown=node:node --from=builder /app/node_modules/.bin/prisma ./node_modules/.bin/prisma

COPY --chown=node:node --from=builder /app/dist ./dist

COPY --chown=node:node prisma ./prisma

COPY --chown=node:node prisma.config.ts ./prisma.config.ts

# JSON Schemas dos contratos HTTP (US-F4-15): o Swagger UI (/api, fora de producao)
# monta o envelope dos callbacks a partir deles (src/config/openapi.ts).
COPY --chown=node:node docs/contratos/schemas ./docs/contratos/schemas

COPY --chown=node:node --from=builder /app/node_modules/dotenv ./node_modules/dotenv

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["sh", "-c", "npx prisma migrate deploy && exec node dist/main.js"]
