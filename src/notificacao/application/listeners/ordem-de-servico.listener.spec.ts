import { Test, TestingModule } from '@nestjs/testing';
import {
  CLIENTE_REPOSITORY,
  ClienteRepository,
} from '../../../cliente/domain/cliente.repository';
import { PUBLIC_BASE_URL } from '../ports/public-base-url';
import { Cliente } from '../../../cliente/domain/cliente.entity';
import {
  DadosMarcoOS,
  MarcoOrdemDeServicoEvent,
  TipoMarcoOS,
} from '../../../shared/domain/events/marco-ordem-de-servico.event';
import { OsStatusAlteradoEvent } from '../../../ordem-de-servico/domain/events/os-status-alterado.event';
import { StatusOS } from '../../../ordem-de-servico/domain/value-objects/status-os.vo';
import { TipoNotificacao } from '../../domain/value-objects/tipo-notificacao.vo';
import { EnviarNotificacaoUseCase } from '../use-cases/enviar-notificacao.use-case';
import {
  OrdemDeServicoNotificacaoListener,
  STATUS_COM_NOTIFICACAO_DEDICADA,
} from './ordem-de-servico.listener';

describe('OrdemDeServicoNotificacaoListener', () => {
  let listener: OrdemDeServicoNotificacaoListener;
  let enviarNotificacao: jest.Mocked<Pick<EnviarNotificacaoUseCase, 'execute'>>;
  let clienteRepository: jest.Mocked<Pick<ClienteRepository, 'findById'>>;

  const clienteComEmail = Cliente.reconstitute({
    id: 'cliente-1',
    nome: 'Joao da Silva',
    cpfCnpj: '52998224725',
    telefone: '11999998888',
    email: 'joao@email.com',
  });

  const clienteSemEmail = Cliente.reconstitute({
    id: 'cliente-2',
    nome: 'Maria sem email',
    cpfCnpj: '52998224725',
    telefone: '11999998888',
    email: null,
  });

  const marco = (type: TipoMarcoOS, dados: DadosMarcoOS = {}, eventoId = `env-${type}`) =>
    new MarcoOrdemDeServicoEvent(type, 'OS-2026-001', 'os-id-1', 'cliente-1', eventoId, dados);

  beforeEach(async () => {
    jest.clearAllMocks();

    enviarNotificacao = { execute: jest.fn().mockResolvedValue([]) };
    clienteRepository = { findById: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdemDeServicoNotificacaoListener,
        { provide: EnviarNotificacaoUseCase, useValue: enviarNotificacao },
        { provide: CLIENTE_REPOSITORY, useValue: clienteRepository },
        { provide: PUBLIC_BASE_URL, useValue: 'http://localhost:3000' },
      ],
    }).compile();

    listener = module.get(OrdemDeServicoNotificacaoListener);
  });

  const ultimoEnvio = () => enviarNotificacao.execute.mock.calls[0][0];

  describe('onMarco (US-F4-12)', () => {
    it.each<[TipoMarcoOS, TipoNotificacao]>([
      ['billing.orcamento-gerado', TipoNotificacao.ORCAMENTO_PRONTO],
      ['billing.orcamento-aprovado', TipoNotificacao.ORCAMENTO_APROVADO],
      ['billing.cobranca-criada', TipoNotificacao.PAGAMENTO_PENDENTE],
      ['billing.pagamento-aprovado', TipoNotificacao.PAGAMENTO_APROVADO],
      ['billing.pagamento-recusado', TipoNotificacao.PAGAMENTO_RECUSADO],
      ['os.finalizada', TipoNotificacao.OS_FINALIZADA],
      ['os.cancelada', TipoNotificacao.OS_CANCELADA],
    ])('%s -> %s com numeroOS, eventoId e sem canal fixo (canal real do provider)', async (type, tipo) => {
      clienteRepository.findById.mockResolvedValueOnce(clienteComEmail);

      await listener.onMarco(marco(type));

      expect(enviarNotificacao.execute).toHaveBeenCalledTimes(1);
      const arg = ultimoEnvio();
      expect(arg).toMatchObject({
        clienteId: 'cliente-1',
        ordemDeServicoId: 'os-id-1',
        numeroOS: 'OS-2026-001',
        eventoId: `env-${type}`,
        tipo,
        destinatario: 'joao@email.com',
      });
      expect(arg.canal).toBeUndefined();
      expect(arg.mensagem).toContain('Ola Joao da Silva');
      expect(arg.mensagem).toContain('OS-2026-001');
      expect(arg.assunto).toContain('OS-2026-001');
    });

    it('ORCAMENTO_PRONTO traz diagnostico, total em BRL e instrucao de aprovar/rejeitar', async () => {
      clienteRepository.findById.mockResolvedValueOnce(clienteComEmail);

      await listener.onMarco(marco('billing.orcamento-gerado', { total: 450.5, diagnostico: 'Trocar pastilhas de freio' }));

      const arg = ultimoEnvio();
      expect(arg.assunto).toBe('Orcamento da OS OS-2026-001 pronto para aprovacao');
      expect(arg.mensagem).toContain('Diagnostico: Trocar pastilhas de freio');
      expect(arg.mensagem).toMatch(/R\$\s?450,50/);
      expect(arg.mensagem).toContain('aprovar ou rejeitar');
      expect(arg.linkPagamento).toBeUndefined();
    });

    it('ORCAMENTO_APROVADO nao tem link de pagamento (a cobranca vem depois da execucao)', async () => {
      clienteRepository.findById.mockResolvedValueOnce(clienteComEmail);

      await listener.onMarco(marco('billing.orcamento-aprovado'));

      expect(ultimoEnvio().linkPagamento).toBeUndefined();
      expect(ultimoEnvio().mensagem).toContain('link de pagamento');
    });

    it('PAGAMENTO_PENDENTE carrega o link de pagamento na mensagem e no campo linkPagamento', async () => {
      clienteRepository.findById.mockResolvedValueOnce(clienteComEmail);

      await listener.onMarco(
        marco('billing.cobranca-criada', { linkPagamento: 'https://mp.test/pay/mp-1', valor: '300.00' }, 'billing.cobranca-criada:OS-2026-001:mp-1'),
      );

      const arg = ultimoEnvio();
      expect(arg.linkPagamento).toBe('https://mp.test/pay/mp-1');
      expect(arg.eventoId).toBe('billing.cobranca-criada:OS-2026-001:mp-1');
      expect(arg.assunto).toBe('OS OS-2026-001 concluida - pague para retirar o veiculo');
      expect(arg.mensagem).toContain('realize o pagamento: https://mp.test/pay/mp-1');
      expect(arg.mensagem).toMatch(/R\$\s?300,00/);
    });

    it('PAGAMENTO_PENDENTE sem link aponta para o portal', async () => {
      clienteRepository.findById.mockResolvedValueOnce(clienteComEmail);

      await listener.onMarco(marco('billing.cobranca-criada'));

      expect(ultimoEnvio().mensagem).toContain('pelo portal do cliente');
    });

    it('PAGAMENTO_APROVADO informa o valor quando presente', async () => {
      clienteRepository.findById.mockResolvedValueOnce(clienteComEmail);

      await listener.onMarco(marco('billing.pagamento-aprovado', { valor: '300.00' }));

      expect(ultimoEnvio().mensagem).toMatch(/Confirmamos o pagamento .*R\$\s?300,00/);
    });

    it('PAGAMENTO_RECUSADO informa o motivo e, com link, o link para tentar de novo', async () => {
      clienteRepository.findById.mockResolvedValueOnce(clienteComEmail);
      await listener.onMarco(marco('billing.pagamento-recusado', { motivo: 'cc_rejected_insufficient_amount' }));
      expect(ultimoEnvio().mensagem).toContain('recusado (motivo: cc_rejected_insufficient_amount)');
      expect(ultimoEnvio().mensagem).toContain('link de pagamento recebido');

      enviarNotificacao.execute.mockClear();
      clienteRepository.findById.mockResolvedValueOnce(clienteComEmail);
      await listener.onMarco(marco('billing.pagamento-recusado', { linkPagamento: 'https://mp.test/pay/mp-2' }));
      expect(ultimoEnvio().mensagem).toContain('Tente novamente pelo link: https://mp.test/pay/mp-2');
      expect(ultimoEnvio().linkPagamento).toBe('https://mp.test/pay/mp-2');
    });

    it('OS_FINALIZADA traz o link de acompanhamento', async () => {
      clienteRepository.findById.mockResolvedValueOnce(clienteComEmail);

      await listener.onMarco(marco('os.finalizada', {}, 'os.finalizada:OS-2026-001'));

      expect(ultimoEnvio().mensagem).toContain('GET http://localhost:3000/ordens-servico/numero/OS-2026-001/status');
      expect(ultimoEnvio().assunto).toBe('OS OS-2026-001 finalizada - veiculo pronto para retirada');
    });

    it('OS_CANCELADA informa o motivo', async () => {
      clienteRepository.findById.mockResolvedValueOnce(clienteComEmail);

      await listener.onMarco(marco('os.cancelada', { motivo: 'ORCAMENTO_REJEITADO' }, 'os.cancelada:OS-2026-001'));

      expect(ultimoEnvio().mensagem).toContain('foi cancelada (motivo: ORCAMENTO_REJEITADO)');
    });

    it('cliente sem e-mail: repassa destinatario null (o canal EMAIL e pulado; o WEBHOOK ainda notifica)', async () => {
      clienteRepository.findById.mockResolvedValueOnce(clienteSemEmail);

      await listener.onMarco(marco('billing.pagamento-aprovado'));

      expect(ultimoEnvio().destinatario).toBeNull();
    });

    it('cliente inexistente: nao envia', async () => {
      clienteRepository.findById.mockResolvedValueOnce(null);

      await listener.onMarco(marco('os.finalizada'));

      expect(enviarNotificacao.execute).not.toHaveBeenCalled();
    });

    it('engole erros para nao bloquear o fluxo principal', async () => {
      clienteRepository.findById.mockResolvedValueOnce(clienteComEmail);
      enviarNotificacao.execute.mockRejectedValueOnce(new Error('db down'));

      await expect(listener.onMarco(marco('os.finalizada'))).resolves.toBeUndefined();
    });
  });

  describe('onOsStatusAlterado', () => {
    const event = new OsStatusAlteradoEvent(
      'os-id-3',
      'OS-2026-003',
      'cliente-1',
      StatusOS.AGUARDANDO_APROVACAO,
      StatusOS.EM_EXECUCAO,
      new Date('2026-06-25T10:00:00.000Z'),
    );

    it('envia notificacao com status anterior, status atual, timestamp e id (OS, status)', async () => {
      clienteRepository.findById.mockResolvedValueOnce(clienteComEmail);

      await listener.onOsStatusAlterado(event);

      expect(enviarNotificacao.execute).toHaveBeenCalledTimes(1);
      expect(enviarNotificacao.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          clienteId: 'cliente-1',
          ordemDeServicoId: 'os-id-3',
          numeroOS: 'OS-2026-003',
          eventoId: 'os.status:OS-2026-003:EM_EXECUCAO',
          tipo: TipoNotificacao.STATUS_OS_ALTERADO,
          destinatario: 'joao@email.com',
          statusAnterior: StatusOS.AGUARDANDO_APROVACAO,
          statusAtual: StatusOS.EM_EXECUCAO,
          timestamp: new Date('2026-06-25T10:00:00.000Z'),
        }),
      );
    });

    it('todos os status com notificacao propria estao na lista de supressao', () => {
      expect([...STATUS_COM_NOTIFICACAO_DEDICADA].sort()).toEqual(
        [StatusOS.AGUARDANDO_APROVACAO, StatusOS.AGUARDANDO_PAGAMENTO, StatusOS.CANCELADA, StatusOS.FINALIZADA].sort(),
      );
    });

    it.each([StatusOS.AGUARDANDO_APROVACAO, StatusOS.AGUARDANDO_PAGAMENTO, StatusOS.FINALIZADA, StatusOS.CANCELADA])(
      'nao envia notificacao generica quando o status %s ja possui notificacao dedicada',
      async (statusAtual) => {
        const eventoDedicado = new OsStatusAlteradoEvent(
          'os-id-4',
          'OS-2026-004',
          'cliente-1',
          StatusOS.EM_EXECUCAO,
          statusAtual,
          new Date('2026-06-25T10:00:00.000Z'),
        );

        await listener.onOsStatusAlterado(eventoDedicado);

        expect(enviarNotificacao.execute).not.toHaveBeenCalled();
        expect(clienteRepository.findById).not.toHaveBeenCalled();
      },
    );

    it('usa clienteId como destinatario quando cliente nao tem email', async () => {
      clienteRepository.findById.mockResolvedValueOnce(clienteSemEmail);

      await listener.onOsStatusAlterado(event);

      const arg = enviarNotificacao.execute.mock.calls[0][0];
      expect(arg.destinatario).toBe('cliente-1');
    });

    it('engole erros para nao bloquear fluxo principal', async () => {
      clienteRepository.findById.mockRejectedValueOnce(new Error('db down'));

      await expect(listener.onOsStatusAlterado(event)).resolves.toBeUndefined();
    });
  });
});
