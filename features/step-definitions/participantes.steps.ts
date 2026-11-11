import { Given, Then, When } from '@cucumber/cucumber';
import { expect } from 'expect';
import { decode } from 'jsonwebtoken';
import { stubDe } from '../support/contexto';
import type { Participante } from '../support/participantes-stub';
import type { MundoOS } from '../support/world';

/**
 * Steps dos participantes falsos (stubs HTTP). Rotas escritas como no contrato
 * `docs/contratos/http-interno.md`: "POST /orcamentos", "POST /orcamentos/{n}/cobrar",
 * "POST /execucao/ordens/{n}/iniciar", "DELETE /execucao/ordens/{n}"...
 * No perfil `default` sao os StubHttp em memoria; no `e2e`, os containers de
 * e2e/stubs controlados por `/__stub/*` (ver features/support/e2e/participante-remoto.ts).
 */
function participante(nome: string): Participante {
  if (nome !== 'Execução' && nome !== 'Billing') throw new Error(`Servico desconhecido "${nome}". Use "Execução" ou "Billing".`);
  return nome;
}

async function chamadasDaOS(mundo: MundoOS, servico: string, rota: string) {
  const n = mundo.ordem.numero;
  return (await stubDe(participante(servico)).chamadasEm(rota)).filter((c) => c.params.n === n || c.body?.numeroOS === n);
}

Given('que o serviço {string} responde {int} em {string}', async function (this: MundoOS, servico: string, status: number, rota: string) {
  await stubDe(participante(servico)).responder(rota, { status, body: { message: `stub: ${status}` } });
});

Given('que o serviço {string} está fora do ar em {string}', async function (this: MundoOS, servico: string, rota: string) {
  await stubDe(participante(servico)).responder(rota, { status: 503, body: { message: 'stub: servico indisponivel' } });
});

Given('que o serviço {string} recusa {string} com o motivo {string}', async function (this: MundoOS, servico: string, rota: string, motivo: string) {
  await stubDe(participante(servico)).responder(rota, { status: 409, body: { motivo } });
});

When('o serviço {string} volta ao ar', async function (this: MundoOS, servico: string) {
  await stubDe(participante(servico)).restaurar();
});

Then('o serviço {string} recebeu {int} chamada(s) em {string}', async function (this: MundoOS, servico: string, quantidade: number, rota: string) {
  expect(await chamadasDaOS(this, servico, rota)).toHaveLength(quantidade);
});

Then('o serviço {string} não recebeu chamadas em {string}', async function (this: MundoOS, servico: string, rota: string) {
  expect(await chamadasDaOS(this, servico, rota)).toHaveLength(0);
});

Then('o serviço {string} recebeu a chamada {string} com o JWT de serviço do OS Service', async function (this: MundoOS, servico: string, rota: string) {
  const [chamada] = await chamadasDaOS(this, servico, rota);
  expect(chamada).toBeDefined();
  const token = String(chamada.headers.authorization ?? '').replace(/^Bearer /, '');
  expect(decode(token)).toMatchObject({ role: 'SERVICO', sub: 'os-service' });
  expect(chamada.headers['x-correlation-id']).toBe(this.ordem.numero);
});
