/**
 * Injecao de falhas para a demo (US-F4-11): so com SAGA_SIMULAR_FALHA_HABILITADO=true.
 * Em producao real fica desligada; no ambiente de demonstracao da Fase 4 e ligada
 * de proposito para gravar o video da compensacao.
 */
export function simulacaoDeFalhasHabilitada(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SAGA_SIMULAR_FALHA_HABILITADO === 'true';
}
