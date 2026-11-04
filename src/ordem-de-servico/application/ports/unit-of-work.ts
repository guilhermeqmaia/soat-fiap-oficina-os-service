/**
 * Unit of work: OS e saga vivem no MESMO Postgres, entao a transicao da OS e a
 * mudanca de passo da saga sao gravadas numa unica transacao — ou tudo, ou
 * nada. Os comandos aos participantes (HTTP, RFC-0008) sao executados DEPOIS
 * do commit, nunca dentro da transacao. O `tx` e opaco para a aplicacao; os
 * adapters Prisma sabem usa-lo.
 */
export interface UnitOfWork {
  executar<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
}
export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
