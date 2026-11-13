import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '@guilhermeqmaia/oficina-kit/auth';
import { mintServiceToken, mintToken } from '@guilhermeqmaia/oficina-kit/testing';
import { criarEnvelopeHttp } from '@guilhermeqmaia/oficina-kit/http';
import { StatusOS } from './domain/value-objects/status-os.vo';
import { MotivoCancelamento } from './domain/value-objects/motivo-cancelamento';
import { startTestDatabase, stopTestDatabase } from '../test/database.container';
import { FakeParticipantesSaga } from '../test/fake-participantes-saga';
import { SagaTimeoutsService } from './saga/application/saga-timeouts.service';
import { PassoSaga, StatusSaga, TipoComando } from './saga/domain/saga-os.entity';
import { PARTICIPANTES_SAGA_GATEWAY } from './saga/application/ports/participantes-saga.gateway';
import { PrismaSagaRepository } from './saga/infrastructure/prisma-saga.repository';
import { PurgaCallbacksService } from './saga/infrastructure/purga-callbacks.service';
import { ConcurrentModificationError } from './domain/errors/concurrent-modification.error';

jest.setTimeout(120000);

const CLIENTE_CPF = '52998224725';

/**
 * OS Service (Fase 4, US-F4-18): a API expoe abertura, consulta, entrega e
 * cancelamento. A saga fala com Execucao e Billing por HTTP (RFC-0008) — aqui o
 * gateway dos participantes e um fake em memoria que responde como a spec
 * (`docs/contratos/http-interno.md`) — e recebe os callbacks deles em
 * `POST /ordens-servico/:numero/eventos` (role SERVICO).
 */
