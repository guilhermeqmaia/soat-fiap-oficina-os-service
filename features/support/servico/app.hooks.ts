// env ANTES de qualquer import do app: o validateEnv do ConfigModule roda no import.
import '../env';
import { After, AfterAll, Before, BeforeAll, Status } from '@cucumber/cucumber';
import type { INestApplication } from '@nestjs/common';
import { Role } from '@guilhermeqmaia/oficina-kit/auth';
import { startTestDatabase, stopTestDatabase } from '../../../src/test/database.container';
import { ClienteHttpTeste } from '../http-client';
import { definirContexto } from '../contexto';
import { stubBilling, stubExecucao } from '../participantes-stub';
import type { StubHttp } from '../stub-http';
import type { MundoOS } from '../world';

/**
 * Perfil `default` — nivel de servico: Postgres via Testcontainers (mesmo helper
 * dos testes de integracao), Nest em memoria escutando numa porta livre e
 * Execucao/Billing substituidos por stubs HTTP locais. O OS Service usa o
 * cliente HTTP real do kit para falar com os stubs.
 */
let app: INestApplication | undefined;
const stubs: { Execução: StubHttp; Billing: StubHttp } = { Execução: stubExecucao(), Billing: stubBilling() };

BeforeAll({ timeout: 240_000 }, async function () {
  await Promise.all([stubs.Execução.iniciar(), stubs.Billing.iniciar()]);
  process.env.EXECUCAO_SERVICE_URL = stubs.Execução.url;
  process.env.BILLING_SERVICE_URL = stubs.Billing.url;
  process.env.DATABASE_URL = await startTestDatabase();

  // Import tardio: o AppModule le o ambiente (URLs dos stubs, DATABASE_URL) no import.
  const [{ NestFactory }, { ValidationPipe }, { AppModule }, { PrismaService }] = await Promise.all([
    import('@nestjs/core'),
    import('@nestjs/common'),
    import('../../../src/app.module'),
    import('../../../src/prisma/prisma.service'),
  ]);
  app = await NestFactory.create(AppModule, { logger: process.env.BDD_LOG ? ['log', 'warn', 'error'] : false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');

  const prisma = app.get(PrismaService);
  const mecanico = await prisma.usuario.create({
    data: { nome: 'Carlos Mecanico (BDD)', email: `mecanico.${Date.now()}@bdd.oficina.test`, senhaHash: 'x', role: Role.MECANICO, ativo: true },
  });

  definirContexto({ http: new ClienteHttpTeste(await app.getUrl()), stubs, mecanicoId: mecanico.id });
});

Before(function () {
  stubs.Execução.reset();
  stubs.Billing.reset();
});

After(function (this: MundoOS, { result }) {
  // Em caso de falha anexa ao relatorio o estado que ajuda a depurar.
  if (result?.status === Status.FAILED) {
    const chamadas = [...stubs.Execução.chamadas, ...stubs.Billing.chamadas].map((c) => `${c.metodo} ${c.caminho}`);
    this.attach(
      JSON.stringify({ os: this.os, ultimaResposta: this.ultimaResposta && { status: this.ultimaResposta.status, body: this.ultimaResposta.body }, chamadasAosStubs: chamadas }, null, 2),
      'application/json',
    );
  }
});

AfterAll({ timeout: 60_000 }, async function () {
  await app?.close();
  await stopTestDatabase();
  await Promise.all([stubs.Execução.parar(), stubs.Billing.parar()]);
});
