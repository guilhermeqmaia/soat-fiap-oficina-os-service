# Stubs do Billing e da Execucao (US-F4-14) — UMA imagem, dois containers:
#   command: ["node", "dist/billing.js"]   (porta 3001)
#   command: ["node", "dist/execucao.js"]  (porta 3002)
# Contexto de build = raiz do repo (precisa de docs/contratos/schemas).
#   docker build -f e2e/stubs/Dockerfile -t oficina-participantes-stub .

FROM node:20-alpine AS builder
WORKDIR /app
COPY e2e/stubs/package*.json ./
RUN npm ci --no-audit --no-fund
COPY e2e/stubs/tsconfig.json ./
COPY e2e/stubs/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production SCHEMAS_DIR=/app/schemas
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/package.json ./package.json
# Os mesmos JSON Schemas dos testes de contrato: o stub valida o que recebe e o que responde.
COPY --chown=node:node docs/contratos/schemas ./schemas
USER node
CMD ["node", "dist/billing.js"]
