import { Logger } from '@nestjs/common';
import { EnviarNotificacaoUseCase, EnviarNotificacaoInput } from './enviar-notificacao.use-case';
import { Notificacao } from '../../domain/notificacao.entity';
import { CanalNotificacao } from '../../domain/value-objects/canal-notificacao.vo';
import { StatusNotificacao } from '../../domain/value-objects/status-notificacao.vo';
import { TipoNotificacao } from '../../domain/value-objects/tipo-notificacao.vo';

const input: EnviarNotificacaoInput = {
  clienteId: 'cliente-1',
  ordemDeServicoId: 'os-1',
  numeroOS: 'OS-2026-000001',
  eventoId: 'env-1',
  tipo: TipoNotificacao.ORCAMENTO_PRONTO,
  destinatario: 'cliente@email.com',
  assunto: 'Orcamento pronto',
  mensagem: 'Mensagem do orcamento',
};

/** Gateway em memoria que reproduz o indice unico (eventoId, tipo, canal). */
function fakeGateway() {
  const linhas: Notificacao[] = [];
  let seq = 0;
  const chave = (n: Notificacao) => `${n.eventoId}|${n.tipo}|${n.canal}`;
  const comId = (n: Notificacao, id: string) =>
    Notificacao.reconstitute({
      id, clienteId: n.clienteId, ordemDeServicoId: n.ordemDeServicoId, numeroOS: n.numeroOS, eventoId: n.eventoId,
      linkPagamento: n.linkPagamento, tipo: n.tipo, canal: n.canal, destinatario: n.destinatario, assunto: n.assunto,
      mensagem: n.mensagem, status: n.status, erro: n.erro, enviadaEm: n.enviadaEm, createdAt: new Date(),
    });
  return {
    linhas,
    reservar: jest.fn(async (n: Notificacao) => {
      if (n.eventoId && linhas.some((l) => chave(l) === chave(n))) return null;
      const salva = comId(n, `n-${++seq}`);
      linhas.push(salva);
      return salva;
    }),
    atualizarResultado: jest.fn(async (n: Notificacao) => n),
  };
}

