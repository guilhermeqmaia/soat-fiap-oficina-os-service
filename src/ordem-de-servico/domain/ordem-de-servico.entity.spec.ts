import { OrdemDeServico } from './ordem-de-servico.entity';
import { StatusOS } from './value-objects/status-os.vo';
import { MotivoCancelamento } from './value-objects/motivo-cancelamento';
import { ItemServicoOS } from './value-objects/item-servico-os.vo';
import { ItemProdutoOS } from './value-objects/item-produto-os.vo';
import { InvalidDescriptionError } from './errors/invalid-description.error';
import { InvalidStatusTransitionError } from './errors/invalid-status-transition.error';
import { ServicoAlreadyAddedError } from './errors/servico-already-added.error';

const nova = () => OrdemDeServico.create({ clienteId: 'cli-1', veiculoId: 'vei-1', descricaoInicial: 'Barulho ao frenar' });
const itens = () => [
  new ItemServicoOS('srv-1', 'Troca de pastilha', 1, 200, [new ItemProdutoOS('prd-1', 'Pastilha', 2, 50)]),
  new ItemServicoOS('srv-2', 'Alinhamento', 1, 80),
];
const diagnostico = (os: OrdemDeServico) => os.registrarDiagnostico({ diagnostico: 'Pastilhas gastas', mecanicoId: 'mec-1', itens: itens() });
/** Percorre o caminho feliz ate o status pedido. */
const ate = (status: StatusOS): OrdemDeServico => {
  const os = nova();
  const passos: Array<[StatusOS, () => void]> = [
    [StatusOS.EM_DIAGNOSTICO, () => os.iniciarDiagnostico()],
    [StatusOS.AGUARDANDO_APROVACAO, () => { diagnostico(os); os.aguardarAprovacao(); }],
    [StatusOS.EM_EXECUCAO, () => os.iniciarExecucao()],
    [StatusOS.AGUARDANDO_PAGAMENTO, () => os.aguardarPagamento()],
    [StatusOS.FINALIZADA, () => os.finalizar()],
    [StatusOS.ENTREGUE, () => os.entregar()],
  ];
  for (const [s, fn] of passos) { if (os.status === status) break; fn(); }
  return os;
};

