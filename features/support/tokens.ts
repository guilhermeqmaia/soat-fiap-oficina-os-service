import { Role } from '@guilhermeqmaia/oficina-kit/auth';
import { mintServiceToken, mintToken } from '@guilhermeqmaia/oficina-kit/testing';

/**
 * Tokens dos atores com o `mintToken`/`mintServiceToken` do kit (mesmo contrato
 * da Lambda de CPF: claims + `iss`, HS256 com `JWT_SECRET`). Os tokens de
 * SERVICO sao os que a Execucao/Billing usam nos callbacks.
 */
export type Ator = 'admin' | 'atendente' | 'mecanico' | 'cliente' | 'execucao' | 'billing' | 'os';

export function tokenDe(ator: Ator, extras: { sub?: string; cpf?: string } = {}): string {
  switch (ator) {
    case 'admin':
      return mintToken({ sub: extras.sub ?? 'bdd-admin', nome: 'Admin BDD', role: Role.ADMIN });
    case 'atendente':
      return mintToken({ sub: extras.sub ?? 'bdd-atendente', nome: 'Atendente BDD', role: Role.ATENDENTE });
    case 'mecanico':
      return mintToken({ sub: extras.sub ?? 'bdd-mecanico', nome: 'Mecanico BDD', role: Role.MECANICO });
    case 'cliente':
      return mintToken({ sub: extras.sub ?? `bdd-cliente-${extras.cpf}`, nome: 'Cliente BDD', cpf: extras.cpf, role: Role.CLIENTE });
    case 'execucao':
      return mintServiceToken({ servico: 'execucao-service' });
    case 'billing':
      return mintServiceToken({ servico: 'billing-service' });
    case 'os':
      return mintServiceToken({ servico: 'os-service' });
  }
}
