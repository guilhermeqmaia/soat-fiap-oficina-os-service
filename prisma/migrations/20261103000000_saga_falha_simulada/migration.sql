-- US-F4-11: injecao de falhas para a demo (passo em que a saga simula a falha do participante).
ALTER TABLE "saga_os" ADD COLUMN "falha_simulada" TEXT;
