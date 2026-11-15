# Stubs do Billing e da Execucao (US-F4-14) — UMA imagem, dois containers:
#   STUB_PAPEL=billing   (porta 3001)
#   STUB_PAPEL=execucao  (porta 3002)
# O papel vem por variavel (e nao por `command`) para o compose trocar a imagem pela
# real (BILLING_IMAGE/EXECUCAO_IMAGE) sem sobrescrever o CMD dela.
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
ENV STUB_PAPEL=billing
CMD ["sh", "-c", "exec node dist/${STUB_PAPEL}.js"]