describe('OrdemDeServico (OS Service, Fase 4)', () => {
  describe('abertura', () => {
    it('nasce RECEBIDA, sem itens, sem mecanico, com numero OS-<ano>-...', () => {
      const os = nova();
      expect(os.status).toBe(StatusOS.RECEBIDA);
      expect(os.itensServico).toHaveLength(0);
      expect(os.mecanicoId).toBeNull();
      expect(os.motivoCancelamento).toBeNull();
      expect(os.numero).toMatch(/^OS-\d{4}-\d{10}-\d{4}$/);
      expect(os.valorTotal()).toBe(0);
      expect(os.version).toBe(0);
    });
    it('valida a descricao inicial (5..500)', () => {
      expect(() => OrdemDeServico.create({ clienteId: 'c', veiculoId: 'v', descricaoInicial: 'abc' })).toThrow(InvalidDescriptionError);
      expect(() => OrdemDeServico.create({ clienteId: 'c', veiculoId: 'v', descricaoInicial: 'x'.repeat(501) })).toThrow(InvalidDescriptionError);
    });
  });

  describe('caminho feliz dirigido por eventos', () => {
    it('RECEBIDA -> EM_DIAGNOSTICO -> AGUARDANDO_APROVACAO -> EM_EXECUCAO -> AGUARDANDO_PAGAMENTO -> FINALIZADA -> ENTREGUE', () => {
      const os = ate(StatusOS.ENTREGUE);
      expect(os.status).toBe(StatusOS.ENTREGUE);
      expect(os.mecanicoId).toBe('mec-1');
      expect(os.diagnostico).toBe('Pastilhas gastas');
    });
    it('diagnostico grava o snapshot: nomes, precos congelados e totais', () => {
      const os = ate(StatusOS.AGUARDANDO_APROVACAO);
      expect(os.itensServico.map((i) => i.nome)).toEqual(['Troca de pastilha', 'Alinhamento']);
      expect(os.valorTotalServicos()).toBe(280);
      expect(os.valorTotalProdutos()).toBe(100);
      expect(os.valorTotal()).toBe(380);
      expect(os.itensServico[0].produtos[0].nome).toBe('Pastilha');
    });
    it('reaplicar o diagnostico substitui o snapshot (idempotente)', () => {
      const os = nova(); os.iniciarDiagnostico(); diagnostico(os); diagnostico(os);
      expect(os.itensServico).toHaveLength(2);
    });
  });

  describe('invariantes', () => {
    it('diagnostico exige EM_DIAGNOSTICO, texto 5..1000 e servicos unicos', () => {
      const os = nova();
      expect(() => diagnostico(os)).toThrow(InvalidStatusTransitionError);
      os.iniciarDiagnostico();
      expect(() => os.registrarDiagnostico({ diagnostico: 'abc', mecanicoId: 'm', itens: [] })).toThrow(InvalidDescriptionError);
      expect(() => os.registrarDiagnostico({ diagnostico: 'x'.repeat(1001), mecanicoId: 'm', itens: [] })).toThrow(InvalidDescriptionError);
      const dup = [new ItemServicoOS('srv-1', 'A', 1, 10), new ItemServicoOS('srv-1', 'B', 1, 10)];
      expect(() => os.registrarDiagnostico({ diagnostico: 'Pastilhas gastas', mecanicoId: 'm', itens: dup })).toThrow(ServicoAlreadyAddedError);
    });
    it.each([
      ['iniciarDiagnostico', StatusOS.EM_DIAGNOSTICO],
      ['aguardarAprovacao', StatusOS.AGUARDANDO_APROVACAO],
      ['iniciarExecucao', StatusOS.EM_EXECUCAO],
      ['aguardarPagamento', StatusOS.AGUARDANDO_PAGAMENTO],
      ['finalizar', StatusOS.FINALIZADA],
      ['entregar', StatusOS.ENTREGUE],
    ] as const)('%s rejeita quando o status atual nao e o esperado', (metodo, alvo) => {
      // uma OS ja no status alvo nao pode repetir a transicao
      const os = ate(alvo);
      expect(() => (os as any)[metodo]()).toThrow(InvalidStatusTransitionError);
    });
    it('nao pula etapas (RECEBIDA -> EM_EXECUCAO direto e invalido)', () => {
      expect(() => nova().iniciarExecucao()).toThrow(InvalidStatusTransitionError);
    });
  });

  describe('cancelamento (compensacao da saga)', () => {
    it.each([StatusOS.RECEBIDA, StatusOS.EM_DIAGNOSTICO, StatusOS.AGUARDANDO_APROVACAO])(
      'pode cancelar a partir de %s e guarda o motivo',
      (status) => {
        const os = ate(status);
        expect(os.podeSerCancelada()).toBe(true);
        os.cancelar(MotivoCancelamento.ORCAMENTO_REJEITADO);
        expect(os.status).toBe(StatusOS.CANCELADA);
        expect(os.motivoCancelamento).toBe(MotivoCancelamento.ORCAMENTO_REJEITADO);
      },
    );
    // AGUARDANDO_PAGAMENTO vem depois do servico executado (ADR-0012): sem rollback
    it.each([StatusOS.EM_EXECUCAO, StatusOS.AGUARDANDO_PAGAMENTO, StatusOS.FINALIZADA, StatusOS.ENTREGUE])('nao cancela a partir de %s', (status) => {
      const os = ate(status);
      expect(os.podeSerCancelada()).toBe(false);
      expect(() => os.cancelar(MotivoCancelamento.OPERADOR)).toThrow(InvalidStatusTransitionError);
    });
    it('OS cancelada nao avanca', () => {
      const os = nova(); os.cancelar(MotivoCancelamento.OPERADOR);
      expect(() => os.iniciarDiagnostico()).toThrow(InvalidStatusTransitionError);
      expect(() => os.cancelar(MotivoCancelamento.OPERADOR)).toThrow(InvalidStatusTransitionError);
    });
  });

  describe('reconstitute', () => {
    it('restaura todos os campos, inclusive motivo e itens', () => {
      const os = OrdemDeServico.reconstitute({
        id: 'id-1', numero: 'OS-2026-1', clienteId: 'c', veiculoId: 'v', mecanicoId: 'm', descricaoInicial: 'Barulho', diagnostico: 'd',
        status: StatusOS.CANCELADA, motivoCancelamento: MotivoCancelamento.TIMEOUT_APROVACAO, createdAt: new Date(), updatedAt: new Date(), itensServico: itens(),
      });
      expect(os.id).toBe('id-1'); expect(os.status).toBe(StatusOS.CANCELADA); expect(os.motivoCancelamento).toBe(MotivoCancelamento.TIMEOUT_APROVACAO); expect(os.itensServico).toHaveLength(2);
    });
  });
});