describe('EnviarNotificacaoUseCase', () => {
  let gateway: ReturnType<typeof fakeGateway>;
  let emailNotificador: any;
  let webhookNotificador: any;
  let useCase: EnviarNotificacaoUseCase;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    gateway = fakeGateway();
    emailNotificador = { canal: CanalNotificacao.EMAIL, enviar: jest.fn().mockResolvedValue(undefined) };
    webhookNotificador = { canal: CanalNotificacao.WEBHOOK, enviar: jest.fn().mockResolvedValue(undefined) };
    useCase = new EnviarNotificacaoUseCase(gateway as any, [emailNotificador]);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('construtor', () => {
    it('lanca erro quando dois notificadores compartilham o mesmo canal', () => {
      const dupA = { canal: CanalNotificacao.EMAIL, enviar: jest.fn() };
      const dupB = { canal: CanalNotificacao.EMAIL, enviar: jest.fn() };

      expect(() => new EnviarNotificacaoUseCase(gateway as any, [dupA, dupB])).toThrow(/duplicados/);
    });
  });

  describe('execute', () => {
    it('reserva (PENDENTE), envia pelo notificador do canal e grava ENVIADA', async () => {
      const [result] = await useCase.execute(input);

      expect(gateway.reservar).toHaveBeenCalledTimes(1);
      expect(gateway.reservar.mock.calls[0][0].status).toBe(StatusNotificacao.PENDENTE);
      expect(emailNotificador.enviar).toHaveBeenCalledWith({
        destinatario: input.destinatario,
        assunto: input.assunto,
        corpo: input.mensagem,
        contexto: {
          ordemId: input.ordemDeServicoId,
          clienteId: input.clienteId,
          numeroOS: 'OS-2026-000001',
          linkPagamento: undefined,
          eventoId: 'env-1',
          statusAnterior: undefined,
          statusAtual: undefined,
          timestamp: undefined,
          tipoNotificacao: input.tipo,
        },
      });
      expect(gateway.atualizarResultado).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(StatusNotificacao.ENVIADA);
      expect(result.enviadaEm).not.toBeNull();
      expect(result.canal).toBe(CanalNotificacao.EMAIL);
      expect(result).toMatchObject({ numeroOS: 'OS-2026-000001', eventoId: 'env-1' });
    });

    it('PAGAMENTO_PENDENTE: link de pagamento vai para a notificacao e para o notificador', async () => {
      const [result] = await useCase.execute({
        ...input,
        tipo: TipoNotificacao.PAGAMENTO_PENDENTE,
        linkPagamento: 'https://mp.test/pay/mp-1',
      });

      expect(result.linkPagamento).toBe('https://mp.test/pay/mp-1');
      expect(emailNotificador.enviar.mock.calls[0][0].contexto.linkPagamento).toBe('https://mp.test/pay/mp-1');
    });

    it('canal WEBHOOK: notificacao gravada como WEBHOOK (canal real), nao EMAIL', async () => {
      const uc = new EnviarNotificacaoUseCase(gateway as any, [webhookNotificador]);

      const [result] = await uc.execute({ ...input, tipo: TipoNotificacao.PAGAMENTO_APROVADO });

      expect(result.canal).toBe(CanalNotificacao.WEBHOOK);
      expect(webhookNotificador.enviar).toHaveBeenCalledTimes(1);
      expect(gateway.linhas[0].canal).toBe(CanalNotificacao.WEBHOOK);
    });

    it('sem canal no input: envia por todos os notificadores registrados, uma linha por canal', async () => {
      const uc = new EnviarNotificacaoUseCase(gateway as any, [emailNotificador, webhookNotificador]);

      const r = await uc.execute(input);

      expect(r.map((n) => n.canal).sort()).toEqual([CanalNotificacao.EMAIL, CanalNotificacao.WEBHOOK]);
    });

    it('canal explicito: so aquele canal', async () => {
      const uc = new EnviarNotificacaoUseCase(gateway as any, [emailNotificador, webhookNotificador]);

      const r = await uc.execute({ ...input, canal: CanalNotificacao.WEBHOOK });

      expect(r).toHaveLength(1);
      expect(emailNotificador.enviar).not.toHaveBeenCalled();
    });

    it('idempotencia: o mesmo fato (eventoId + tipo) duas vezes = um unico envio; o 2o vira "ja notificado"', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn');

      const primeiro = await useCase.execute(input);
      const segundo = await useCase.execute(input);

      expect(primeiro).toHaveLength(1);
      expect(segundo).toEqual([]);
      expect(emailNotificador.enviar).toHaveBeenCalledTimes(1);
      expect(gateway.linhas).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ja notificado'));
    });

    it('mesmo eventoId com tipo diferente (pagamento aprovado + OS finalizada) gera duas notificacoes', async () => {
      await useCase.execute({ ...input, tipo: TipoNotificacao.PAGAMENTO_APROVADO });
      await useCase.execute({ ...input, tipo: TipoNotificacao.OS_FINALIZADA });

      expect(emailNotificador.enviar).toHaveBeenCalledTimes(2);
    });

    it('sem eventoId nao ha deduplicacao (comportamento da Fase 2)', async () => {
      await useCase.execute({ ...input, eventoId: undefined });
      await useCase.execute({ ...input, eventoId: undefined });

      expect(emailNotificador.enviar).toHaveBeenCalledTimes(2);
    });

    it('cliente sem e-mail: pula o canal EMAIL sem gravar nada', async () => {
      const r = await useCase.execute({ ...input, destinatario: null });

      expect(r).toEqual([]);
      expect(gateway.reservar).not.toHaveBeenCalled();
      expect(emailNotificador.enviar).not.toHaveBeenCalled();
    });

    it('cliente sem e-mail: o WEBHOOK ainda notifica (destinatario = clienteId)', async () => {
      const uc = new EnviarNotificacaoUseCase(gateway as any, [webhookNotificador]);

      const [r] = await uc.execute({ ...input, destinatario: null });

      expect(r.destinatario).toBe('cliente-1');
      expect(webhookNotificador.enviar).toHaveBeenCalledTimes(1);
    });

    it('grava FALHOU quando o notificador lanca erro (sem propagar)', async () => {
      emailNotificador.enviar.mockRejectedValueOnce(new Error('SMTP down'));

      const [result] = await useCase.execute(input);

      expect(result.status).toBe(StatusNotificacao.FALHOU);
      expect(result.erro).toBe('SMTP down');
      expect(result.enviadaEm).toBeNull();
    });

    it('erro nao-Error do notificador vira texto', async () => {
      emailNotificador.enviar.mockRejectedValueOnce('boom');

      const [result] = await useCase.execute(input);

      expect(result.erro).toBe('boom');
    });

    it('grava FALHOU quando nao ha notificador para o canal pedido', async () => {
      const uc = new EnviarNotificacaoUseCase(gateway as any, []);

      const [result] = await uc.execute({ ...input, canal: CanalNotificacao.EMAIL });

      expect(emailNotificador.enviar).not.toHaveBeenCalled();
      expect(result.status).toBe(StatusNotificacao.FALHOU);
      expect(result.erro).toContain('Nenhum notificador');
    });
  });
});
