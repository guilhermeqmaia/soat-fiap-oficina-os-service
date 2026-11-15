-- US-F4-12: notificacoes a partir dos fatos da saga (callbacks/respostas HTTP).
-- Postgres 12+ aceita ADD VALUE em transacao; os valores novos nao sao usados nesta migration.

-- AlterEnum: tipos novos (os atuais ORCAMENTO_PRONTO, OS_FINALIZADA, STATUS_OS_ALTERADO continuam)
ALTER TYPE "TipoNotificacao" ADD VALUE 'ORCAMENTO_APROVADO';
ALTER TYPE "TipoNotificacao" ADD VALUE 'PAGAMENTO_PENDENTE';
ALTER TYPE "TipoNotificacao" ADD VALUE 'PAGAMENTO_APROVADO';
ALTER TYPE "TipoNotificacao" ADD VALUE 'PAGAMENTO_RECUSADO';
ALTER TYPE "TipoNotificacao" ADD VALUE 'OS_CANCELADA';

-- AlterEnum: notificacao enviada por webhook passa a ser gravada com o canal real
ALTER TYPE "CanalNotificacao" ADD VALUE 'WEBHOOK';

-- AlterTable
ALTER TABLE "notificacao" ADD COLUMN     "evento_id" TEXT,
ADD COLUMN     "link_pagamento" TEXT,
ADD COLUMN     "numero_os" TEXT;

-- Backfill: numero da OS das notificacoes antigas (evento_id fica NULL — nao entra na unicidade)
UPDATE "notificacao" n
SET "numero_os" = o."numero"
FROM "ordem_de_servico" o
WHERE n."ordem_de_servico_id" = o."id" AND n."numero_os" IS NULL;

-- CreateIndex
CREATE INDEX "notificacao_numero_os_idx" ON "notificacao"("numero_os");

-- CreateIndex: uma notificacao por (fato, tipo, canal) — justificativa em prisma/schema.prisma
CREATE UNIQUE INDEX "notificacao_evento_id_tipo_canal_key" ON "notificacao"("evento_id", "tipo", "canal");
