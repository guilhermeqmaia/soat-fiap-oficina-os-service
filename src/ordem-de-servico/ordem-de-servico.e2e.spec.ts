import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '@guilhermeqmaia/oficina-kit/auth';
import { mintToken } from '@guilhermeqmaia/oficina-kit/testing';
import { StatusOS } from './domain/value-objects/status-os.vo';
import { MotivoCancelamento } from './domain/value-objects/motivo-cancelamento';
import {
  RegistrarCancelamentoUseCase,
  RegistrarDiagnosticoUseCase,
  RegistrarEnfileiramentoUseCase,
  RegistrarExecucaoFinalizadaUseCase,
  RegistrarExecucaoIniciadaUseCase,
  RegistrarOrcamentoAprovadoUseCase,
  RegistrarOrcamentoGeradoUseCase,
} from './application/use-cases/transicoes';
import { startTestDatabase, stopTestDatabase } from '../test/database.container';
import { criarEnvelope, OutboxPoller, SqsConsumer } from '@guilhermeqmaia/oficina-kit/messaging';
import { SagaTimeoutsService } from './saga/application/saga-timeouts.service';
import { PassoSaga, StatusSaga } from './saga/domain/saga-os.entity';
import { PrismaSagaRepository } from './saga/infrastructure/prisma-saga.repository';
import {
  BillingOrcamentoAprovadoHandler,
  BillingOrcamentoCanceladoHandler,
  BillingOrcamentoGeradoHandler,
  BillingOrcamentoRejeitadoHandler,
  BillingPagamentoAprovadoHandler,
  BillingPagamentoRecusadoHandler,
  ExecucaoDiagnosticoConcluidoHandler,
  ExecucaoEnfileiradaHandler,
  ExecucaoFinalizadaHandler,
  ExecucaoIniciadaHandler,
  ExecucaoRecusadaHandler,
  ExecucaoReservasLiberadasHandler,
} from './infrastructure/messaging';

jest.setTimeout(120000);

const CLIENTE_CPF = '52998224725';

/**
 * OS Service (Fase 4): a API expoe apenas abertura, consulta, entrega e
 * cancelamento. As demais transicoes chegam por evento (Execucao/Billing) e aqui
 * sao disparadas direto nos use cases de transicao — o mesmo caminho que os
 * handlers SQS percorrem (US-F4-06 PR 2).
 */
