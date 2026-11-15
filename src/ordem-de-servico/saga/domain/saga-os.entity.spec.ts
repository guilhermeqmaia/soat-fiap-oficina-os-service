import { MotivoCancelamento } from '../../domain/value-objects/motivo-cancelamento';
import { StatusOS } from '../../domain/value-objects/status-os.vo';
import { PassoSaga, SagaOS, StatusSaga, EventoSaga, PASSOS_COM_FALHA_SIMULAVEL } from './saga-os.entity';

const T0 = new Date('2026-10-21T10:00:00Z');
const em = (min: number) => new Date(T0.getTime() + min * 60_000);
const PRAZOS = { aprovacaoMs: 60 * 60_000, pagamentoMs: 30 * 60_000 }; // 1h / 30min
const ev = (type: string, data: Record<string, any> = {}, id = `env-${type}`): EventoSaga => ({ type, id, data: { numeroOS: 'OS-1', ...data } });
const ITENS = [
  { tipo: 'SERVICO', referenciaId: 's1', nome: 'Troca', quantidade: 1, precoUnitario: '200.00' },
  { tipo: 'PRODUTO', referenciaId: 'p1', nome: 'Pastilha', quantidade: 2, precoUnitario: '50.00', servicoId: 's1' },
];
const nova = () => SagaOS.iniciar({ numero: 'OS-1', clienteId: 'cli-1', veiculoId: 'vei-1', descricaoProblema: 'Barulho' }, T0);
/** Caminho feliz ate o passo pedido (consome comandos a cada passo). */
const ate = (passo: PassoSaga) => {
  const s = nova(); s.consumirComandos();
  const seq: Array<[PassoSaga, EventoSaga]> = [
    [PassoSaga.AGUARDAR_DIAGNOSTICO, ev('execucao.enfileirada', { posicaoFila: 1 })],
    [PassoSaga.GERAR_ORCAMENTO, ev('execucao.diagnostico-concluido', { mecanicoId: 'm', diagnostico: 'Pastilhas', itens: ITENS })],
    [PassoSaga.AGUARDAR_APROVACAO, ev('billing.orcamento-gerado', { orcamentoId: 'o1', total: '300.00' })],
    [PassoSaga.INICIAR_EXECUCAO, ev('billing.orcamento-aprovado', { orcamentoId: 'o1' })],
    [PassoSaga.AGUARDAR_FINALIZACAO, ev('execucao.iniciada')],
    [PassoSaga.COBRAR, ev('execucao.finalizada', { finalizadaEm: T0.toISOString() })],
    [PassoSaga.AGUARDAR_PAGAMENTO, ev('billing.cobranca-criada', { orderId: 'mp-1', linkPagamento: 'https://mp', valor: '300.00' })],
    [PassoSaga.CONCLUIDA, ev('billing.pagamento-aprovado', { orderId: 'mp-1', valor: '300.00' })],
  ];
  let i = 1;
  for (const [alvo, e] of seq) {
    if (s.passo === passo) break;
    const r = s.aplicar(e, em(i++), PRAZOS);
    expect(r.aplicado).toBe(true);
    expect(s.passo).toBe(alvo);
    s.consumirComandos();
  }
  return s;
};

