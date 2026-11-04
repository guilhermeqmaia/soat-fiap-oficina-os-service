/**
 * Por que uma OS foi cancelada (mesmo enum do evento `os.cancelada` no AsyncAPI).
 * Os motivos de saga vem das compensacoes (RFC-0005); OPERADOR e o cancelamento
 * manual pelo atendente.
 */
export enum MotivoCancelamento {
  EXECUCAO_RECUSADA = 'EXECUCAO_RECUSADA',
  ORCAMENTO_REJEITADO = 'ORCAMENTO_REJEITADO',
  /** Reservado (ver TIMEOUT_PAGAMENTO). */
  PAGAMENTO_RECUSADO = 'PAGAMENTO_RECUSADO',
  TIMEOUT_APROVACAO = 'TIMEOUT_APROVACAO',
  /**
   * Reservados: a cobranca passou a acontecer depois da execucao (ADR-0012,
   * 03/11), entao pagamento recusado/em atraso nao cancela mais a OS. Mantidos
   * no enum para nao quebrar dados historicos e o contrato de `os.cancelada`.
   */
  TIMEOUT_PAGAMENTO = 'TIMEOUT_PAGAMENTO',
  FALHA_INICIO_EXECUCAO = 'FALHA_INICIO_EXECUCAO',
  OPERADOR = 'OPERADOR',
}
