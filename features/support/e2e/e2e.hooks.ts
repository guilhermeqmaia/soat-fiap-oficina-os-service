import './00-env';
import '../env';
import { After, Before, BeforeAll, Status } from '@cucumber/cucumber';
import { expect } from 'expect';
import { definirContexto } from '../contexto';
import { ClienteHttpTeste } from '../http-client';
import { aguardarAte } from '../polling';
import { tokenDe } from '../tokens';
import type { MundoOS } from '../world';
import { URLS_E2E } from './00-env';
import { acionadorE2e, participantes } from './ambiente';

/**
 * Perfil `e2e` — ponta a ponta contra o `docker-compose.fase4.yml` (npm run e2e:up),
 * so por HTTP, sem Nest em memoria. Nada sobe aqui: esperamos o health dos tres
 * servicos, criamos um MECANICO pela API e ligamos os stubs remotos.
 *
 *   BDD_OS_SERVICE_URL / BDD_BILLING_URL / BDD_EXECUCAO_URL / BDD_MAILPIT_URL
 *   JWT_SECRET   o mesmo do compose (default igual ao do docker-compose.fase4.yml)
 *   BDD_E2E_REAIS=1  imagens reais: pula os cenarios @stub (ver cucumber.js)
 */
const http = new ClienteHttpTeste(URLS_E2E.os);
let haStubs = false;

BeforeAll({ timeout: 180_000 }, async function () {
  const espera = { timeoutMs: 150_000, intervaloMs: 1000 };
  await aguardarAte('health do OS Service', () => http.get('/health'), (r) => r.status === 200, espera);
  for (const p of Object.values(participantes)) {
    await aguardarAte(`health do ${p.nome}`, () => p.http.get('/health'), (r) => r.status === 200, espera);
  }
  haStubs = (await participantes.Billing.ehStub()) && (await participantes.Execução.ehStub());

  const mecanico = await http.post(
    '/usuario',
    { nome: 'Carlos Mecanico (BDD e2e)', email: `mecanico.${Date.now()}@bdd-e2e.oficina.test`, senha: 'segredo-bdd', role: 'MECANICO' },
    tokenDe('admin'),
  );
  if (mecanico.status !== 201) throw new Error(`POST /usuario (MECANICO) respondeu ${mecanico.status}: ${JSON.stringify(mecanico.body)}`);

  definirContexto({
    http,
    stubs: haStubs ? participantes : {},
    mecanicoId: mecanico.body.id,
    acionadorCallbacks: acionadorE2e,
  });
});

Before(async function (this: MundoOS) {
  if (haStubs) await Promise.all(Object.values(participantes).map((p) => p.restaurar()));
  // fotografia do /metrics para os steps "as métricas do OS Service aumentaram"
  this.metricasAntes = String((await http.get('/metrics')).body ?? '');
});

After(async function (this: MundoOS, { result }) {
  if (result?.status === Status.FAILED) {
    const estado = this.os
      ? {
          os: this.os,
          ultimaResposta: this.ultimaResposta && { status: this.ultimaResposta.status, body: this.ultimaResposta.body },
          execucao: haStubs ? await participantes.Execução.estado(this.os.numero) : 'imagem real',
          billing: haStubs ? await participantes.Billing.estado(this.os.numero) : 'imagem real',
        }
      : { ultimaResposta: this.ultimaResposta?.body };
    this.attach(JSON.stringify(estado, null, 2), 'application/json');
  }
  // Nenhum cenario pode terminar com divergencia de contrato nos stubs.
  if (haStubs && this.os) {
    const numero = this.os.numero;
    const violacoes = (await Promise.all(Object.values(participantes).map((p) => p.violacoes()))).flat().filter((v) => v.numeroOS === numero);
    expect(violacoes).toEqual([]);
  }
});
