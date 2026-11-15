#!/usr/bin/env node
/**
 * Emite um JWT para o roteiro manual do FLUXO 3 (docs/fluxo-3/teste-manual-ponta-a-ponta.md)
 * com o mesmo contrato da Lambda de CPF (mintToken/mintServiceToken do kit) e o
 * JWT_SECRET do docker-compose.fase4.yml.
 *
 *   npm run -s e2e:token -- admin|atendente|mecanico          (staff)
 *   npm run -s e2e:token -- cliente <cpf>                      (CLIENTE)
 *   npm run -s e2e:token -- os-service|billing-service|execucao-service   (SERVICO)
 */
process.env.JWT_SECRET ??= 'e2e-fase4-jwt-secret-0123456789abcdef-local';
const { mintToken, mintServiceToken } = require('@guilhermeqmaia/oficina-kit/testing');

const [ator = 'admin', extra] = process.argv.slice(2);
const staff = { admin: 'ADMIN', atendente: 'ATENDENTE', mecanico: 'MECANICO' };

if (staff[ator]) {
  console.log(mintToken({ sub: `manual-${ator}`, nome: `${ator} (roteiro manual)`, role: staff[ator] }));
} else if (ator === 'cliente') {
  if (!extra) throw new Error('uso: e2e:token -- cliente <cpf>');
  console.log(mintToken({ sub: `manual-cliente-${extra}`, nome: 'Cliente (roteiro manual)', cpf: extra, role: 'CLIENTE' }));
} else if (['os-service', 'billing-service', 'execucao-service'].includes(ator)) {
  console.log(mintServiceToken({ servico: ator }));
} else {
  throw new Error(`ator desconhecido: ${ator}`);
}