describe('OrdemDeServico (e2e) — OS Service com participantes por HTTP', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let moduleRef: TestingModule;
  const participantes = new FakeParticipantesSaga();
  const tokens: Record<string, string> = {};
  let clienteId: string;
  let veiculoId: string;
  let mecanicoUserId: string;

  const http = () => request(app.getHttpServer());
  const ITENS = [
    { tipo: 'SERVICO', referenciaId: 'srv-1', nome: 'Troca de pastilha', quantidade: 1, precoUnitario: '200.00' },
    { tipo: 'PRODUTO', referenciaId: 'prd-1', nome: 'Pastilha', quantidade: 2, precoUnitario: '50.00', servicoId: 'srv-1' },
  ];

  beforeAll(async () => {
    process.env.DATABASE_URL = await startTestDatabase();
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PARTICIPANTES_SAGA_GATEWAY)
      .useValue(participantes)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);

    await prisma.ordemDeServico.deleteMany();
    await prisma.veiculo.deleteMany();
    await prisma.cliente.deleteMany();
    await prisma.usuario.deleteMany();

    mecanicoUserId = (await prisma.usuario.create({ data: { nome: 'Carlos Mecanico', email: 'mecanico.os@oficina.com', senhaHash: 'x', role: Role.MECANICO, ativo: true } })).id;
    tokens.admin = mintToken({ sub: 'admin-os', nome: 'Admin', role: Role.ADMIN });
    tokens.atendente = mintToken({ sub: 'atendente-os', nome: 'Atendente', role: Role.ATENDENTE });
    tokens.mecanico = mintToken({ sub: mecanicoUserId, nome: 'Mecanico', role: Role.MECANICO });
    tokens.estoquista = mintToken({ sub: 'estoquista-os', nome: 'Estoquista', role: Role.ESTOQUISTA });
    tokens.cliente = mintToken({ sub: 'cliente-os', nome: 'Cliente', cpf: CLIENTE_CPF, role: Role.CLIENTE });
    tokens.execucao = mintServiceToken({ servico: 'execucao-service' });
    tokens.billing = mintServiceToken({ servico: 'billing-service' });

    const clienteRes = await http().post('/clientes').set('Authorization', `Bearer ${tokens.admin}`)
      .send({ nome: 'Joao Silva', cpfCnpj: '529.982.247-25', telefone: '11999990000', email: 'cliente.os@oficina.com' });
    expect(clienteRes.status).toBe(201);
    clienteId = clienteRes.body.id;
    const veiculoRes = await http().post('/veiculos').set('Authorization', `Bearer ${tokens.admin}`)
      .send({ placa: 'TES1T23', marca: 'Toyota', modelo: 'Corolla', ano: 2024, clienteId });
    expect(veiculoRes.status).toBe(201);
    veiculoId = veiculoRes.body.id;
  });

  afterAll(async () => {
    await app.close();
    await stopTestDatabase();
  });

  beforeEach(() => {
    participantes.restaurar();
    participantes.limparChamadas();
  });

  const createOs = async (token = tokens.admin) => {
    const res = await http().post('/ordens-servico').set('Authorization', `Bearer ${token}`)
      .send({ clienteId, veiculoId, descricaoInicial: 'Cliente relata barulho ao frenar' });
    expect(res.status).toBe(201);
    return res.body as { id: string; status: string; numero: string };
  };
  const statusDe = async (numero: string) => (await http().get(`/ordens-servico/numero/${numero}/status`)).body;
  const sagaDe = async (numero: string) => {
    const res = await http().get(`/ordens-servico/numero/${numero}/saga`).set('Authorization', `Bearer ${tokens.atendente}`);
    expect(res.status).toBe(200);
    return res.body;
  };
  /** Callback de um participante (como a Execucao/Billing chamam o OS Service). */
  const callback = (
    numero: string,
    type: string,
    data: Record<string, unknown> = {},
    producer: 'execucao-service' | 'billing-service' = type.startsWith('billing') ? 'billing-service' : 'execucao-service',
  ) =>
    http()
      .post(`/ordens-servico/${numero}/eventos`)
      .set('Authorization', `Bearer ${producer === 'billing-service' ? tokens.billing : tokens.execucao}`)
      .send(criarEnvelopeHttp({ type, producer, data: { numeroOS: numero, ...data } }));
  const diagnostico = (numero: string, itens: unknown[] = ITENS) =>
    callback(numero, 'execucao.diagnostico-concluido', { mecanicoId: mecanicoUserId, diagnostico: 'Pastilhas gastas e disco empenado', itens });
  /** Abre + diagnostico (a resposta 201 do POST /orcamentos ja deixa a OS AGUARDANDO_APROVACAO). */
  const ateAguardandoAprovacao = async () => {
    const os = await createOs();
    expect((await diagnostico(os.numero)).status).toBe(200);
    return os;
  };
  /** ... + aprovacao (POST /execucao/ordens/{n}/iniciar responde 200 -> EM_EXECUCAO). */
  const ateEmExecucao = async () => {
    const os = await ateAguardandoAprovacao();
    expect((await callback(os.numero, 'billing.orcamento-aprovado', { orcamentoId: `orc-${os.numero}` })).status).toBe(200);
    return os;
  };
  /** ... + finalizada (POST /orcamentos/{n}/cobrar responde 201 -> AGUARDANDO_PAGAMENTO com cobranca). */
  const ateAguardandoPagamento = async () => {
    const os = await ateEmExecucao();
    expect((await callback(os.numero, 'execucao.finalizada', { finalizadaEm: new Date().toISOString() })).status).toBe(200);
    return os;
  };

  describe('POST /ordens-servico', () => {
    it('abre a OS e chama POST /execucao/ordens na hora: com 201 da Execucao ja devolve EM_DIAGNOSTICO', async () => {
      const res = await http().post('/ordens-servico').set('Authorization', `Bearer ${tokens.atendente}`)
        .send({ clienteId, veiculoId, descricaoInicial: 'Cliente relata barulho ao frenar' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: StatusOS.EM_DIAGNOSTICO, mecanicoId: null, motivoCancelamento: null, valorTotal: 0, itensServico: [] });
      expect(res.body.numero).toMatch(/^OS-\d{4}-/);
      expect(participantes.de('execucao.enfileirar', res.body.numero)[0].data).toEqual({ numeroOS: res.body.numero, veiculoId, descricaoProblema: 'Cliente relata barulho ao frenar' });
      const s = await sagaDe(res.body.numero);
      expect(s).toMatchObject({ passo: PassoSaga.AGUARDAR_DIAGNOSTICO, status: StatusSaga.EM_ANDAMENTO, compensacoes: [] });
      expect(s.historico.map((h: any) => [h.evento, h.resultado])).toEqual([['os.aberta', 'avancou'], ['execucao.enfileirada', 'avancou']]);
    });
    it('Execucao fora do ar (tentativas esgotadas): a OS fica RECEBIDA e a saga parada em ENFILEIRAR_EXECUCAO', async () => {
      participantes.indisponivel('execucao.enfileirar');
      const os = await createOs();
      expect(os.status).toBe(StatusOS.RECEBIDA);
      expect(await sagaDe(os.numero)).toMatchObject({ passo: PassoSaga.ENFILEIRAR_EXECUCAO, status: StatusSaga.EM_ANDAMENTO });
    });
    it('404 cliente/veiculo inexistente, 409 veiculo de outro cliente, 400 descricao curta', async () => {
      const auth = (r: request.Test) => r.set('Authorization', `Bearer ${tokens.admin}`);
      expect((await auth(http().post('/ordens-servico')).send({ clienteId: '00000000-0000-4000-8000-000000000000', veiculoId, descricaoInicial: 'Barulho ao frenar' })).status).toBe(404);
      expect((await auth(http().post('/ordens-servico')).send({ clienteId, veiculoId: '00000000-0000-4000-8000-000000000000', descricaoInicial: 'Barulho ao frenar' })).status).toBe(404);
      const outro = await auth(http().post('/clientes')).send({ nome: 'Outro', cpfCnpj: '11.222.333/0001-81', telefone: '11000000000' });
      const vOutro = await auth(http().post('/veiculos')).send({ placa: 'OUT1R23', marca: 'Fiat', modelo: 'Uno', ano: 2020, clienteId: outro.body.id });
      expect((await auth(http().post('/ordens-servico')).send({ clienteId, veiculoId: vOutro.body.id, descricaoInicial: 'Barulho ao frenar' })).status).toBe(409);
      expect((await auth(http().post('/ordens-servico')).send({ clienteId, veiculoId, descricaoInicial: 'abc' })).status).toBe(400);
      expect(participantes.chamadas).toHaveLength(0);
    });
    it('401 sem token; 403 para CLIENTE, MECANICO, ESTOQUISTA e SERVICO', async () => {
      expect((await http().post('/ordens-servico').send({ clienteId, veiculoId, descricaoInicial: 'Barulho ao frenar' })).status).toBe(401);
      for (const t of ['cliente', 'mecanico', 'estoquista', 'execucao']) {
        expect((await http().post('/ordens-servico').set('Authorization', `Bearer ${tokens[t]}`).send({ clienteId, veiculoId, descricaoInicial: 'Barulho ao frenar' })).status).toBe(403);
      }
    });
  });

  describe('GET /ordens-servico e GET /ordens-servico/:id', () => {
    it('lista paginada com filtros; MECANICO pode, CLIENTE nao', async () => {
      await createOs();
      const res = await http().get('/ordens-servico?page=1&limit=5').set('Authorization', `Bearer ${tokens.mecanico}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ page: 1, limit: 5 });
      expect(res.body.data.length).toBeGreaterThan(0);
      const porStatus = await http().get(`/ordens-servico?status=${StatusOS.EM_DIAGNOSTICO}&clienteId=${clienteId}`).set('Authorization', `Bearer ${tokens.admin}`);
      expect(porStatus.body.data.every((o: any) => o.status === StatusOS.EM_DIAGNOSTICO)).toBe(true);
      expect((await http().get('/ordens-servico').set('Authorization', `Bearer ${tokens.cliente}`)).status).toBe(403);
    });
    it('detalhe traz cabecalho/corpo/rodape com snapshot e mecanico', async () => {
      const os = await ateAguardandoAprovacao();
      const res = await http().get(`/ordens-servico/${os.id}`).set('Authorization', `Bearer ${tokens.atendente}`);
      expect(res.status).toBe(200);
      expect(res.body.cabecalho).toMatchObject({ status: StatusOS.AGUARDANDO_APROVACAO, mecanicoAtribuido: 'Carlos Mecanico', motivoCancelamento: null });
      expect(res.body.corpo.servicos[0]).toMatchObject({ descricaoServico: 'Troca de pastilha', precoUnitario: 200 });
      expect(res.body.corpo.servicos[0].produtos[0]).toMatchObject({ descricaoProduto: 'Pastilha', quantidade: 2 });
      expect(res.body.rodape.valorTotalOrdemServico).toBe(300);
      expect((await http().get(`/ordens-servico/${os.id}`).set('Authorization', `Bearer ${tokens.cliente}`)).status).toBe(403);
      expect((await http().get('/ordens-servico/00000000-0000-4000-8000-000000000000').set('Authorization', `Bearer ${tokens.admin}`)).status).toBe(404);
    });
  });

  describe('POST /ordens-servico/:numero/eventos (callback dos participantes)', () => {
    const envelope = (numero: string, extra: Record<string, unknown> = {}) => ({
      ...criarEnvelopeHttp({ type: 'execucao.finalizada', producer: 'execucao-service', data: { numeroOS: numero, finalizadaEm: new Date().toISOString() } }),
      ...extra,
    });

    it('exige JWT de servico: 401 sem token, 403 para ATENDENTE/ADMIN/CLIENTE, 200 com mintServiceToken', async () => {
      const os = await ateEmExecucao();
      const body = envelope(os.numero);
      expect((await http().post(`/ordens-servico/${os.numero}/eventos`).send(body)).status).toBe(401);
      for (const t of ['atendente', 'admin', 'cliente']) {
        expect((await http().post(`/ordens-servico/${os.numero}/eventos`).set('Authorization', `Bearer ${tokens[t]}`).send(body)).status).toBe(403);
      }
      const ok = await http().post(`/ordens-servico/${os.numero}/eventos`).set('Authorization', `Bearer ${tokens.execucao}`).send(body);
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ aplicado: true, passo: PassoSaga.AGUARDAR_PAGAMENTO, status: StatusSaga.EM_ANDAMENTO });
    });

    it('valida o envelope (400): id nao uuid, type fora do padrao, version < 1, data nao objeto, numeroOS divergente', async () => {
      const os = await ateEmExecucao();
      const post = (body: object) => http().post(`/ordens-servico/${os.numero}/eventos`).set('Authorization', `Bearer ${tokens.execucao}`).send(body);
      expect((await post(envelope(os.numero, { id: 'nao-uuid' }))).status).toBe(400);
      expect((await post(envelope(os.numero, { type: 'Execucao.Finalizada' }))).status).toBe(400);
      expect((await post(envelope(os.numero, { version: 0 }))).status).toBe(400);
      expect((await post(envelope(os.numero, { occurredAt: 'ontem' }))).status).toBe(400);
      expect((await post(envelope(os.numero, { producer: '' }))).status).toBe(400);
      expect((await post(envelope(os.numero, { data: 'x' }))).status).toBe(400);
      const divergente = await post(envelope(os.numero, { data: { numeroOS: 'OS-OUTRA', finalizadaEm: 'x' } }));
      expect(divergente.status).toBe(400);
      expect(divergente.body.message).toContain('diverge');
      expect((await statusDe(os.numero)).status).toBe(StatusOS.EM_EXECUCAO);
    });

    it('data.numeroOS ausente e preenchido a partir do path', async () => {
      const os = await ateEmExecucao();
      const body = criarEnvelopeHttp({ type: 'execucao.finalizada', producer: 'execucao-service', data: { finalizadaEm: new Date().toISOString() } });
      const res = await http().post(`/ordens-servico/${os.numero}/eventos`).set('Authorization', `Bearer ${tokens.execucao}`).send(body);
      expect(res.status).toBe(200);
      expect(res.body.aplicado).toBe(true);
      expect((await statusDe(os.numero)).status).toBe(StatusOS.AGUARDANDO_PAGAMENTO);
    });

    it('404 para OS inexistente (nada e marcado como processado)', async () => {
      const body = envelope('OS-NAO-EXISTE');
      expect((await http().post('/ordens-servico/OS-NAO-EXISTE/eventos').set('Authorization', `Bearer ${tokens.execucao}`).send(body)).status).toBe(404);
      expect(await prisma.processedMessage.findUnique({ where: { id: body.id } })).toBeNull();
    });

    it('idempotente pelo id: a repeticao devolve { aplicado: false, duplicado: true } sem reaplicar', async () => {
      const os = await ateEmExecucao();
      const body = envelope(os.numero);
      const primeira = await http().post(`/ordens-servico/${os.numero}/eventos`).set('Authorization', `Bearer ${tokens.execucao}`).send(body);
      expect(primeira.body).toMatchObject({ aplicado: true, passo: PassoSaga.AGUARDAR_PAGAMENTO });
      expect(participantes.de('billing.cobrar', os.numero)).toHaveLength(1);
      const segunda = await http().post(`/ordens-servico/${os.numero}/eventos`).set('Authorization', `Bearer ${tokens.execucao}`).send(body);
      expect(segunda.status).toBe(200);
      expect(segunda.body).toEqual({ aplicado: false, duplicado: true, passo: PassoSaga.AGUARDAR_PAGAMENTO, status: StatusSaga.EM_ANDAMENTO });
      expect(participantes.de('billing.cobrar', os.numero)).toHaveLength(1);
      expect(await prisma.processedMessage.findUnique({ where: { id: body.id } })).toMatchObject({ type: 'execucao.finalizada' });
      // mesmo conteudo com outro id: a saga ignora (passo ja concluido), mas o id fica marcado
      const outro = await http().post(`/ordens-servico/${os.numero}/eventos`).set('Authorization', `Bearer ${tokens.execucao}`).send({ ...body, id: randomUUID() });
      expect(outro.body).toEqual({ aplicado: false, passo: PassoSaga.AGUARDAR_PAGAMENTO, status: StatusSaga.EM_ANDAMENTO });
    });

    it('409 quando o conflito de versao persiste apos os retries (quem chamou repete) e nada e marcado', async () => {
      const os = await ateEmExecucao();
      const repo = moduleRef.get(PrismaSagaRepository);
      const spy = jest.spyOn(repo, 'save').mockRejectedValue(new ConcurrentModificationError('saga'));
      const body = envelope(os.numero);
      try {
        const res = await http().post(`/ordens-servico/${os.numero}/eventos`).set('Authorization', `Bearer ${tokens.execucao}`).send(body);
        expect(res.status).toBe(409);
        expect(spy).toHaveBeenCalledTimes(3);
      } finally {
        spy.mockRestore();
      }
      expect(await prisma.processedMessage.findUnique({ where: { id: body.id } })).toBeNull();
      expect((await statusDe(os.numero)).status).toBe(StatusOS.EM_EXECUCAO);
      // reentrega funciona
      expect((await http().post(`/ordens-servico/${os.numero}/eventos`).set('Authorization', `Bearer ${tokens.execucao}`).send(body)).body.aplicado).toBe(true);
    });

    it('purga de processed_messages remove ids alem da retencao', async () => {
      await prisma.processedMessage.create({ data: { id: randomUUID(), type: 'x.y', processadaEm: new Date(Date.now() - 10 * 86_400_000) } });
      const recente = (await ateEmExecucao()).numero;
      const body = envelope(recente);
      await http().post(`/ordens-servico/${recente}/eventos`).set('Authorization', `Bearer ${tokens.execucao}`).send(body);
      expect(await moduleRef.get(PurgaCallbacksService).purgar(7)).toBeGreaterThanOrEqual(1);
      expect(await prisma.processedMessage.findUnique({ where: { id: body.id } })).not.toBeNull();
    });
  });

  describe('ciclo de vida por callbacks + respostas sincronas dos participantes (EM_DIAGNOSTICO -> ENTREGUE)', () => {
    let os: { id: string; numero: string };

    it('1. abre: POST /execucao/ordens -> 201 -> EM_DIAGNOSTICO', async () => {
      os = await createOs();
      expect((await statusDe(os.numero)).status).toBe(StatusOS.EM_DIAGNOSTICO);
    });
    it('2. callback diagnostico-concluido grava o snapshot e chama POST /orcamentos -> 201 -> AGUARDANDO_APROVACAO', async () => {
      const res = await diagnostico(os.numero, [{ tipo: 'SERVICO', referenciaId: 'srv-1', nome: 'Troca de pastilha', quantidade: 1, precoUnitario: '200.00' }]);
      expect(res.body).toEqual({ aplicado: true, passo: PassoSaga.AGUARDAR_APROVACAO, status: StatusSaga.EM_ANDAMENTO });
      const s = await statusDe(os.numero);
      expect(s.status).toBe(StatusOS.AGUARDANDO_APROVACAO);
      expect(s.servicos[0]).toMatchObject({ nome: 'Troca de pastilha', subtotal: 200 });
      expect(s.valorTotal).toBe(200);
      expect(participantes.de('billing.gerar-orcamento', os.numero)[0].data).toMatchObject({ numeroOS: os.numero, clienteId });
    });
    it('3. aprovado -> POST /execucao/ordens/{n}/iniciar -> EM_EXECUCAO; finalizada -> POST /orcamentos/{n}/cobrar -> AGUARDANDO_PAGAMENTO; pago -> FINALIZADA', async () => {
      await callback(os.numero, 'billing.orcamento-aprovado', { orcamentoId: 'orc-1' });
      expect((await statusDe(os.numero)).status).toBe(StatusOS.EM_EXECUCAO);
      expect(participantes.de('execucao.iniciar', os.numero)).toHaveLength(1);
      expect((await http().post(`/ordens-servico/${os.id}/cancelar`).set('Authorization', `Bearer ${tokens.atendente}`).send({})).status).toBe(400);
      await callback(os.numero, 'execucao.finalizada', { finalizadaEm: new Date().toISOString() });
      expect((await statusDe(os.numero)).status).toBe(StatusOS.AGUARDANDO_PAGAMENTO);
      expect(participantes.de('billing.cobrar', os.numero)).toHaveLength(1);
      expect((await sagaDe(os.numero)).prazoPagamento).toBeTruthy();
      expect((await http().post(`/ordens-servico/${os.id}/cancelar`).set('Authorization', `Bearer ${tokens.atendente}`).send({})).status).toBe(400);
      expect((await http().post(`/ordens-servico/${os.id}/entregar`).set('Authorization', `Bearer ${tokens.atendente}`)).status).toBe(400);
      await callback(os.numero, 'billing.pagamento-aprovado', { orderId: 'mp-1', valor: '200.00' });
      expect((await statusDe(os.numero)).status).toBe(StatusOS.FINALIZADA);
      const s = await sagaDe(os.numero);
      expect(s).toMatchObject({ passo: PassoSaga.CONCLUIDA, status: StatusSaga.CONCLUIDA, prazoPagamento: null });
      expect(s.historico.map((h: any) => h.resultado)).toEqual(['avancou', 'avancou', 'avancou', 'avancou', 'avancou', 'avancou', 'avancou', 'avancou', 'concluida']);
      // (as chamadas sao limpas a cada teste: aqui so as do passo 3)
      expect(participantes.tipos(os.numero)).toEqual(['execucao.iniciar', 'billing.cobrar']);
    });
    it('4. atendente entrega -> ENTREGUE; reentrega -> 400', async () => {
      const res = await http().post(`/ordens-servico/${os.id}/entregar`).set('Authorization', `Bearer ${tokens.atendente}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(StatusOS.ENTREGUE);
      expect((await http().post(`/ordens-servico/${os.id}/entregar`).set('Authorization', `Bearer ${tokens.atendente}`)).status).toBe(400);
      expect((await http().post(`/ordens-servico/${os.id}/entregar`).set('Authorization', `Bearer ${tokens.mecanico}`)).status).toBe(403);
    });
    it('5. audit log registra as transicoes', async () => {
      const res = await http().get(`/ordens-servico/${os.id}/audit-log`).set('Authorization', `Bearer ${tokens.admin}`);
      expect(res.status).toBe(200);
      expect(res.body.map((l: any) => l.statusNovo)).toEqual(expect.arrayContaining([StatusOS.EM_DIAGNOSTICO, StatusOS.AGUARDANDO_APROVACAO, StatusOS.EM_EXECUCAO, StatusOS.AGUARDANDO_PAGAMENTO, StatusOS.FINALIZADA, StatusOS.ENTREGUE]));
      expect(res.body.find((l: any) => l.statusNovo === StatusOS.FINALIZADA).acao).toBe('AGUARDANDO_PAGAMENTO -> FINALIZADA');
      expect(res.body.find((l: any) => l.acao === 'DIAGNOSTICO_REGISTRADO')).toMatchObject({ usuarioId: mecanicoUserId });
    });
    it('callback fora de ordem numa saga encerrada e ignorado (200, aplicado=false) e nao corrompe a OS', async () => {
      const res = await callback(os.numero, 'execucao.finalizada', { finalizadaEm: new Date().toISOString() });
      expect(res.body).toEqual({ aplicado: false, passo: PassoSaga.CONCLUIDA, status: StatusSaga.CONCLUIDA });
      expect((await statusDe(os.numero)).status).toBe(StatusOS.ENTREGUE);
    });
  });

  describe('cancelamento', () => {
    it('POST :id/cancelar pelo atendente -> DELETE /execucao/ordens -> CANCELADA com motivo OPERADOR', async () => {
      const os = await createOs();
      const res = await http().post(`/ordens-servico/${os.id}/cancelar`).set('Authorization', `Bearer ${tokens.atendente}`).send({});
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: StatusOS.CANCELADA, motivoCancelamento: MotivoCancelamento.OPERADOR });
      expect(participantes.tipos(os.numero)).toEqual(['execucao.enfileirar', 'execucao.liberar-reservas']);
      expect(participantes.de('execucao.liberar-reservas', os.numero)[0].data).toEqual({ numeroOS: os.numero });
      expect((await sagaDe(os.numero)).status).toBe(StatusSaga.CANCELADA);
      expect((await http().post(`/ordens-servico/${os.id}/cancelar`).set('Authorization', `Bearer ${tokens.atendente}`).send({})).status).toBe(400);
    });
    it('motivo explicito e validado; MECANICO/CLIENTE nao podem', async () => {
      const os = await createOs();
      expect((await http().post(`/ordens-servico/${os.id}/cancelar`).set('Authorization', `Bearer ${tokens.admin}`).send({ motivo: 'INVALIDO' })).status).toBe(400);
      expect((await http().post(`/ordens-servico/${os.id}/cancelar`).set('Authorization', `Bearer ${tokens.admin}`).send({ motivo: MotivoCancelamento.TIMEOUT_APROVACAO })).status).toBe(400);
      expect((await http().post(`/ordens-servico/${os.id}/cancelar`).set('Authorization', `Bearer ${tokens.mecanico}`).send({})).status).toBe(403);
      expect((await http().post(`/ordens-servico/${os.id}/cancelar`).set('Authorization', `Bearer ${tokens.cliente}`).send({})).status).toBe(403);
      const ok = await http().post(`/ordens-servico/${os.id}/cancelar`).set('Authorization', `Bearer ${tokens.admin}`).send({ motivo: MotivoCancelamento.OPERADOR });
      expect(ok.body.motivoCancelamento).toBe(MotivoCancelamento.OPERADOR);
    });
    it('cancelar com orcamento gerado: DELETE /orcamentos e DELETE /execucao/ordens (ordem inversa), confirmados na hora', async () => {
      const os = await ateAguardandoAprovacao();
      const res = await http().post(`/ordens-servico/${os.id}/cancelar`).set('Authorization', `Bearer ${tokens.admin}`).send({});
      expect(res.status).toBe(200);
      expect(await statusDe(os.numero)).toMatchObject({ status: StatusOS.CANCELADA, motivoCancelamento: MotivoCancelamento.OPERADOR });
      expect(participantes.tipos(os.numero).slice(-2)).toEqual(['billing.cancelar-orcamento', 'execucao.liberar-reservas']);
      expect(participantes.de('billing.cancelar-orcamento', os.numero)[0].data).toEqual({ numeroOS: os.numero, motivo: MotivoCancelamento.OPERADOR });
      const saga = await sagaDe(os.numero);
      expect(saga.status).toBe(StatusSaga.CANCELADA);
      expect(saga.compensacoes.map((c: any) => [c.comando, !!c.confirmadaEm])).toEqual([['billing.cancelar-orcamento', true], ['execucao.liberar-reservas', true]]);
    });
  });

  describe('consultas do cliente', () => {
    it('GET /ordens-servico/numero/:numero/status e publico e 404 quando nao existe', async () => {
      const os = await createOs();
      const res = await http().get(`/ordens-servico/numero/${os.numero}/status`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ numero: os.numero, status: StatusOS.EM_DIAGNOSTICO, valorTotal: 0 });
      expect((await http().get('/ordens-servico/numero/OS-0000/status')).status).toBe(404);
    });
    it('GET /clientes/:cpfCnpj/ordens-servico — historico do proprio cliente', async () => {
      const res = await http().get(`/clientes/${CLIENTE_CPF}/ordens-servico`).set('Authorization', `Bearer ${tokens.cliente}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body) ? res.body.length : res.body.data.length).toBeGreaterThan(0);
    });
  });

  describe('DELETE /ordens-servico/:id', () => {
    it('somente ADMIN; 404 quando nao existe', async () => {
      const os = await createOs();
      expect((await http().delete(`/ordens-servico/${os.id}`).set('Authorization', `Bearer ${tokens.atendente}`)).status).toBe(403);
      expect((await http().delete(`/ordens-servico/${os.id}`).set('Authorization', `Bearer ${tokens.admin}`)).status).toBe(204);
      expect((await http().delete(`/ordens-servico/${os.id}`).set('Authorization', `Bearer ${tokens.admin}`)).status).toBe(404);
    });
  });

  describe('saga orquestrada por HTTP (US-F4-10 / US-F4-18): compensacoes, falhas e reprocessamento', () => {
    it('orcamento rejeitado (callback): DELETE /execucao/ordens responde 200 e a saga fecha em CANCELADA', async () => {
      const os = await ateAguardandoAprovacao();
      const res = await callback(os.numero, 'billing.orcamento-rejeitado', { orcamentoId: `orc-${os.numero}`, motivo: 'caro' });
      expect(res.body).toEqual({ aplicado: true, passo: PassoSaga.AGUARDAR_APROVACAO, status: StatusSaga.CANCELADA });
      expect(await statusDe(os.numero)).toMatchObject({ status: StatusOS.CANCELADA, motivoCancelamento: MotivoCancelamento.ORCAMENTO_REJEITADO });
      expect(participantes.tipos(os.numero).slice(-1)).toEqual(['execucao.liberar-reservas']);
      const s = await sagaDe(os.numero);
      expect(s.compensacoes).toEqual([expect.objectContaining({ comando: 'execucao.liberar-reservas', confirmadaEm: expect.any(String) })]);
      expect(s.historico.slice(-2).map((h: any) => [h.evento, h.resultado])).toEqual([['billing.orcamento-rejeitado', 'compensando'], ['execucao.reservas-liberadas', 'cancelada']]);
    });

    it('409 do POST /execucao/ordens (execucao.recusada): OS CANCELADA com EXECUCAO_RECUSADA ja na abertura', async () => {
      participantes.recusar('execucao.enfileirar', 'veiculo ja em execucao');
      const res = await http().post('/ordens-servico').set('Authorization', `Bearer ${tokens.atendente}`).send({ clienteId, veiculoId, descricaoInicial: 'Cliente relata barulho ao frenar' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: StatusOS.CANCELADA, motivoCancelamento: MotivoCancelamento.EXECUCAO_RECUSADA });
      const s = await sagaDe(res.body.numero);
      expect(s.status).toBe(StatusSaga.CANCELADA);
      expect(s.historico[s.historico.length - 1]).toMatchObject({ evento: 'execucao.recusada', resultado: 'cancelada' });
    });

    it('409 do POST /execucao/ordens/{n}/iniciar apos a aprovacao -> cancelar orcamento + liberar reservas (FALHA_INICIO_EXECUCAO)', async () => {
      const os = await ateAguardandoAprovacao();
      participantes.recusar('execucao.iniciar', 'estoque insuficiente');
      const res = await callback(os.numero, 'billing.orcamento-aprovado', { orcamentoId: `orc-${os.numero}` });
      expect(res.body).toMatchObject({ aplicado: true, status: StatusSaga.CANCELADA });
      expect(await statusDe(os.numero)).toMatchObject({ status: StatusOS.CANCELADA, motivoCancelamento: MotivoCancelamento.FALHA_INICIO_EXECUCAO });
      expect(participantes.tipos(os.numero).slice(-3)).toEqual(['execucao.iniciar', 'billing.cancelar-orcamento', 'execucao.liberar-reservas']);
    });

    it('pagamento recusado depois da execucao: OS retida em AGUARDANDO_PAGAMENTO (sem compensacao); reprocessar reenvia POST /orcamentos/{n}/cobrar', async () => {
      const os = await ateAguardandoPagamento();
      const res = await callback(os.numero, 'billing.pagamento-recusado', { orderId: 'mp-1', motivo: 'cartao recusado' });
      expect(res.body).toEqual({ aplicado: true, passo: PassoSaga.AGUARDAR_PAGAMENTO, status: StatusSaga.EM_ANDAMENTO });
      expect(await statusDe(os.numero)).toMatchObject({ status: StatusOS.AGUARDANDO_PAGAMENTO, motivoCancelamento: null });
      let s = await sagaDe(os.numero);
      expect(s.historico[s.historico.length - 1]).toMatchObject({ resultado: 'pagamento-pendente', evento: 'billing.pagamento-recusado' });
      expect((await http().post(`/ordens-servico/${os.id}/cancelar`).set('Authorization', `Bearer ${tokens.admin}`).send({})).status).toBe(400);
      const antes = participantes.de('billing.cobrar', os.numero).length;
      const rep = await http().post(`/admin/sagas/${os.numero}/reprocessar`).set('Authorization', `Bearer ${tokens.admin}`);
      expect(rep.status).toBe(200);
      expect(rep.body.reenviados).toEqual(['billing.cobrar']);
      expect(participantes.de('billing.cobrar', os.numero)).toHaveLength(antes + 1);
      s = rep.body.saga;
      expect(s.passo).toBe(PassoSaga.AGUARDAR_PAGAMENTO);
      expect(s.historico[s.historico.length - 1].detalhe).toMatch(/nova cobranca registrada \(orderId=mp-\d+\)/);
      await callback(os.numero, 'billing.pagamento-aprovado', { orderId: 'mp-2', valor: '300.00' });
      expect((await statusDe(os.numero)).status).toBe(StatusOS.FINALIZADA);
      expect((await sagaDe(os.numero)).status).toBe(StatusSaga.CONCLUIDA);
    });

    it('tentativas esgotadas em POST /orcamentos: saga parada em GERAR_ORCAMENTO; reprocessar reenvia com os itens do snapshot e avanca', async () => {
      participantes.indisponivel('billing.gerar-orcamento');
      const os = await createOs();
      const res = await diagnostico(os.numero);
      expect(res.body).toEqual({ aplicado: true, passo: PassoSaga.GERAR_ORCAMENTO, status: StatusSaga.EM_ANDAMENTO });
      expect((await statusDe(os.numero)).status).toBe(StatusOS.EM_DIAGNOSTICO);
      participantes.restaurar();
      expect((await http().post(`/admin/sagas/${os.numero}/reprocessar`).set('Authorization', `Bearer ${tokens.atendente}`)).status).toBe(403);
      const rep = await http().post(`/admin/sagas/${os.numero}/reprocessar`).set('Authorization', `Bearer ${tokens.admin}`);
      expect(rep.status).toBe(200);
      expect(rep.body.reenviados).toEqual(['billing.gerar-orcamento']);
      expect(rep.body.saga.passo).toBe(PassoSaga.AGUARDAR_APROVACAO);
      const chamadas = participantes.de('billing.gerar-orcamento', os.numero);
      expect(chamadas).toHaveLength(2);
      expect(chamadas[1].data.itens).toEqual(ITENS);
      expect((await statusDe(os.numero)).status).toBe(StatusOS.AGUARDANDO_APROVACAO);
      expect((await http().post('/admin/sagas/OS-NAO-EXISTE/reprocessar').set('Authorization', `Bearer ${tokens.admin}`)).status).toBe(404);
    });

    it('Execucao fora do ar na abertura: reprocessar reenvia POST /execucao/ordens e a OS vai para EM_DIAGNOSTICO', async () => {
      participantes.indisponivel('execucao.enfileirar');
      const os = await createOs();
      expect(os.status).toBe(StatusOS.RECEBIDA);
      participantes.restaurar();
      const rep = await http().post(`/admin/sagas/${os.numero}/reprocessar`).set('Authorization', `Bearer ${tokens.admin}`);
      expect(rep.body.reenviados).toEqual(['execucao.enfileirar']);
      expect(rep.body.saga.passo).toBe(PassoSaga.AGUARDAR_DIAGNOSTICO);
      expect((await statusDe(os.numero)).status).toBe(StatusOS.EM_DIAGNOSTICO);
    });

    it('timeout de aprovacao: o relogio da saga compensa com TIMEOUT_APROVACAO pelos dois DELETEs', async () => {
      process.env.SAGA_TIMEOUT_APROVACAO_MS = '1';
      try {
        const os = await ateAguardandoAprovacao();
        const vencidas = await moduleRef.get(SagaTimeoutsService).varrer(new Date(Date.now() + 1000));
        expect(vencidas).toBeGreaterThanOrEqual(1);
        expect(await statusDe(os.numero)).toMatchObject({ status: StatusOS.CANCELADA, motivoCancelamento: MotivoCancelamento.TIMEOUT_APROVACAO });
        const s = await sagaDe(os.numero);
        expect(s.status).toBe(StatusSaga.CANCELADA);
        expect(s.compensacoes.map((c: any) => c.comando)).toEqual(['billing.cancelar-orcamento', 'execucao.liberar-reservas']);
        expect(participantes.tipos(os.numero).slice(-2)).toEqual(['billing.cancelar-orcamento', 'execucao.liberar-reservas']);
      } finally {
        delete process.env.SAGA_TIMEOUT_APROVACAO_MS;
      }
    });

    it('pagamento em atraso: o relogio so registra (OS retida em AGUARDANDO_PAGAMENTO, sem cancelar nem chamar participante)', async () => {
      process.env.SAGA_TIMEOUT_PAGAMENTO_MS = '1';
      try {
        const os = await ateAguardandoPagamento();
        const antes = participantes.chamadas.length;
        expect(await moduleRef.get(SagaTimeoutsService).varrer(new Date(Date.now() + 1000))).toBeGreaterThanOrEqual(1);
        expect(await statusDe(os.numero)).toMatchObject({ status: StatusOS.AGUARDANDO_PAGAMENTO, motivoCancelamento: null });
        const s = await sagaDe(os.numero);
        expect(s).toMatchObject({ passo: PassoSaga.AGUARDAR_PAGAMENTO, status: StatusSaga.EM_ANDAMENTO, compensacoes: [], prazoPagamento: null });
        expect(s.historico[s.historico.length - 1]).toMatchObject({ evento: 'saga.timeout', resultado: 'ignorado' });
        expect(participantes.chamadas).toHaveLength(antes);
      } finally {
        delete process.env.SAGA_TIMEOUT_PAGAMENTO_MS;
      }
    });

    const casosCancelamento: Array<[string, TipoComando[], number, string[]]> = [
      ['ENFILEIRAR_EXECUCAO', ['execucao.enfileirar'], 0, ['execucao.liberar-reservas']],
      ['AGUARDAR_DIAGNOSTICO', [], 0, ['execucao.liberar-reservas']],
      ['GERAR_ORCAMENTO', ['billing.gerar-orcamento'], 1, ['billing.cancelar-orcamento', 'execucao.liberar-reservas']],
      ['AGUARDAR_APROVACAO', [], 1, ['billing.cancelar-orcamento', 'execucao.liberar-reservas']],
      ['INICIAR_EXECUCAO', ['execucao.iniciar'], 2, ['billing.cancelar-orcamento', 'execucao.liberar-reservas']],
    ];
    it.each(casosCancelamento)('cancelamento manual em %s envia %j e fecha a saga em CANCELADA', async (passo, indisponiveis, callbacks, esperados) => {
      for (const c of indisponiveis) participantes.indisponivel(c);
      const os = await createOs();
      if (callbacks >= 1) await diagnostico(os.numero);
      if (callbacks >= 2) await callback(os.numero, 'billing.orcamento-aprovado', { orcamentoId: 'o' });
      expect((await sagaDe(os.numero)).passo).toBe(passo);
      participantes.restaurar();
      const res = await http().post(`/ordens-servico/${os.id}/cancelar`).set('Authorization', `Bearer ${tokens.atendente}`).send({});
      expect(res.status).toBe(200);
      expect(participantes.tipos(os.numero).slice(-esperados.length)).toEqual(esperados);
      expect((await sagaDe(os.numero)).status).toBe(StatusSaga.CANCELADA);
    });

    it('diagnostico sem itens (viola o contrato) e ignorado: OS e saga seguem esperando, nada e chamado', async () => {
      const os = await createOs();
      const res = await diagnostico(os.numero, []);
      expect(res.body).toEqual({ aplicado: false, passo: PassoSaga.AGUARDAR_DIAGNOSTICO, status: StatusSaga.EM_ANDAMENTO });
      expect(participantes.tipos(os.numero)).toEqual(['execucao.enfileirar']);
      expect((await statusDe(os.numero)).status).toBe(StatusOS.EM_DIAGNOSTICO);
    });

    it('OS sem saga e adotada no passo equivalente ao status e o fluxo continua', async () => {
      const os = await createOs();
      await prisma.sagaOS.deleteMany({ where: { numero: os.numero } });
      const res = await diagnostico(os.numero);
      expect(res.body).toEqual({ aplicado: true, passo: PassoSaga.AGUARDAR_APROVACAO, status: StatusSaga.EM_ANDAMENTO });
      const s = await sagaDe(os.numero);
      expect(s.historico[0]).toMatchObject({ evento: 'saga.adotada' });
      expect((await statusDe(os.numero)).status).toBe(StatusOS.AGUARDANDO_APROVACAO);
    });

    it('transacao unica: se a saga nao puder ser gravada, a OS volta atras, nenhum participante e chamado e o id nao e marcado', async () => {
      const os = await createOs();
      const repo = moduleRef.get(PrismaSagaRepository);
      const spy = jest.spyOn(repo, 'save').mockRejectedValueOnce(new Error('falha simulada ao gravar a saga'));
      const body = criarEnvelopeHttp({ type: 'execucao.diagnostico-concluido', producer: 'execucao-service', data: { numeroOS: os.numero, mecanicoId: mecanicoUserId, diagnostico: 'Pastilhas gastas', itens: ITENS } });
      try {
        expect((await http().post(`/ordens-servico/${os.numero}/eventos`).set('Authorization', `Bearer ${tokens.execucao}`).send(body)).status).toBe(500);
      } finally {
        spy.mockRestore();
      }
      const s = await statusDe(os.numero);
      expect(s.status).toBe(StatusOS.EM_DIAGNOSTICO);
      expect(s.servicos).toHaveLength(0);
      expect((await sagaDe(os.numero)).passo).toBe(PassoSaga.AGUARDAR_DIAGNOSTICO);
      expect(participantes.de('billing.gerar-orcamento', os.numero)).toHaveLength(0);
      expect(await prisma.processedMessage.findUnique({ where: { id: body.id } })).toBeNull();
      // reentrega do mesmo envelope funciona normalmente
      const again = await http().post(`/ordens-servico/${os.numero}/eventos`).set('Authorization', `Bearer ${tokens.execucao}`).send(body);
      expect(again.body).toMatchObject({ aplicado: true, passo: PassoSaga.AGUARDAR_APROVACAO });
    });

    it('injecao de falhas (demo): x-simular-falha=AGUARDAR_PAGAMENTO transforma o pagamento aprovado em recusado (pendente, sem compensacao)', async () => {
      process.env.SAGA_SIMULAR_FALHA_HABILITADO = 'true';
      try {
        const res = await http().post('/ordens-servico').set('Authorization', `Bearer ${tokens.atendente}`).set('x-simular-falha', 'aguardar_pagamento')
          .send({ clienteId, veiculoId, descricaoInicial: 'Cliente relata barulho ao frenar' });
        expect(res.status).toBe(201);
        const os = res.body as { id: string; numero: string };
        expect((await sagaDe(os.numero)).falhaSimulada).toBe(PassoSaga.AGUARDAR_PAGAMENTO);
        await diagnostico(os.numero);
        await callback(os.numero, 'billing.orcamento-aprovado', { orcamentoId: 'o' });
        await callback(os.numero, 'execucao.finalizada', { finalizadaEm: new Date().toISOString() });
        const antes = participantes.chamadas.length;
        await callback(os.numero, 'billing.pagamento-aprovado', { orderId: 'mp-1', valor: '300.00' });
        expect(await statusDe(os.numero)).toMatchObject({ status: StatusOS.AGUARDANDO_PAGAMENTO, motivoCancelamento: null });
        const s = await sagaDe(os.numero);
        expect(s).toMatchObject({ status: StatusSaga.EM_ANDAMENTO, passo: PassoSaga.AGUARDAR_PAGAMENTO, falhaSimulada: null, compensacoes: [] });
        expect(s.historico.slice(-2).map((h: any) => h.resultado)).toEqual(['falha-simulada', 'pagamento-pendente']);
        expect(participantes.chamadas).toHaveLength(antes);
        expect((await http().post('/ordens-servico').set('Authorization', `Bearer ${tokens.atendente}`).set('x-simular-falha', 'PASSO_X').send({ clienteId, veiculoId, descricaoInicial: 'Cliente relata barulho' })).status).toBe(400);
      } finally {
        delete process.env.SAGA_SIMULAR_FALHA_HABILITADO;
      }
      expect((await http().post('/ordens-servico').set('Authorization', `Bearer ${tokens.atendente}`).set('x-simular-falha', 'AGUARDAR_PAGAMENTO').send({ clienteId, veiculoId, descricaoInicial: 'Cliente relata barulho' })).status).toBe(400);
    });

    it('GET numero/:numero/saga: 404 sem saga; CLIENTE nao acessa', async () => {
      expect((await http().get('/ordens-servico/numero/OS-NAO-EXISTE/saga').set('Authorization', `Bearer ${tokens.admin}`)).status).toBe(404);
      const os = await createOs();
      expect((await http().get(`/ordens-servico/numero/${os.numero}/saga`).set('Authorization', `Bearer ${tokens.cliente}`)).status).toBe(403);
    });
  });

  describe('notificacoes ao cliente a partir dos fatos da saga (US-F4-12)', () => {
    interface NotificacaoView { tipo: string; canal: string; numeroOS: string | null; eventoId: string | null; linkPagamento: string | null; mensagem: string; status: string }
    const notificacoesDa = async (ordemId: string): Promise<NotificacaoView[]> => {
      const res = await http().get('/notificacoes').query({ ordemDeServicoId: ordemId, limit: 100 }).set('Authorization', `Bearer ${tokens.atendente}`);
      expect(res.status).toBe(200);
      return res.body.data;
    };
    /** O listener e assincrono ao emit: espera (polling, sem sleep fixo) ate as notificacoes esperadas aparecerem. */
    const esperarTipos = async (ordemId: string, tipos: string[], timeoutMs = 5000): Promise<NotificacaoView[]> => {
      const limite = Date.now() + timeoutMs;
      for (;;) {
        const atuais = await notificacoesDa(ordemId);
        // Espera a linha existir E o envio terminar: a notificacao e gravada PENDENTE e so depois vira ENVIADA/FALHOU.
        const prontas = tipos.every((t) => atuais.some((n) => n.tipo === t && n.status !== 'PENDENTE'));
        if (prontas || Date.now() > limite) return atuais;
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const contar = (ns: NotificacaoView[], tipo: string) => ns.filter((n) => n.tipo === tipo).length;

    it('callback billing.pagamento-aprovado gera PAGAMENTO_APROVADO + OS_FINALIZADA consultaveis em GET /notificacoes (com numeroOS e eventoId)', async () => {
      const os = await ateAguardandoPagamento();
      const pago = criarEnvelopeHttp({ type: 'billing.pagamento-aprovado', producer: 'billing-service', data: { numeroOS: os.numero, orderId: 'mp-1', valor: '300.00' } });
      expect((await http().post(`/ordens-servico/${os.numero}/eventos`).set('Authorization', `Bearer ${tokens.billing}`).send(pago)).body).toMatchObject({ aplicado: true });

      const ns = await esperarTipos(os.id, ['PAGAMENTO_APROVADO', 'OS_FINALIZADA']);
      expect(ns.find((n) => n.tipo === 'PAGAMENTO_APROVADO')).toMatchObject({ numeroOS: os.numero, eventoId: pago.id, canal: 'EMAIL', status: 'ENVIADA' });
      expect(ns.find((n) => n.tipo === 'OS_FINALIZADA')).toMatchObject({ numeroOS: os.numero, eventoId: `os.finalizada:${os.numero}` });

      // callback repetido (mesmo id): dedup em processed_messages -> nenhuma notificacao nova
      const dup = await http().post(`/ordens-servico/${os.numero}/eventos`).set('Authorization', `Bearer ${tokens.billing}`).send(pago);
      expect(dup.body).toMatchObject({ aplicado: false, duplicado: true });
      await new Promise((r) => setTimeout(r, 200));
      const depois = await notificacoesDa(os.id);
      expect(contar(depois, 'PAGAMENTO_APROVADO')).toBe(1);
      expect(contar(depois, 'OS_FINALIZADA')).toBe(1);
    });

    it('fluxo completo: uma notificacao por marco, link de pagamento no PAGAMENTO_PENDENTE e sem a generica nos status com notificacao propria', async () => {
      const os = await ateAguardandoPagamento();
      expect((await callback(os.numero, 'billing.pagamento-aprovado', { orderId: 'mp-x' })).status).toBe(200);
      const ns = await esperarTipos(os.id, ['ORCAMENTO_PRONTO', 'ORCAMENTO_APROVADO', 'PAGAMENTO_PENDENTE', 'PAGAMENTO_APROVADO', 'OS_FINALIZADA']);

      for (const tipo of ['ORCAMENTO_PRONTO', 'ORCAMENTO_APROVADO', 'PAGAMENTO_PENDENTE', 'PAGAMENTO_APROVADO', 'OS_FINALIZADA']) {
        expect([tipo, contar(ns, tipo)]).toEqual([tipo, 1]);
      }
      const pendente = ns.find((n) => n.tipo === 'PAGAMENTO_PENDENTE')!;
      expect(pendente.linkPagamento).toMatch(/^https:\/\/mp\.test\/pay\/mp-\d+$/);
      expect(pendente.mensagem).toContain(pendente.linkPagamento);
      expect(ns.find((n) => n.tipo === 'ORCAMENTO_APROVADO')!.linkPagamento).toBeNull();
      // generica so para EM_DIAGNOSTICO e EM_EXECUCAO
      const genericas = ns.filter((n) => n.tipo === 'STATUS_OS_ALTERADO').map((n) => n.eventoId).sort();
      expect(genericas).toEqual([`os.status:${os.numero}:EM_DIAGNOSTICO`, `os.status:${os.numero}:EM_EXECUCAO`]);

      // o cliente ve o link na propria consulta (campo novo e opcional)
      const doCliente = await http().get(`/clientes/${CLIENTE_CPF}/notificacoes`).set('Authorization', `Bearer ${tokens.cliente}`);
      expect(doCliente.status).toBe(200);
      expect(doCliente.body.data.find((n: NotificacaoView) => n.eventoId === pendente.eventoId)).toMatchObject({ linkPagamento: pendente.linkPagamento, tipo: 'PAGAMENTO_PENDENTE' });
    });

    it('pagamento recusado gera PAGAMENTO_RECUSADO com o motivo (OS segue AGUARDANDO_PAGAMENTO)', async () => {
      const os = await ateAguardandoPagamento();
      expect((await callback(os.numero, 'billing.pagamento-recusado', { orderId: 'mp-r', motivo: 'cartao recusado' })).body).toMatchObject({ aplicado: true });
      const ns = await esperarTipos(os.id, ['PAGAMENTO_RECUSADO']);
      expect(ns.find((n) => n.tipo === 'PAGAMENTO_RECUSADO')!.mensagem).toContain('cartao recusado');
      expect((await statusDe(os.numero)).status).toBe(StatusOS.AGUARDANDO_PAGAMENTO);
    });

    it('cancelamento pelo atendente gera OS_CANCELADA (e nao a generica de status)', async () => {
      const os = await createOs();
      expect((await http().post(`/ordens-servico/${os.id}/cancelar`).set('Authorization', `Bearer ${tokens.atendente}`).send({})).status).toBe(200);
      const ns = await esperarTipos(os.id, ['OS_CANCELADA']);
      expect(ns.find((n) => n.tipo === 'OS_CANCELADA')).toMatchObject({ eventoId: `os.cancelada:${os.numero}` });
      expect(ns.find((n) => n.tipo === 'OS_CANCELADA')!.mensagem).toContain(MotivoCancelamento.OPERADOR);
      expect(ns.filter((n) => n.tipo === 'STATUS_OS_ALTERADO' && n.eventoId?.endsWith(':CANCELADA'))).toEqual([]);
    });
  });
});
