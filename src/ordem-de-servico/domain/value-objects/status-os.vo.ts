import { InvalidStatusError } from '../errors/invalid-status.error';

/**
 * Ciclo de vida da OS na Fase 4 (RFC-0005): as transicoes sao dirigidas pelos
 * eventos dos outros servicos (Execucao, Billing) e pelo orquestrador da saga.
 *
 * RECEBIDA -> EM_DIAGNOSTICO -> AGUARDANDO_APROVACAO -> EM_EXECUCAO
 *   -> AGUARDANDO_PAGAMENTO -> FINALIZADA -> ENTREGUE
 * A cobranca acontece depois do servico executado (ADR-0012, decisao de 03/11).
 * Qualquer status antes de EM_EXECUCAO pode ir para CANCELADA (compensacao).
 */
export enum StatusOS {
  RECEBIDA = 'RECEBIDA',
  EM_DIAGNOSTICO = 'EM_DIAGNOSTICO',
  AGUARDANDO_APROVACAO = 'AGUARDANDO_APROVACAO',
  EM_EXECUCAO = 'EM_EXECUCAO',
  AGUARDANDO_PAGAMENTO = 'AGUARDANDO_PAGAMENTO',
  FINALIZADA = 'FINALIZADA',
  ENTREGUE = 'ENTREGUE',
  CANCELADA = 'CANCELADA',
}

export class StatusOSVO {
  readonly valor: StatusOS;

  constructor(status: StatusOS | string) {
    const statusValue = Object.values(StatusOS).find((s) => s === status);
    if (!statusValue) {
      throw new InvalidStatusError(status);
    }
    this.valor = statusValue;
  }

  static create(status: string): StatusOSVO {
    return new StatusOSVO(status);
  }

  equals(other: StatusOSVO): boolean {
    return this.valor === other.valor;
  }

  toString(): string {
    return this.valor;
  }
}
