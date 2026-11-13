import '../env';
import { BeforeAll } from '@cucumber/cucumber';
import { ClienteHttpTeste } from '../http-client';
import { definirContexto } from '../contexto';
import { aguardarAte } from '../polling';

/**
 * Perfil `e2e` — ponta a ponta contra os servicos reais do
 * `docker-compose.fase4.yml` do hub (ainda nao existe: depende da Execucao e do
 * Billing na main). Nada sobe aqui: so apontamos para as URLs do compose e
 * esperamos o health. Sem stubs: steps de "o servico X recebeu..." nao se aplicam.
 *
 *   BDD_OS_SERVICE_URL   (default http://localhost:3000)
 *   BDD_MECANICO_ID      usuario MECANICO criado pelo seed do compose
 *   JWT_SECRET           o mesmo dos servicos (para o mintToken do kit)
 */
BeforeAll({ timeout: 120_000 }, async function () {
  const http = new ClienteHttpTeste((process.env.BDD_OS_SERVICE_URL ?? 'http://localhost:3000').replace(/\/+$/, ''));
  await aguardarAte('health do OS Service', () => http.get('/health'), (r) => r.status === 200, { timeoutMs: 90_000, intervaloMs: 1000 });
  definirContexto({ http, stubs: {}, mecanicoId: process.env.BDD_MECANICO_ID ?? '' });
});
