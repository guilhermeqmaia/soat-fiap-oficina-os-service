-- US-F4-18 (follow-up da revisao): a saga parada por comando nao entregue passa a ser
-- detectada pelo ESTADO (falhas_pendentes) e nao pela ultima entrada do historico —
-- uma confirmacao de outra compensacao ou um callback duplicado depois do
-- `chamada-falhou` nao tiram mais a saga do alerta.
ALTER TABLE "saga_os" ADD COLUMN "falhas_pendentes" JSONB NOT NULL DEFAULT '[]';

-- Backfill: sagas abertas cuja ultima entrada e `chamada-falhou` continuam paradas.
UPDATE "saga_os"
   SET "falhas_pendentes" = jsonb_build_array(jsonb_build_object(
         'comando', "historico" -> -1 ->> 'evento',
         'passo', "passo",
         'status', "status",
         'em', "historico" -> -1 ->> 'em',
         'tentativas', COALESCE(("historico" -> -1 ->> 'tentativas')::int, 1),
         'detalhe', COALESCE("historico" -> -1 ->> 'detalhe', '')))
 WHERE "status" IN ('EM_ANDAMENTO', 'COMPENSANDO')
   AND jsonb_typeof("historico") = 'array'
   AND "historico" -> -1 ->> 'resultado' = 'chamada-falhou';