describe('OrdemDeServico (e2e) — OS Service', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let moduleRef: TestingModule;
  const tokens: Record<string, string> = {};
  let clienteId: string;
  let veiculoId: string;
  let mecanicoUserId: string;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    process.env.DATABASE_URL = await startTestDatabase();
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
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

  const createOs = async (token = tokens.admin) => {
    const res = await http().post('/ordens-servico').set('Authorization', `Bearer ${token}`)
      .send({ clienteId, veiculoId, descricaoInicial: 'Cliente relata barulho ao frenar' });
    expect(res.status).toBe(201);
    return res.body as { id: string; status: string; numero: string };
  };
  /** Simula os eventos da saga ate AGUARDANDO_APROVACAO. */
  const ateAguardandoAprovacao = async (numero: string) => {
    await moduleRef.get(RegistrarEnfileiramentoUseCase).execute({ numero });
    await moduleRef.get(RegistrarDiagnosticoUseCase).execute({
      numero, mecanicoId: mecanicoUserId, diagnostico: 'Pastilhas gastas e disco empenado',
      itens: [
        { tipo: 'SERVICO', referenciaId: 'srv-1', nome: 'Troca de pastilha', quantidade: 1, precoUnitario: '200.00' },
        { tipo: 'PRODUTO', referenciaId: 'prd-1', nome: 'Pastilha dianteira', quantidade: 2, precoUnitario: '50.00', servicoId: 'srv-1' },
      ],
    });
    await moduleRef.get(RegistrarOrcamentoGeradoUseCase).execute({ numero, total: '300.00' });
  };

  describe('POST /ordens-servico', () => {
    it('abre a OS RECEBIDA sem itens e sem mecanico', async () => {
      const res = await http().post('/ordens-servico').set('Authorization', `Bearer ${tokens.atendente}`)
        .send({ clienteId, veiculoId, descricaoInicial: 'Cliente relata barulho ao frenar' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: StatusOS.RECEBIDA, mecanicoId: null, motivoCancelamento: null, valorTotal: 0, itensServico: [] });
      expect(res.body.numero).toMatch(/^OS-\d{4}-/);
    });
    it('404 cliente/veiculo inexistente, 409 veiculo de outro cliente, 400 descricao curta', async () => {
      const auth = (r: request.Test) => r.set('Authorization', `Bearer ${tokens.admin}`);
      expect((await auth(http().post('/ordens-servico')).send({ clienteId: '00000000-0000-4000-8000-000000000000', veiculoId, descricaoInicial: 'Barulho ao frenar' })).status).toBe(404);
      expect((await auth(http().post('/ordens-servico')).send({ clienteId, veiculoId: '00000000-0000-4000-8000-000000000000', descricaoInicial: 'Barulho ao frenar' })).status).toBe(404);
      const outro = await auth(http().post('/clientes')).send({ nome: 'Outro', cpfCnpj: '11.222.333/0001-81', telefone: '11000000000' });
      const vOutro = await auth(http().post('/veiculos')).send({ placa: 'OUT1R23', marca: 'Fiat', modelo: 'Uno', ano: 2020, clienteId: outro.body.id });
      expect((await auth(http().post('/ordens-servico')).send({ clienteId, veiculoId: vOutro.body.id, descricaoInicial: 'Barulho ao frenar' })).status).toBe(409);
      expect((await auth(http().post('/ordens-servico')).send({ clienteId, veiculoId, descricaoInicial: 'abc' })).status).toBe(400);
    });
    it('401 sem token; 403 para CLIENTE, MECANICO e ESTOQUISTA', async () => {
      expect((await http().post('/ordens-servico').send({ clienteId, veiculoId, descricaoInicial: 'Barulho ao frenar' })).status).toBe(401);
      for (const t of ['cliente', 'mecanico', 'estoquista']) {
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
      const porStatus = await http().get(`/ordens-servico?status=${StatusOS.RECEBIDA}&clienteId=${clienteId}`).set('Authorization', `Bearer ${tokens.admin}`);
      expect(porStatus.body.data.every((o: any) => o.status === StatusOS.RECEBIDA)).toBe(true);
      expect((await http().get('/ordens-servico').set('Authorization', `Bearer ${tokens.cliente}`)).status).toBe(403);
    });
    it('detalhe traz cabecalho/corpo/rodape com snapshot e mecanico', async () => {
      const os = await createOs();
      await ateAguardandoAprovacao(os.numero);
      const res = await http().get(`/ordens-servico/${os.id}`).set('Authorization', `Bearer ${tokens.atendente}`);
      expect(res.status).toBe(200);
      expect(res.body.cabecalho).toMatchObject({ status: StatusOS.AGUARDANDO_APROVACAO, mecanicoAtribuido: 'Carlos Mecanico', motivoCancelamento: null });
      expect(res.body.corpo.servicos[0]).toMatchObject({ descricaoServico: 'Troca de pastilha', precoUnitario: 200 });
      expect(res.body.corpo.servicos[0].produtos[0]).toMatchObject({ descricaoProduto: 'Pastilha dianteira', quantidade: 2 });
      expect(res.body.rodape.valorTotalOrdemServico).toBe(300);
      expect((await http().get(`/ordens-servico/${os.id}`).set('Authorization', `Bearer ${tokens.cliente}`)).status).toBe(403);
      expect((await http().get('/ordens-servico/00000000-0000-4000-8000-000000000000').set('Authorization', `Bearer ${tokens.admin}`)).status).toBe(404);
    });
  });

  describe('ciclo de vida dirigido por eventos (RECEBIDA -> ENTREGUE)', () => {
    let os: { id: string; numero: string };
    const statusAtual = async () => (await http().get(`/ordens-servico/numero/${os.numero}/status`)).body;

    it('1. abre e enfileira -> EM_DIAGNOSTICO', async () => {
      os = await createOs();
      await moduleRef.get(RegistrarEnfileiramentoUseCase).execute({ numero: os.numero });
      expect((await statusAtual()).status).toBe(StatusOS.EM_DIAGNOSTICO);
    });
    it('2. diagnostico concluido grava snapshot; orcamento gerado -> AGUARDANDO_APROVACAO', async () => {
      await moduleRef.get(RegistrarDiagnosticoUseCase).execute({
        numero: os.numero, mecanicoId: mecanicoUserId, diagnostico: 'Pastilhas gastas',
        itens: [{ tipo: 'SERVICO', referenciaId: 'srv-1', nome: 'Troca de pastilha', quantidade: 1, precoUnitario: '200.00' }],
      });
      await moduleRef.get(RegistrarOrcamentoGeradoUseCase).execute({ numero: os.numero, total: '200.00' });
      const s = await statusAtual();
      expect(s.status).toBe(StatusOS.AGUARDANDO_APROVACAO);
      expect(s.servicos[0]).toMatchObject({ nome: 'Troca de pastilha', subtotal: 200 });
      expect(s.valorTotal).toBe(200);
    });
    it('3. aprovado -> AGUARDANDO_PAGAMENTO; execucao iniciada -> EM_EXECUCAO; finalizada -> FINALIZADA', async () => {
      await moduleRef.get(RegistrarOrcamentoAprovadoUseCase).execute({ numero: os.numero });
      expect((await statusAtual()).status).toBe(StatusOS.AGUARDANDO_PAGAMENTO);
      await moduleRef.get(RegistrarExecucaoIniciadaUseCase).execute({ numero: os.numero });
      expect((await statusAtual()).status).toBe(StatusOS.EM_EXECUCAO);
      // cancelamento manual nao e mais possivel
      expect((await http().post(`/ordens-servico/${os.id}/cancelar`).set('Authorization', `Bearer ${tokens.atendente}`).send({})).status).toBe(400);
      await moduleRef.get(RegistrarExecucaoFinalizadaUseCase).execute({ numero: os.numero });
      expect((await statusAtual()).status).toBe(StatusOS.FINALIZADA);
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
      expect(res.body.map((l: any) => l.statusNovo)).toEqual(expect.arrayContaining([StatusOS.EM_DIAGNOSTICO, StatusOS.AGUARDANDO_APROVACAO, StatusOS.EM_EXECUCAO, StatusOS.ENTREGUE]));
      expect(res.body.find((l: any) => l.statusNovo === StatusOS.ENTREGUE).acao).toBe('FINALIZADA -> ENTREGUE');
      expect(res.body.find((l: any) => l.acao === 'DIAGNOSTICO_REGISTRADO')).toMatchObject({ usuarioId: mecanicoUserId });
    });
    it('evento fora de ordem e rejeitado (vai para a DLQ) e nao corrompe a OS', async () => {
      await expect(moduleRef.get(RegistrarExecucaoFinalizadaUseCase).execute({ numero: os.numero })).rejects.toThrow();
      expect((await statusAtual()).status).toBe(StatusOS.ENTREGUE);
    });
  });

  describe('cancelamento', () => {
    it('POST :id/cancelar pelo atendente -> CANCELADA com motivo OPERADOR', async () => {
      const os = await createOs();
      const res = await http().post(`/ordens-servico/${os.id}/cancelar`).set('Authorization', `Bearer ${tokens.atendente}`).send({});
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: StatusOS.CANCELADA, motivoCancelamento: MotivoCancelamento.OPERADOR });
      expect((await http().post(`/ordens-servico/${os.id}/cancelar`).set('Authorization', `Bearer ${tokens.atendente}`).send({})).status).toBe(400);
    });
    it('motivo explicito e validado; MECANICO/CLIENTE nao podem', async () => {
      const os = await createOs();
      expect((await http().post(`/ordens-servico/${os.id}/cancelar`).set('Authorization', `Bearer ${tokens.admin}`).send({ motivo: 'INVALIDO' })).status).toBe(400);
      // motivos da saga (timeouts/compensacoes) nao podem ser informados pelo atendente
      expect((await http().post(`/ordens-servico/${os.id}/cancelar`).set('Authorization', `Bearer ${tokens.admin}`).send({ motivo: MotivoCancelamento.TIMEOUT_APROVACAO })).status).toBe(400);
      expect((await http().post(`/ordens-servico/${os.id}/cancelar`).set('Authorization', `Bearer ${tokens.mecanico}`).send({})).status).toBe(403);
      expect((await http().post(`/ordens-servico/${os.id}/cancelar`).set('Authorization', `Bearer ${tokens.cliente}`).send({})).status).toBe(403);
      const ok = await http().post(`/ordens-servico/${os.id}/cancelar`).set('Authorization', `Bearer ${tokens.admin}`).send({ motivo: MotivoCancelamento.OPERADOR });
      expect(ok.body.motivoCancelamento).toBe(MotivoCancelamento.OPERADOR);
    });
    it('compensacao da saga (evento) cancela com o motivo recebido — sempre pelo orquestrador', async () => {
      const os = await createOs();
      await ateAguardandoAprovacao(os.numero);
      // OS avancou por use cases diretos; a saga ainda esta em ENFILEIRAR_EXECUCAO — o cancelamento manual passa pela saga
      const res = await http().post(`/ordens-servico/${os.id}/cancelar`).set('Authorization', `Bearer ${tokens.admin}`).send({});
      expect(res.status).toBe(200);
      const s = (await http().get(`/ordens-servico/numero/${os.numero}/status`)).body;
      expect(s).toMatchObject({ status: StatusOS.CANCELADA, motivoCancelamento: MotivoCancelamento.OPERADOR });
      const saga = (await http().get(`/ordens-servico/numero/${os.numero}/saga`).set('Authorization', `Bearer ${tokens.admin}`)).body;
      expect(saga.status).toBe(StatusSaga.COMPENSANDO);
    });
  });

  describe('consultas do cliente', () => {
    it('GET /ordens-servico/numero/:numero/status e publico e 404 quando nao existe', async () => {
      const os = await createOs();
      const res = await http().get(`/ordens-servico/numero/${os.numero}/status`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ numero: os.numero, status: StatusOS.RECEBIDA, valorTotal: 0 });
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

  describe('mensageria (US-F4-06 PR 2): outbox transacional + handlers da fila os-eventos', () => {
    const outboxDe = (numero: string) => prisma.outbox.findMany({ where: { correlationId: numero, type: { startsWith: 'os.' } }, orderBy: { criadaEm: 'asc' } });
    const comandosDe = async (numero: string) =>
      (await prisma.outbox.findMany({ where: { correlationId: numero, NOT: { type: { startsWith: 'os.' } } }, orderBy: { criadaEm: 'asc' } })).map((r) => r.type);
    const envelope = <T>(type: string, data: T) => criarEnvelope({ type, data, producer: 'execucao-service', correlationId: (data as any).numeroOS });

    it('poller e consumer existem mas ficam parados nos testes (MESSAGING_AUTOSTART=false)', () => {
      expect(moduleRef.get(OutboxPoller)).toBeDefined();
      expect(moduleRef.get(SqsConsumer)).toBeDefined();
    });

    it('abrir a OS grava os.aberta no outbox (PENDENTE) com resumo e CPF mascarado', async () => {
      const os = await createOs();
      const rows = await outboxDe(os.numero);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: 'os.aberta', status: 'PENDENTE', tentativas: 0 });
      const env = rows[0].envelope as any;
      expect(env).toMatchObject({ type: 'os.aberta', producer: 'os-service', correlationId: os.numero, version: 1 });
      expect(env.data).toMatchObject({
        numeroOS: os.numero,
        cliente: { id: clienteId, nome: 'Joao Silva', cpfMascarado: '***.***.***-25' },
        veiculo: { id: veiculoId, placa: 'TES1T23', modelo: 'Corolla' },
        descricaoProblema: 'Cliente relata barulho ao frenar',
      });
      expect(JSON.stringify(env)).not.toContain(CLIENTE_CPF);
    });

    it('cancelar, finalizar e entregar geram os.cancelada / os.finalizada / os.entregue; transicoes intermediarias nao', async () => {
      const cancelada = await createOs();
      await http().post(`/ordens-servico/${cancelada.id}/cancelar`).set('Authorization', `Bearer ${tokens.admin}`).send({});
      expect((await outboxDe(cancelada.numero)).map((r) => [r.type, (r.envelope as any).data.motivo])).toEqual([['os.aberta', undefined], ['os.cancelada', 'OPERADOR']]);

      const os = await createOs();
      await ateAguardandoAprovacao(os.numero);
      await moduleRef.get(RegistrarOrcamentoAprovadoUseCase).execute({ numero: os.numero });
      await moduleRef.get(RegistrarExecucaoIniciadaUseCase).execute({ numero: os.numero });
      expect((await outboxDe(os.numero)).map((r) => r.type)).toEqual(['os.aberta']);
      await moduleRef.get(RegistrarExecucaoFinalizadaUseCase).execute({ numero: os.numero });
      await http().post(`/ordens-servico/${os.id}/entregar`).set('Authorization', `Bearer ${tokens.atendente}`);
      expect((await outboxDe(os.numero)).map((r) => r.type)).toEqual(['os.aberta', 'os.finalizada', 'os.entregue']);
    });

    it('handlers traduzem o contrato AsyncAPI para as transicoes (enfileirada -> diagnostico -> orcamento)', async () => {
      const os = await createOs();
      await moduleRef.get(ExecucaoEnfileiradaHandler).handle(envelope('execucao.enfileirada', { numeroOS: os.numero, posicaoFila: 1 }));
      await moduleRef.get(ExecucaoDiagnosticoConcluidoHandler).handle(
        envelope('execucao.diagnostico-concluido', {
          numeroOS: os.numero, mecanicoId: mecanicoUserId, diagnostico: 'Disco empenado',
          itens: [
            { tipo: 'SERVICO' as const, referenciaId: 'srv-9', nome: 'Retifica de disco', quantidade: 2, precoUnitario: '90.00' },
            { tipo: 'PRODUTO' as const, referenciaId: 'prd-9', nome: 'Disco', quantidade: 2, precoUnitario: '150.00', servicoId: 'srv-9' },
          ],
        }),
      );
      await moduleRef.get(BillingOrcamentoGeradoHandler).handle(envelope('billing.orcamento-gerado', { numeroOS: os.numero, orcamentoId: 'orc-1', total: '480.00', validoAte: new Date().toISOString() }));
      const s = (await http().get(`/ordens-servico/numero/${os.numero}/status`)).body;
      expect(s.status).toBe(StatusOS.AGUARDANDO_APROVACAO);
      expect(s.servicos[0]).toMatchObject({ nome: 'Retifica de disco', subtotal: 180, produtos: [{ nome: 'Disco', subtotal: 300 }] });
      expect(s.valorTotal).toBe(480);
    });

    it('compensacao vinda da Execucao (execucao.recusada) cancela com EXECUCAO_RECUSADA e publica os.cancelada', async () => {
      const os = await createOs();
      await moduleRef.get(ExecucaoRecusadaHandler).handle(envelope('execucao.recusada', { numeroOS: os.numero, motivo: 'veiculo ja em execucao' }));
      const s = (await http().get(`/ordens-servico/numero/${os.numero}/status`)).body;
      expect(s).toMatchObject({ status: StatusOS.CANCELADA, motivoCancelamento: MotivoCancelamento.EXECUCAO_RECUSADA });
      const rows = await outboxDe(os.numero);
      expect(rows.map((r) => r.type)).toEqual(['os.aberta', 'os.cancelada']);
      // causationId aponta para o envelope execucao.recusada que originou a compensacao
      expect((rows[1].envelope as any).causationId).toBeDefined();
    });

    it('handler com OS inexistente lanca (mensagem volta para a fila -> DLQ)', async () => {
      await expect(moduleRef.get(ExecucaoEnfileiradaHandler).handle(envelope('execucao.enfileirada', { numeroOS: 'OS-NAO-EXISTE', posicaoFila: 1 }))).rejects.toThrow();
    });
  });

  describe('saga orquestrada (US-F4-10): comandos via outbox, linha do tempo e compensacoes', () => {
    const envelope = <T extends { numeroOS: string }>(type: string, data: T, producer: 'execucao-service' | 'billing-service' = 'execucao-service') =>
      criarEnvelope({ type, data, producer, correlationId: data.numeroOS });
    const comandosDe = async (numero: string) =>
      (await prisma.outbox.findMany({ where: { correlationId: numero, NOT: { type: { startsWith: 'os.' } } }, orderBy: { criadaEm: 'asc' } })).map((r) => r.type);
    const outboxDe = (numero: string) => prisma.outbox.findMany({ where: { correlationId: numero, type: { startsWith: 'os.' } }, orderBy: { criadaEm: 'asc' } });
    const saga = async (numero: string) => {
      const res = await http().get(`/ordens-servico/numero/${numero}/saga`).set('Authorization', `Bearer ${tokens.atendente}`);
      expect(res.status).toBe(200);
      return res.body;
    };
    const ITENS = [
      { tipo: 'SERVICO', referenciaId: 'srv-1', nome: 'Troca de pastilha', quantidade: 1, precoUnitario: '200.00' },
      { tipo: 'PRODUTO', referenciaId: 'prd-1', nome: 'Pastilha', quantidade: 2, precoUnitario: '50.00', servicoId: 'srv-1' },
    ];
    /** Caminho feliz ate AGUARDAR_PAGAMENTO so com os handlers (como os eventos SQS chegam). */
    const ateAguardarPagamento = async (numero: string) => {
      await moduleRef.get(ExecucaoEnfileiradaHandler).handle(envelope('execucao.enfileirada', { numeroOS: numero, posicaoFila: 1 }));
      await moduleRef.get(ExecucaoDiagnosticoConcluidoHandler).handle(envelope('execucao.diagnostico-concluido', { numeroOS: numero, mecanicoId: mecanicoUserId, diagnostico: 'Pastilhas gastas', itens: ITENS }));
      await moduleRef.get(BillingOrcamentoGeradoHandler).handle(envelope('billing.orcamento-gerado', { numeroOS: numero, orcamentoId: 'orc-1', total: '300.00', validoAte: new Date().toISOString() }, 'billing-service'));
      await moduleRef.get(BillingOrcamentoAprovadoHandler).handle(envelope('billing.orcamento-aprovado', { numeroOS: numero, orcamentoId: 'orc-1', cobrancaId: 'cob-1', linkPagamento: 'https://mp.test/pay' }, 'billing-service'));
    };

    it('abrir a OS inicia a saga: passo ENFILEIRAR_EXECUCAO e comando execucao.enfileirar no outbox', async () => {
      const os = await createOs();
      expect(await comandosDe(os.numero)).toEqual(['execucao.enfileirar']);
      const cmd = await prisma.outbox.findFirst({ where: { correlationId: os.numero, type: 'execucao.enfileirar' } });
      expect((cmd!.envelope as any).data).toEqual({ numeroOS: os.numero, veiculoId, descricaoProblema: 'Cliente relata barulho ao frenar' });
      const s = await saga(os.numero);
      expect(s).toMatchObject({ passo: PassoSaga.ENFILEIRAR_EXECUCAO, status: StatusSaga.EM_ANDAMENTO, compensacoes: [] });
      expect(s.historico[0]).toMatchObject({ evento: 'os.aberta', resultado: 'avancou' });
    });

    it('caminho feliz: cada evento avanca um passo, muda a OS e envia o comando seguinte', async () => {
      const os = await createOs();
      await ateAguardarPagamento(os.numero);
      let s = await saga(os.numero);
      expect(s.passo).toBe(PassoSaga.AGUARDAR_PAGAMENTO);
      expect(s.prazoPagamento).toBeTruthy();
      expect((await http().get(`/ordens-servico/numero/${os.numero}/status`)).body).toMatchObject({ status: StatusOS.AGUARDANDO_PAGAMENTO, valorTotal: 300 });
      expect(await comandosDe(os.numero)).toEqual(['execucao.enfileirar', 'billing.gerar-orcamento']);
      const gerar = await prisma.outbox.findFirst({ where: { correlationId: os.numero, type: 'billing.gerar-orcamento' } });
      expect((gerar!.envelope as any)).toMatchObject({ producer: 'os-service', data: { numeroOS: os.numero, clienteId, itens: ITENS } });
      expect((gerar!.envelope as any).causationId).toBeDefined();

      await moduleRef.get(BillingPagamentoAprovadoHandler).handle(envelope('billing.pagamento-aprovado', { numeroOS: os.numero, cobrancaId: 'cob-1', orderId: 'mp-1', valor: '300.00' }, 'billing-service'));
      expect(await comandosDe(os.numero)).toEqual(['execucao.enfileirar', 'billing.gerar-orcamento', 'execucao.iniciar']);
      await moduleRef.get(ExecucaoIniciadaHandler).handle(envelope('execucao.iniciada', { numeroOS: os.numero }));
      await moduleRef.get(ExecucaoFinalizadaHandler).handle(envelope('execucao.finalizada', { numeroOS: os.numero, finalizadaEm: new Date().toISOString() }));
      s = await saga(os.numero);
      expect(s).toMatchObject({ passo: PassoSaga.CONCLUIDA, status: StatusSaga.CONCLUIDA });
      expect(s.historico.map((h: any) => h.resultado)).toEqual(['avancou', 'avancou', 'avancou', 'avancou', 'avancou', 'avancou', 'avancou', 'concluida']);
      expect((await http().get(`/ordens-servico/numero/${os.numero}/status`)).body.status).toBe(StatusOS.FINALIZADA);
    });

    it('evento duplicado/fora de ordem e ignorado pela saga sem tocar a OS (e fica no historico)', async () => {
      const os = await createOs();
      await moduleRef.get(ExecucaoEnfileiradaHandler).handle(envelope('execucao.enfileirada', { numeroOS: os.numero, posicaoFila: 1 }));
      await moduleRef.get(ExecucaoIniciadaHandler).handle(envelope('execucao.iniciada', { numeroOS: os.numero }));
      await moduleRef.get(ExecucaoEnfileiradaHandler).handle(envelope('execucao.enfileirada', { numeroOS: os.numero, posicaoFila: 1 }));
      const s = await saga(os.numero);
      expect(s.passo).toBe(PassoSaga.AGUARDAR_DIAGNOSTICO);
      expect(s.historico.slice(-2).map((h: any) => h.resultado)).toEqual(['ignorado', 'ignorado']);
      expect((await http().get(`/ordens-servico/numero/${os.numero}/status`)).body.status).toBe(StatusOS.EM_DIAGNOSTICO);
    });

    it('orcamento rejeitado: COMPENSANDO com execucao.liberar-reservas; confirmacao fecha em CANCELADA', async () => {
      const os = await createOs();
      await moduleRef.get(ExecucaoEnfileiradaHandler).handle(envelope('execucao.enfileirada', { numeroOS: os.numero, posicaoFila: 1 }));
      await moduleRef.get(ExecucaoDiagnosticoConcluidoHandler).handle(envelope('execucao.diagnostico-concluido', { numeroOS: os.numero, mecanicoId: mecanicoUserId, diagnostico: 'Pastilhas gastas', itens: ITENS }));
      await moduleRef.get(BillingOrcamentoGeradoHandler).handle(envelope('billing.orcamento-gerado', { numeroOS: os.numero, orcamentoId: 'orc-1', total: '300.00', validoAte: '' }, 'billing-service'));
      await moduleRef.get(BillingOrcamentoRejeitadoHandler).handle(envelope('billing.orcamento-rejeitado', { numeroOS: os.numero, orcamentoId: 'orc-1' }, 'billing-service'));
      let s = await saga(os.numero);
      expect(s.status).toBe(StatusSaga.COMPENSANDO);
      expect(s.compensacoes).toEqual([expect.objectContaining({ comando: 'execucao.liberar-reservas' })]);
      expect((await comandosDe(os.numero)).slice(-1)).toEqual(['execucao.liberar-reservas']);
      expect((await http().get(`/ordens-servico/numero/${os.numero}/status`)).body).toMatchObject({ status: StatusOS.CANCELADA, motivoCancelamento: MotivoCancelamento.ORCAMENTO_REJEITADO });
      await moduleRef.get(ExecucaoReservasLiberadasHandler).handle(envelope('execucao.reservas-liberadas', { numeroOS: os.numero }));
      s = await saga(os.numero);
      expect(s.status).toBe(StatusSaga.CANCELADA);
      expect(s.compensacoes[0].confirmadaEm).toBeTruthy();
    });

    it('cancelamento manual em AGUARDAR_PAGAMENTO compensa no Billing e na Execucao (ordem inversa)', async () => {
      const os = await createOs();
      await ateAguardarPagamento(os.numero);
      const res = await http().post(`/ordens-servico/${os.id}/cancelar`).set('Authorization', `Bearer ${tokens.atendente}`).send({});
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: StatusOS.CANCELADA, motivoCancelamento: MotivoCancelamento.OPERADOR });
      expect((await comandosDe(os.numero)).slice(-2)).toEqual(['billing.cancelar-orcamento', 'execucao.liberar-reservas']);
      let s = await saga(os.numero);
      expect(s.status).toBe(StatusSaga.COMPENSANDO);
      await moduleRef.get(BillingOrcamentoCanceladoHandler).handle(envelope('billing.orcamento-cancelado', { numeroOS: os.numero, orcamentoId: 'orc-1', estornado: false }, 'billing-service'));
      await moduleRef.get(ExecucaoReservasLiberadasHandler).handle(envelope('execucao.reservas-liberadas', { numeroOS: os.numero }));
      s = await saga(os.numero);
      expect(s.status).toBe(StatusSaga.CANCELADA);
      expect(s.compensacoes.every((c: any) => c.confirmadaEm)).toBe(true);
    });

    it('timeout de aprovacao: o relogio da saga compensa com TIMEOUT_APROVACAO', async () => {
      process.env.SAGA_TIMEOUT_APROVACAO_MS = '1';
      try {
        const os = await createOs();
        await moduleRef.get(ExecucaoEnfileiradaHandler).handle(envelope('execucao.enfileirada', { numeroOS: os.numero, posicaoFila: 1 }));
        await moduleRef.get(ExecucaoDiagnosticoConcluidoHandler).handle(envelope('execucao.diagnostico-concluido', { numeroOS: os.numero, mecanicoId: mecanicoUserId, diagnostico: 'Pastilhas gastas', itens: ITENS }));
        await moduleRef.get(BillingOrcamentoGeradoHandler).handle(envelope('billing.orcamento-gerado', { numeroOS: os.numero, orcamentoId: 'orc-1', total: '300.00', validoAte: '' }, 'billing-service'));
        const vencidas = await moduleRef.get(SagaTimeoutsService).varrer(new Date(Date.now() + 1000));
        expect(vencidas).toBeGreaterThanOrEqual(1);
        expect((await http().get(`/ordens-servico/numero/${os.numero}/status`)).body).toMatchObject({ status: StatusOS.CANCELADA, motivoCancelamento: MotivoCancelamento.TIMEOUT_APROVACAO });
        const s = await saga(os.numero);
        expect(s.status).toBe(StatusSaga.COMPENSANDO);
        expect(s.compensacoes.map((c: any) => c.comando)).toEqual(['billing.cancelar-orcamento', 'execucao.liberar-reservas']);
      } finally {
        delete process.env.SAGA_TIMEOUT_APROVACAO_MS;
      }
    });

    it('pagamento recusado e timeout de pagamento compensam no Billing e na Execucao', async () => {
      const os = await createOs();
      await ateAguardarPagamento(os.numero);
      await moduleRef.get(BillingPagamentoRecusadoHandler).handle(envelope('billing.pagamento-recusado', { numeroOS: os.numero, cobrancaId: 'cob-1', motivo: 'cartao recusado' }, 'billing-service'));
      expect((await http().get(`/ordens-servico/numero/${os.numero}/status`)).body).toMatchObject({ status: StatusOS.CANCELADA, motivoCancelamento: MotivoCancelamento.PAGAMENTO_RECUSADO });
      expect((await comandosDe(os.numero)).slice(-2)).toEqual(['billing.cancelar-orcamento', 'execucao.liberar-reservas']);

      process.env.SAGA_TIMEOUT_PAGAMENTO_MS = '1';
      try {
        const os2 = await createOs();
        await ateAguardarPagamento(os2.numero);
        await moduleRef.get(SagaTimeoutsService).varrer(new Date(Date.now() + 1000));
        expect((await http().get(`/ordens-servico/numero/${os2.numero}/status`)).body).toMatchObject({ status: StatusOS.CANCELADA, motivoCancelamento: MotivoCancelamento.TIMEOUT_PAGAMENTO });
      } finally {
        delete process.env.SAGA_TIMEOUT_PAGAMENTO_MS;
      }
    });

    it('falha ao iniciar a execucao apos o pagamento -> estorno + liberar reservas (FALHA_INICIO_EXECUCAO)', async () => {
      const os = await createOs();
      await ateAguardarPagamento(os.numero);
      await moduleRef.get(BillingPagamentoAprovadoHandler).handle(envelope('billing.pagamento-aprovado', { numeroOS: os.numero, cobrancaId: 'cob-1', orderId: 'mp-1', valor: '300.00' }, 'billing-service'));
      await moduleRef.get(ExecucaoRecusadaHandler).handle(envelope('execucao.recusada', { numeroOS: os.numero, motivo: 'estoque insuficiente' }));
      expect((await http().get(`/ordens-servico/numero/${os.numero}/status`)).body).toMatchObject({ status: StatusOS.CANCELADA, motivoCancelamento: MotivoCancelamento.FALHA_INICIO_EXECUCAO });
      expect((await comandosDe(os.numero)).slice(-3)).toEqual(['execucao.iniciar', 'billing.cancelar-orcamento', 'execucao.liberar-reservas']);
    });

    it.each([
      ['ENFILEIRAR_EXECUCAO', 0, ['execucao.liberar-reservas']],
      ['AGUARDAR_DIAGNOSTICO', 1, ['execucao.liberar-reservas']],
      ['GERAR_ORCAMENTO', 2, ['billing.cancelar-orcamento', 'execucao.liberar-reservas']],
      ['AGUARDAR_APROVACAO', 3, ['billing.cancelar-orcamento', 'execucao.liberar-reservas']],
    ] as const)('cancelamento manual em %s envia %j', async (_passo, eventos, esperados) => {
      const os = await createOs();
      const seq = [
        () => moduleRef.get(ExecucaoEnfileiradaHandler).handle(envelope('execucao.enfileirada', { numeroOS: os.numero, posicaoFila: 1 })),
        () => moduleRef.get(ExecucaoDiagnosticoConcluidoHandler).handle(envelope('execucao.diagnostico-concluido', { numeroOS: os.numero, mecanicoId: mecanicoUserId, diagnostico: 'Pastilhas gastas', itens: ITENS })),
        () => moduleRef.get(BillingOrcamentoGeradoHandler).handle(envelope('billing.orcamento-gerado', { numeroOS: os.numero, orcamentoId: 'o', total: '300.00', validoAte: '' }, 'billing-service')),
      ];
      for (let i = 0; i < eventos; i++) await seq[i]();
      const res = await http().post(`/ordens-servico/${os.id}/cancelar`).set('Authorization', `Bearer ${tokens.atendente}`).send({});
      expect(res.status).toBe(200);
      expect((await comandosDe(os.numero)).slice(-esperados.length)).toEqual([...esperados]);
      expect((await saga(os.numero)).status).toBe(StatusSaga.COMPENSANDO);
    });

    it('diagnostico sem itens (viola o contrato) e ignorado: OS e saga seguem esperando', async () => {
      const os = await createOs();
      await moduleRef.get(ExecucaoEnfileiradaHandler).handle(envelope('execucao.enfileirada', { numeroOS: os.numero, posicaoFila: 1 }));
      await moduleRef.get(ExecucaoDiagnosticoConcluidoHandler).handle(envelope('execucao.diagnostico-concluido', { numeroOS: os.numero, mecanicoId: mecanicoUserId, diagnostico: 'Pastilhas gastas', itens: [] }));
      const s = await saga(os.numero);
      expect(s.passo).toBe(PassoSaga.AGUARDAR_DIAGNOSTICO);
      expect(s.historico[s.historico.length - 1]).toMatchObject({ resultado: 'ignorado' });
      expect((await comandosDe(os.numero))).toEqual(['execucao.enfileirar']);
    });

    it('OS sem saga e adotada no passo equivalente ao status (com diagnostico = aguardando orcamento)', async () => {
      const os = await createOs();
      await moduleRef.get(ExecucaoEnfileiradaHandler).handle(envelope('execucao.enfileirada', { numeroOS: os.numero, posicaoFila: 1 }));
      await moduleRef.get(ExecucaoDiagnosticoConcluidoHandler).handle(envelope('execucao.diagnostico-concluido', { numeroOS: os.numero, mecanicoId: mecanicoUserId, diagnostico: 'Pastilhas gastas', itens: ITENS }));
      await prisma.sagaOS.deleteMany({ where: { numero: os.numero } });
      await moduleRef.get(BillingOrcamentoGeradoHandler).handle(envelope('billing.orcamento-gerado', { numeroOS: os.numero, orcamentoId: 'o', total: '300.00', validoAte: '' }, 'billing-service'));
      const s = await saga(os.numero);
      expect(s.historico[0]).toMatchObject({ evento: 'saga.adotada' });
      expect(s.passo).toBe(PassoSaga.AGUARDAR_APROVACAO);
      expect((await http().get(`/ordens-servico/numero/${os.numero}/status`)).body.status).toBe(StatusOS.AGUARDANDO_APROVACAO);
    });

    it('transacao unica: se a saga nao puder ser gravada, a OS e o outbox voltam atras', async () => {
      const os = await createOs();
      const repo = moduleRef.get(PrismaSagaRepository);
      const spy = jest.spyOn(repo, 'save').mockRejectedValueOnce(new Error('falha simulada ao gravar a saga'));
      try {
        await expect(moduleRef.get(ExecucaoEnfileiradaHandler).handle(envelope('execucao.enfileirada', { numeroOS: os.numero, posicaoFila: 1 }))).rejects.toThrow('falha simulada');
      } finally {
        spy.mockRestore();
      }
      expect((await http().get(`/ordens-servico/numero/${os.numero}/status`)).body.status).toBe(StatusOS.RECEBIDA);
      expect((await saga(os.numero)).passo).toBe(PassoSaga.ENFILEIRAR_EXECUCAO);
      expect((await outboxDe(os.numero)).map((r) => r.type)).toEqual(['os.aberta']);
      // reentrega funciona normalmente depois
      await moduleRef.get(ExecucaoEnfileiradaHandler).handle(envelope('execucao.enfileirada', { numeroOS: os.numero, posicaoFila: 1 }));
      expect((await http().get(`/ordens-servico/numero/${os.numero}/status`)).body.status).toBe(StatusOS.EM_DIAGNOSTICO);
    });

    it('GET numero/:numero/saga: 404 sem saga; CLIENTE nao acessa', async () => {
      expect((await http().get('/ordens-servico/numero/OS-NAO-EXISTE/saga').set('Authorization', `Bearer ${tokens.admin}`)).status).toBe(404);
      const os = await createOs();
      expect((await http().get(`/ordens-servico/numero/${os.numero}/saga`).set('Authorization', `Bearer ${tokens.cliente}`)).status).toBe(403);
    });
  });
});