describe('SagaOS — maquina de estados pura (RFC-0005)', () => {
  it('iniciar: passo ENFILEIRAR_EXECUCAO, comando execucao.enfileirar com os dados da OS', () => {
    const s = nova();
    expect(s.passo).toBe(PassoSaga.ENFILEIRAR_EXECUCAO);
    expect(s.status).toBe(StatusSaga.EM_ANDAMENTO);
    expect(s.comandosPendentes).toEqual([{ type: 'execucao.enfileirar', data: { numeroOS: 'OS-1', veiculoId: 'vei-1', descricaoProblema: 'Barulho' } }]);
    expect(s.consumirComandos()).toHaveLength(1);
    expect(s.comandosPendentes).toHaveLength(0);
    expect(s.historico[0]).toMatchObject({ evento: 'os.aberta', resultado: 'avancou' });
  });

  it('caminho feliz: 9 eventos, transicoes da OS e comandos certos em cada passo (cobranca depois da execucao)', () => {
    const s = nova(); s.consumirComandos();
    let r = s.aplicar(ev('execucao.enfileirada', { posicaoFila: 1 }), em(1), PRAZOS);
    expect(r.transicaoOS).toEqual({ tipo: 'iniciarDiagnostico' }); expect(r.comandos).toEqual([]);
    r = s.aplicar(ev('execucao.diagnostico-concluido', { mecanicoId: 'm', diagnostico: 'Pastilhas', itens: ITENS }), em(2), PRAZOS);
    expect(r.transicaoOS).toEqual({ tipo: 'registrarDiagnostico' });
    expect(r.comandos).toEqual([{ type: 'billing.gerar-orcamento', data: { numeroOS: 'OS-1', clienteId: 'cli-1', itens: ITENS }, causationId: 'env-execucao.diagnostico-concluido' }]);
    s.consumirComandos();
    r = s.aplicar(ev('billing.orcamento-gerado', { total: '300.00' }), em(3), PRAZOS);
    expect(r.transicaoOS).toEqual({ tipo: 'aguardarAprovacao' });
    expect(s.prazoAprovacao).toEqual(new Date(em(3).getTime() + PRAZOS.aprovacaoMs));
    // aprovado: a OS NAO muda (continua AGUARDANDO_APROVACAO ate a Execucao confirmar); sem cobranca
    r = s.aplicar(ev('billing.orcamento-aprovado', { orcamentoId: 'o1' }), em(4), PRAZOS);
    expect(r.transicaoOS).toBeUndefined();
    expect(r.comandos).toEqual([{ type: 'execucao.iniciar', data: { numeroOS: 'OS-1' }, causationId: 'env-billing.orcamento-aprovado' }]);
    expect(s.passo).toBe(PassoSaga.INICIAR_EXECUCAO);
    expect(s.prazoAprovacao).toBeNull(); expect(s.prazoPagamento).toBeNull(); s.consumirComandos();
    r = s.aplicar(ev('execucao.iniciada'), em(5), PRAZOS);
    expect(r.transicaoOS).toEqual({ tipo: 'iniciarExecucao' });
    // executado: OS -> AGUARDANDO_PAGAMENTO e o Billing recebe `billing.cobrar`
    r = s.aplicar(ev('execucao.finalizada'), em(6), PRAZOS);
    expect(r.transicaoOS).toEqual({ tipo: 'aguardarPagamento' });
    expect(r.comandos).toEqual([{ type: 'billing.cobrar', data: { numeroOS: 'OS-1' }, causationId: 'env-execucao.finalizada' }]);
    expect(s.passo).toBe(PassoSaga.COBRAR); s.consumirComandos();
    // cobranca criada: so o prazo (metrica/alerta), sem transicao da OS
    r = s.aplicar(ev('billing.cobranca-criada', { orderId: 'mp-1', linkPagamento: 'https://mp', valor: '300.00' }), em(7), PRAZOS);
    expect(r.transicaoOS).toBeUndefined(); expect(r.comandos).toEqual([]);
    expect(s.passo).toBe(PassoSaga.AGUARDAR_PAGAMENTO);
    expect(s.prazoPagamento).toEqual(new Date(em(7).getTime() + PRAZOS.pagamentoMs));
    r = s.aplicar(ev('billing.pagamento-aprovado', { orderId: 'mp-1', valor: '300.00' }), em(8), PRAZOS);
    expect(r.transicaoOS).toEqual({ tipo: 'finalizar' });
    expect(s.prazoPagamento).toBeNull();
    expect(s.passo).toBe(PassoSaga.CONCLUIDA); expect(s.status).toBe(StatusSaga.CONCLUIDA); expect(s.encerrada).toBe(true);
    expect(s.historico.map((h) => h.resultado)).toEqual(['avancou', 'avancou', 'avancou', 'avancou', 'avancou', 'avancou', 'avancou', 'avancou', 'concluida']);
  });

  it('duplicado e fora de ordem sao ignorados com registro, sem transicao nem comando', () => {
    const s = ate(PassoSaga.AGUARDAR_APROVACAO);
    const dup = s.aplicar(ev('execucao.enfileirada'), em(10), PRAZOS);
    expect(dup).toMatchObject({ aplicado: false, motivo: 'duplicado (passo ja concluido)', comandos: [] });
    const fora = s.aplicar(ev('execucao.iniciada'), em(11), PRAZOS);
    expect(fora.aplicado).toBe(false); expect(fora.motivo).toContain('fora de ordem');
    expect(s.passo).toBe(PassoSaga.AGUARDAR_APROVACAO);
    expect(s.historico.slice(-2).map((h) => h.resultado)).toEqual(['ignorado', 'ignorado']);
    expect(s.aplicar(ev('evento.estranho'), em(12), PRAZOS).motivo).toBe('evento desconhecido');
  });

  describe('compensacoes (recuperacao para tras, ordem inversa)', () => {
    it('enfileirar recusado -> CANCELADA direto, sem comandos', () => {
      const s = nova(); s.consumirComandos();
      const r = s.aplicar(ev('execucao.recusada', { motivo: 'veiculo em execucao' }), em(1), PRAZOS);
      expect(r.transicaoOS).toEqual({ tipo: 'cancelar', motivo: MotivoCancelamento.EXECUCAO_RECUSADA });
      expect(r.comandos).toEqual([]); expect(s.status).toBe(StatusSaga.CANCELADA); expect(s.compensacoes).toEqual([]);
    });
    it('orcamento rejeitado -> liberar reservas; CANCELADA quando a Execucao confirma', () => {
      const s = ate(PassoSaga.AGUARDAR_APROVACAO);
      const r = s.aplicar(ev('billing.orcamento-rejeitado', { orcamentoId: 'o1' }), em(10), PRAZOS);
      expect(r.transicaoOS).toEqual({ tipo: 'cancelar', motivo: MotivoCancelamento.ORCAMENTO_REJEITADO });
      expect(r.comandos.map((c) => c.type)).toEqual(['execucao.liberar-reservas']);
      expect(s.status).toBe(StatusSaga.COMPENSANDO); expect(s.prazoAprovacao).toBeNull();
      // em compensacao, eventos de negocio sao ignorados
      expect(s.aplicar(ev('billing.orcamento-aprovado'), em(11), PRAZOS).aplicado).toBe(false);
      const c = s.aplicar(ev('execucao.reservas-liberadas'), em(12), PRAZOS);
      expect(c.aplicado).toBe(true); expect(s.status).toBe(StatusSaga.CANCELADA);
      expect(s.compensacoes[0].confirmadaEm).toBe(em(12).toISOString());
      // confirmacao repetida e ignorada
      expect(s.aplicar(ev('execucao.reservas-liberadas'), em(13), PRAZOS).aplicado).toBe(false);
    });
    it('pagamento recusado (pos-execucao) NAO compensa: registra pagamento-pendente e continua em AGUARDAR_PAGAMENTO', () => {
      const s = ate(PassoSaga.AGUARDAR_PAGAMENTO);
      const r = s.aplicar(ev('billing.pagamento-recusado', { orderId: 'mp-1', motivo: 'cartao recusado' }), em(10), PRAZOS);
      expect(r).toEqual({ aplicado: true, comandos: [] });
      expect(r.transicaoOS).toBeUndefined();
      expect(s.status).toBe(StatusSaga.EM_ANDAMENTO); expect(s.passo).toBe(PassoSaga.AGUARDAR_PAGAMENTO);
      expect(s.compensacoes).toEqual([]);
      expect(s.historico[s.historico.length - 1]).toMatchObject({ resultado: 'pagamento-pendente', detalhe: 'pagamento recusado: cartao recusado' });
      // uma nova cobranca (reprocessamento) renova o prazo sem mudar o passo; o pagamento depois conclui
      const nova = s.aplicar(ev('billing.cobranca-criada', { orderId: 'mp-2', linkPagamento: 'https://mp/2', valor: '300.00' }), em(20), PRAZOS);
      expect(nova).toEqual({ aplicado: true, comandos: [] });
      expect(s.passo).toBe(PassoSaga.AGUARDAR_PAGAMENTO);
      expect(s.prazoPagamento).toEqual(new Date(em(20).getTime() + PRAZOS.pagamentoMs));
      expect(s.historico[s.historico.length - 1].detalhe).toContain('mp-2');
      expect(s.aplicar(ev('billing.pagamento-aprovado', { orderId: 'mp-2' }), em(21), PRAZOS).transicaoOS).toEqual({ tipo: 'finalizar' });
      expect(s.status).toBe(StatusSaga.CONCLUIDA);
    });
    it('falha ao iniciar execucao (aprovado, nada pago) -> cancelar orcamento + liberar reservas, sem estorno', () => {
      const s = ate(PassoSaga.INICIAR_EXECUCAO);
      const r = s.aplicar(ev('execucao.recusada', { motivo: 'estoque insuficiente' }), em(10), PRAZOS);
      expect(r.transicaoOS).toEqual({ tipo: 'cancelar', motivo: MotivoCancelamento.FALHA_INICIO_EXECUCAO });
      expect(r.comandos.map((c) => c.type)).toEqual(['billing.cancelar-orcamento', 'execucao.liberar-reservas']);
      expect(r.comandos[0].data).toEqual({ numeroOS: 'OS-1', motivo: MotivoCancelamento.FALHA_INICIO_EXECUCAO });
    });
    it('execucao.finalizada e pagamento depois da execucao nunca cancelam a OS', () => {
      const s = ate(PassoSaga.AGUARDAR_FINALIZACAO);
      expect(s.aplicar(ev('execucao.recusada', { motivo: 'x' }), em(10), PRAZOS).aplicado).toBe(false);
      expect(s.aplicar(ev('billing.pagamento-recusado'), em(11), PRAZOS).aplicado).toBe(false);
      expect(s.status).toBe(StatusSaga.EM_ANDAMENTO);
    });
    it('execucao.recusada noutro passo e ignorada', () => {
      const s = ate(PassoSaga.AGUARDAR_APROVACAO);
      expect(s.aplicar(ev('execucao.recusada', { motivo: 'x' }), em(10), PRAZOS).aplicado).toBe(false);
    });
  });

  describe('timeouts', () => {
    it('aprovacao vencida -> TIMEOUT_APROVACAO com as duas compensacoes', () => {
      const s = ate(PassoSaga.AGUARDAR_APROVACAO);
      expect(s.aplicar(ev('saga.timeout'), new Date(s.prazoAprovacao!.getTime() - 1), PRAZOS).aplicado).toBe(false);
      const r = s.aplicar(ev('saga.timeout', {}, undefined as any), s.prazoAprovacao!, PRAZOS);
      expect(r.transicaoOS).toEqual({ tipo: 'cancelar', motivo: MotivoCancelamento.TIMEOUT_APROVACAO });
      expect(r.comandos.map((c) => c.type)).toEqual(['billing.cancelar-orcamento', 'execucao.liberar-reservas']);
    });
    it('pagamento vencido (pos-execucao) nao cancela: registra o atraso uma vez e limpa o prazo', () => {
      const s = ate(PassoSaga.AGUARDAR_PAGAMENTO);
      expect(s.aplicar(ev('saga.timeout'), new Date(s.prazoPagamento!.getTime() - 1), PRAZOS).aplicado).toBe(false);
      expect(s.prazoPagamento).not.toBeNull();
      const r = s.aplicar(ev('saga.timeout'), new Date(s.prazoPagamento!.getTime() + 1), PRAZOS);
      expect(r).toMatchObject({ aplicado: false, comandos: [] });
      expect(r.transicaoOS).toBeUndefined();
      expect(r.motivo).toContain('pagamento em atraso');
      expect(s.status).toBe(StatusSaga.EM_ANDAMENTO); expect(s.passo).toBe(PassoSaga.AGUARDAR_PAGAMENTO);
      expect(s.prazoPagamento).toBeNull(); // o relogio nao reencontra a saga; a gauge de paradas alerta
      expect(s.compensacoes).toEqual([]);
      expect(ate(PassoSaga.AGUARDAR_DIAGNOSTICO).aplicar(ev('saga.timeout'), em(999), PRAZOS).aplicado).toBe(false);
    });
  });

  describe('cancelamento manual (atendente)', () => {
    it.each([
      [PassoSaga.ENFILEIRAR_EXECUCAO, ['execucao.liberar-reservas']],
      [PassoSaga.AGUARDAR_DIAGNOSTICO, ['execucao.liberar-reservas']],
      [PassoSaga.GERAR_ORCAMENTO, ['billing.cancelar-orcamento', 'execucao.liberar-reservas']],
      [PassoSaga.AGUARDAR_APROVACAO, ['billing.cancelar-orcamento', 'execucao.liberar-reservas']],
      [PassoSaga.INICIAR_EXECUCAO, ['billing.cancelar-orcamento', 'execucao.liberar-reservas']],
    ])('no passo %s envia %j', (passo, comandos) => {
      const s = ate(passo as PassoSaga);
      const r = s.aplicar(ev('os.cancelamento-manual', { motivo: MotivoCancelamento.OPERADOR }), em(50), PRAZOS);
      expect(r.aplicado).toBe(true);
      expect(r.transicaoOS).toEqual({ tipo: 'cancelar', motivo: MotivoCancelamento.OPERADOR });
      expect(r.comandos.map((c) => c.type)).toEqual(comandos);
      expect(s.status).toBe(comandos.length ? StatusSaga.COMPENSANDO : StatusSaga.CANCELADA);
    });
    it.each([PassoSaga.AGUARDAR_FINALIZACAO, PassoSaga.COBRAR, PassoSaga.AGUARDAR_PAGAMENTO])('depois de a execucao comecar (%s) e rejeitado', (passo) => {
      const s = ate(passo);
      const r = s.aplicar(ev('os.cancelamento-manual'), em(50), PRAZOS);
      expect(r).toMatchObject({ aplicado: false, rejeitado: true });
      expect(s.status).toBe(StatusSaga.EM_ANDAMENTO); expect(s.passo).toBe(passo);
    });
    it('motivo explicito (ex.: TIMEOUT_APROVACAO via API) e respeitado', () => {
      const s = ate(PassoSaga.AGUARDAR_APROVACAO);
      expect(s.aplicar(ev('os.cancelamento-manual', { motivo: MotivoCancelamento.TIMEOUT_APROVACAO }), em(50), PRAZOS).transicaoOS).toEqual({ tipo: 'cancelar', motivo: MotivoCancelamento.TIMEOUT_APROVACAO });
    });
  });

  it('diagnostico sem itens (viola o contrato) e ignorado e a saga continua esperando', () => {
    const s = ate(PassoSaga.AGUARDAR_DIAGNOSTICO);
    const r = s.aplicar(ev('execucao.diagnostico-concluido', { mecanicoId: 'm', diagnostico: 'x', itens: [] }), em(5), PRAZOS);
    expect(r.aplicado).toBe(false); expect(r.motivo).toContain('sem itens'); expect(s.passo).toBe(PassoSaga.AGUARDAR_DIAGNOSTICO); expect(s.comandosPendentes).toEqual([]);
  });

  it('passoDesde acompanha o passo; historico tem teto de 200 entradas', () => {
    const s = nova(); s.consumirComandos();
    expect(s.passoDesde).toEqual(T0);
    s.aplicar(ev('execucao.enfileirada'), em(7), PRAZOS);
    expect(s.passoDesde).toEqual(em(7));
    for (let i = 0; i < 250; i++) s.aplicar(ev('execucao.iniciada'), em(8 + i), PRAZOS);
    expect(s.historico).toHaveLength(200);
    expect(s.historico[0].resultado).toBe('ignorado');
  });

  it('timeout num passo sem prazo limpa prazos obsoletos', () => {
    const s = SagaOS.reconstitute({
      numero: 'OS-1', clienteId: 'c', veiculoId: 'v', descricaoProblema: 'd', passo: PassoSaga.AGUARDAR_FINALIZACAO, status: StatusSaga.EM_ANDAMENTO,
      historico: [], compensacoes: [], prazoAprovacao: T0, prazoPagamento: T0, version: 0,
    });
    expect(s.aplicar(ev('saga.timeout'), em(99), PRAZOS).aplicado).toBe(false);
    expect(s.prazoAprovacao).toBeNull(); expect(s.prazoPagamento).toBeNull();
  });

  it('saga encerrada ignora tudo', () => {
    const s = ate(PassoSaga.CONCLUIDA);
    expect(s.aplicar(ev('execucao.finalizada'), em(99), PRAZOS)).toMatchObject({ aplicado: false, motivo: 'saga CONCLUIDA' });
    expect(s.aplicar(ev('os.cancelamento-manual'), em(99), PRAZOS).aplicado).toBe(false);
  });

  it('adotar: OS anterior a saga entra no passo equivalente ao status', () => {
    const base = { numero: 'OS-9', clienteId: 'c', veiculoId: 'v', descricaoProblema: 'd' };
    expect(SagaOS.adotar({ ...base, statusOS: StatusOS.AGUARDANDO_PAGAMENTO }, T0)).toMatchObject({ passo: PassoSaga.AGUARDAR_PAGAMENTO, status: StatusSaga.EM_ANDAMENTO });
    expect(SagaOS.adotar({ ...base, statusOS: StatusOS.AGUARDANDO_APROVACAO }, T0).passo).toBe(PassoSaga.AGUARDAR_APROVACAO);
    expect(SagaOS.adotar({ ...base, statusOS: StatusOS.ENTREGUE }, T0)).toMatchObject({ passo: PassoSaga.CONCLUIDA, status: StatusSaga.CONCLUIDA });
    expect(SagaOS.adotar({ ...base, statusOS: StatusOS.CANCELADA }, T0).status).toBe(StatusSaga.CANCELADA);
    const adotada = SagaOS.adotar({ ...base, statusOS: StatusOS.EM_EXECUCAO }, T0);
    expect(adotada.comandosPendentes).toEqual([]);
    // EM_DIAGNOSTICO com diagnostico gravado = aguardando orcamento; RECEBIDA reenvia o enfileirar
    expect(SagaOS.adotar({ ...base, statusOS: StatusOS.EM_DIAGNOSTICO, temDiagnostico: true }, T0).passo).toBe(PassoSaga.GERAR_ORCAMENTO);
    expect(SagaOS.adotar({ ...base, statusOS: StatusOS.EM_DIAGNOSTICO }, T0).passo).toBe(PassoSaga.AGUARDAR_DIAGNOSTICO);
    expect(SagaOS.adotar({ ...base, statusOS: StatusOS.RECEBIDA }, T0).comandosPendentes.map((c) => c.type)).toEqual(['execucao.enfileirar']);
    const r = adotada.aplicar(ev('execucao.finalizada', { numeroOS: 'OS-9' }), em(1), PRAZOS);
    expect(r.transicaoOS).toEqual({ tipo: 'aguardarPagamento' });
    expect(r.comandos.map((c) => c.type)).toEqual(['billing.cobrar']);
    expect(SagaOS.adotar({ ...base, statusOS: StatusOS.AGUARDANDO_PAGAMENTO }, T0).aplicar(ev('billing.pagamento-aprovado', { numeroOS: 'OS-9' }), em(1), PRAZOS).transicaoOS).toEqual({ tipo: 'finalizar' });
  });

  it('reconstitute preserva tudo (inclusive compensacoes pendentes)', () => {
    const s = ate(PassoSaga.INICIAR_EXECUCAO);
    s.aplicar(ev('execucao.recusada', { motivo: 'estoque' }), em(10), PRAZOS);
    const r = SagaOS.reconstitute({
      id: 'id', numero: s.numero, clienteId: s.clienteId, veiculoId: s.veiculoId, descricaoProblema: s.descricaoProblema, passo: s.passo, status: s.status,
      historico: [...s.historico], compensacoes: [...s.compensacoes], prazoAprovacao: null, prazoPagamento: null, version: 4,
    });
    expect(r.version).toBe(4); expect(r.status).toBe(StatusSaga.COMPENSANDO); expect(r.comandosPendentes).toEqual([]);
    r.aplicar(ev('billing.orcamento-cancelado'), em(11), PRAZOS); r.aplicar(ev('execucao.reservas-liberadas'), em(12), PRAZOS);
    expect(r.status).toBe(StatusSaga.CANCELADA);
  });

  describe('injecao de falhas (demo, US-F4-11)', () => {
    it.each([
      [PassoSaga.ENFILEIRAR_EXECUCAO, 'execucao.enfileirada', 'execucao.recusada', MotivoCancelamento.EXECUCAO_RECUSADA],
      [PassoSaga.AGUARDAR_APROVACAO, 'billing.orcamento-aprovado', 'billing.orcamento-rejeitado', MotivoCancelamento.ORCAMENTO_REJEITADO],
      [PassoSaga.INICIAR_EXECUCAO, 'execucao.iniciada', 'execucao.recusada', MotivoCancelamento.FALHA_INICIO_EXECUCAO],
    ] as const)('em %s troca %s por %s uma unica vez (compensa)', (passo, sucesso, falha, motivo) => {
      const s = SagaOS.iniciar({ numero: 'OS-1', clienteId: 'cli-1', veiculoId: 'vei-1', descricaoProblema: 'Barulho', falhaSimulada: passo }, T0);
      s.consumirComandos();
      // avanca ate o passo marcado sem disparar a simulacao em passos anteriores
      const seq: Array<[PassoSaga, EventoSaga]> = [
        [PassoSaga.AGUARDAR_DIAGNOSTICO, ev('execucao.enfileirada')],
        [PassoSaga.GERAR_ORCAMENTO, ev('execucao.diagnostico-concluido', { mecanicoId: 'm', diagnostico: 'Pastilhas', itens: ITENS })],
        [PassoSaga.AGUARDAR_APROVACAO, ev('billing.orcamento-gerado', { total: '300.00' })],
        [PassoSaga.INICIAR_EXECUCAO, ev('billing.orcamento-aprovado')],
      ];
      let i = 1;
      for (const [alvo, e] of seq) {
        if (s.passo === passo) break;
        const efetivo = s.simularFalha(e, em(i));
        expect(efetivo).toBe(e);
        s.aplicar(efetivo, em(i++), PRAZOS); s.consumirComandos();
        expect(s.passo).toBe(alvo);
      }
      expect(s.falhaSimulada).toBe(passo);
      const original = ev(sucesso);
      const trocado = s.simularFalha(original, em(50));
      expect(trocado.type).toBe(falha);
      expect(trocado.data.motivo).toContain('falha simulada');
      expect(s.falhaSimulada).toBeNull();
      expect(s.historico[s.historico.length - 1].resultado).toBe('falha-simulada');
      const r = s.aplicar(trocado, em(51), PRAZOS);
      expect(r.transicaoOS).toEqual({ tipo: 'cancelar', motivo });
      // segunda vez nao troca mais
      expect(s.simularFalha(ev(sucesso), em(52))).toEqual(ev(sucesso));
    });
    it('em AGUARDAR_PAGAMENTO troca pagamento-aprovado por recusado: pagamento pendente, sem compensacao', () => {
      const s = SagaOS.iniciar({ numero: 'OS-1', clienteId: 'cli-1', veiculoId: 'vei-1', descricaoProblema: 'Barulho', falhaSimulada: PassoSaga.AGUARDAR_PAGAMENTO }, T0);
      s.consumirComandos();
      const seq = [
        ev('execucao.enfileirada'), ev('execucao.diagnostico-concluido', { mecanicoId: 'm', diagnostico: 'Pastilhas', itens: ITENS }), ev('billing.orcamento-gerado', { total: '300.00' }),
        ev('billing.orcamento-aprovado'), ev('execucao.iniciada'), ev('execucao.finalizada'), ev('billing.cobranca-criada', { orderId: 'mp-1' }),
      ];
      seq.forEach((e, i) => { expect(s.simularFalha(e, em(i))).toBe(e); s.aplicar(e, em(i), PRAZOS); s.consumirComandos(); });
      expect(s.passo).toBe(PassoSaga.AGUARDAR_PAGAMENTO);
      const trocado = s.simularFalha(ev('billing.pagamento-aprovado'), em(50));
      expect(trocado.type).toBe('billing.pagamento-recusado');
      const r = s.aplicar(trocado, em(51), PRAZOS);
      expect(r).toEqual({ aplicado: true, comandos: [] });
      expect(s.status).toBe(StatusSaga.EM_ANDAMENTO);
      expect(s.historico[s.historico.length - 1].resultado).toBe('pagamento-pendente');
      expect(s.simularFalha(ev('billing.pagamento-aprovado'), em(52)).type).toBe('billing.pagamento-aprovado');
    });
    it('sem falhaSimulada ou em passo diferente, o evento passa intacto', () => {
      const s = SagaOS.iniciar({ numero: 'OS-1', clienteId: 'c', veiculoId: 'v', descricaoProblema: 'd', falhaSimulada: PassoSaga.AGUARDAR_PAGAMENTO }, T0);
      const e = ev('execucao.enfileirada');
      expect(s.simularFalha(e)).toBe(e);
      expect(nova().simularFalha(e)).toBe(e);
      expect(PASSOS_COM_FALHA_SIMULAVEL).toHaveLength(4);
    });
  });

  describe('reprocessar (retomada manual)', () => {
    it('reenvia o comando do passo atual: enfileirar, gerar-orcamento (com itens), iniciar, cobrar', () => {
      const s0 = nova(); s0.consumirComandos();
      expect(s0.reprocessar({}, em(1)).map((c) => c.type)).toEqual(['execucao.enfileirar']);
      expect(s0.historico[s0.historico.length - 1]).toMatchObject({ evento: 'saga.reprocessar', resultado: 'reprocessada' });
      const s2 = ate(PassoSaga.GERAR_ORCAMENTO);
      expect(s2.reprocessar({}, em(1))).toEqual([]);
      const itens = [{ tipo: 'SERVICO' as const, referenciaId: 's1', nome: 'Troca', quantidade: 1, precoUnitario: '200.00' }];
      expect(s2.reprocessar({ itens }, em(2))[0]).toMatchObject({ type: 'billing.gerar-orcamento', data: { numeroOS: 'OS-1', clienteId: 'cli-1', itens } });
      const s5 = ate(PassoSaga.INICIAR_EXECUCAO);
      expect(s5.reprocessar({}, em(1)).map((c) => c.type)).toEqual(['execucao.iniciar']);
      // cobranca perdida ou pagamento recusado/em atraso: nova cobranca
      expect(ate(PassoSaga.COBRAR).reprocessar({}, em(1))).toEqual([{ type: 'billing.cobrar', data: { numeroOS: 'OS-1' } }]);
      expect(ate(PassoSaga.AGUARDAR_PAGAMENTO).reprocessar({}, em(1)).map((c) => c.type)).toEqual(['billing.cobrar']);
    });
    it('passos que aguardam cliente/participante e sagas encerradas nao reenviam nada', () => {
      for (const passo of [PassoSaga.AGUARDAR_DIAGNOSTICO, PassoSaga.AGUARDAR_APROVACAO, PassoSaga.AGUARDAR_FINALIZACAO, PassoSaga.CONCLUIDA]) {
        const s = ate(passo);
        expect(s.reprocessar({}, em(1))).toEqual([]);
        expect(s.historico[s.historico.length - 1].detalhe).toContain('nada a reenviar');
      }
    });
    it('em COMPENSANDO reenvia so as compensacoes nao confirmadas', () => {
      const s = ate(PassoSaga.INICIAR_EXECUCAO);
      s.aplicar(ev('execucao.recusada', { motivo: 'estoque' }), em(10), PRAZOS); s.consumirComandos();
      s.aplicar(ev('billing.orcamento-cancelado'), em(11), PRAZOS);
      const re = s.reprocessar({}, em(12));
      expect(re.map((c) => c.type)).toEqual(['execucao.liberar-reservas']);
      expect(s.compensacoes.find((c) => c.comando === 'execucao.liberar-reservas')?.enviadaEm).toBe(em(12).toISOString());
      expect(s.status).toBe(StatusSaga.COMPENSANDO);
    });
  });

  describe('registrarChamadaFalhou (US-F4-18)', () => {
    const nova = () => SagaOS.iniciar({ numero: 'OS-CF', clienteId: 'c', veiculoId: 'v', descricaoProblema: 'd' });

    it('registra comando, tentativas e motivo sem mudar passo/status; aguardandoReprocessamento ate a proxima entrada', () => {
      const s = nova();
      s.consumirComandos();
      const agora = new Date('2026-11-10T12:00:00Z');
      s.registrarChamadaFalhou('execucao.enfileirar', { erro: 'POST ... respondeu 503 (tentativa 3/3)', status: 503, tentativas: 3 }, agora);
      expect(s.historico[s.historico.length - 1]).toEqual({
        em: agora.toISOString(),
        passo: PassoSaga.ENFILEIRAR_EXECUCAO,
        evento: 'execucao.enfileirar',
        resultado: 'chamada-falhou',
        detalhe: 'HTTP 503 apos 3 tentativa(s): POST ... respondeu 503 (tentativa 3/3)',
        tentativas: 3,
      });
      expect(s.passo).toBe(PassoSaga.ENFILEIRAR_EXECUCAO);
      expect(s.status).toBe(StatusSaga.EM_ANDAMENTO);
      expect(s.comandosPendentes).toHaveLength(0);
      expect(s.aguardandoReprocessamento).toBe(true);
      s.reprocessar({});
      expect(s.aguardandoReprocessamento).toBe(false);
    });

    it('sem status nem tentativas: "sem resposta" e 1 tentativa; saga encerrada nunca aguarda reprocessamento', () => {
      const s = nova();
      s.registrarChamadaFalhou('execucao.enfileirar', { erro: 'fetch failed' });
      expect(s.historico[s.historico.length - 1]).toMatchObject({ detalhe: 'sem resposta apos 1 tentativa(s): fetch failed', tentativas: 1 });
      s.aplicar({ type: 'execucao.recusada', data: { numeroOS: 'OS-CF', motivo: 'x' } });
      s.registrarChamadaFalhou('execucao.enfileirar', { erro: 'x' });
      expect(s.status).toBe(StatusSaga.CANCELADA);
      expect(s.aguardandoReprocessamento).toBe(false);
    });

    it('entradas normais nao tem o campo tentativas', () => {
      expect(nova().historico[0]).not.toHaveProperty('tentativas');
    });
  });
});
