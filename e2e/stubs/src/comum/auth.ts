import { verify } from 'jsonwebtoken';

/**
 * Mesma regra do `AuthModule` do kit: HS256 com o `JWT_SECRET` compartilhado e
 * `iss` da Lambda. Os endpoints do contrato aceitam so `role: SERVICO`; as
 * acoes de pessoa (diagnostico, aprovar...) aceitam os roles do ator.
 */
export interface Principal {
  sub: string;
  role: string;
  cpf?: string;
}

export class ErroAuth extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
  }
}

export function autenticar(authorization: string | undefined, rolesAceitos: readonly string[]): Principal {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET obrigatorio no stub');
  const token = /^Bearer (.+)$/i.exec(authorization ?? '')?.[1];
  if (!token) throw new ErroAuth(401, 'token ausente');
  let payload: Principal;
  try {
    payload = verify(token, secret, {
      algorithms: ['HS256'],
      issuer: process.env.JWT_ISSUER ?? 'oficina-auth-lambda',
    }) as Principal;
  } catch (e) {
    throw new ErroAuth(401, `token invalido: ${(e as Error).message}`);
  }
  if (!rolesAceitos.includes(payload.role)) {
    throw new ErroAuth(403, `role ${payload.role} nao aceita (esperado: ${rolesAceitos.join(', ')})`);
  }
  return payload;
}
