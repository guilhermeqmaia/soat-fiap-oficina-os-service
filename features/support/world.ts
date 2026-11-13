import { IWorldOptions, setDefaultTimeout, setWorldConstructor, World } from '@cucumber/cucumber';
import { criarEnvelopeHttp } from '@guilhermeqmaia/oficina-kit/http';
import { expect } from 'expect';
import { contexto } from './contexto';
import { cpfAleatorio, ITENS_DIAGNOSTICO, placaAleatoria } from './dados';
import { RespostaHttp } from './http-client';
import { aguardarAte } from './polling';
import { tokenDe } from './tokens';

// Chamadas que falham com 5xx passam pelas 3 tentativas do kit (~1 s cada).
setDefaultTimeout(60_000);

/** Servico que envia o callback, como aparece nos .feature. */
export type ServicoCallback = 'Execução' | 'Billing';

const PRODUCER: Record<ServicoCallback, { producer: 'execucao-service' | 'billing-service'; token: 'execucao' | 'billing' }> = {
  Execução: { producer: 'execucao-service', token: 'execucao' },
  Billing: { producer: 'billing-service', token: 'billing' },
};

export interface OrdemAberta {
  id: string;
  numero: string;
}

/**
 * Estado de UM cenario + operacoes de dominio que os steps usam. Rotas: as
 * acoes do atendente (`cancelar`, `entregar`, detalhe) usam o **id** (UUID) da
 * OS; callback, status publico e saga usam o **numero** (`OS-AAAA-...`).
 */
export class MundoOS extends World {
  cliente?: { id: string; cpf: string; email: string };
  veiculo?: { id: string; placa: string };
  os?: OrdemAberta;
  ultimaResposta?: RespostaHttp;
  ultimoCallback?: { servico: ServicoCallback; envelope: ReturnType<typeof criarEnvelopeHttp> };

  constructor(options: IWorldOptions) {
    super(options);
  }

  get http() {
    return contexto().http;
  }

  get ordem(): OrdemAberta {
    if (!this.os) throw new Error('Nenhuma OS aberta neste cenario (use "Dado que existe uma OS ..." antes).');
    return this.os;
  }

  // ---------- dados de base ----------

  async criarClienteComVeiculo(): Promise<void> {
    const admin = tokenDe('admin');
    const cpf = cpfAleatorio();
    const email = `cliente.${cpf}@bdd.oficina.test`;
    const c = await this.http.post('/clientes', { nome: 'Cliente BDD', cpfCnpj: cpf, telefone: '11999990000', email }, admin);
    expect(c.status).toBe(201);
    this.cliente = { id: c.body.id, cpf, email };
    const placa = placaAleatoria();
    const v = await this.http.post('/veiculos', { placa, marca: 'Toyota', modelo: 'Corolla', ano: 2024, clienteId: this.cliente.id }, admin);
    expect(v.status).toBe(201);
    this.veiculo = { id: v.body.id, placa };
  }

  // ---------- acoes ----------

  async abrirOS(descricao = 'Cliente relata barulho ao frear'): Promise<RespostaHttp> {
    if (!this.cliente || !this.veiculo) await this.criarClienteComVeiculo();
    const res = await this.http.post('/ordens-servico', { clienteId: this.cliente!.id, veiculoId: this.veiculo!.id, descricaoInicial: descricao }, tokenDe('atendente'));
    this.ultimaResposta = res;
    expect(res.status).toBe(201);
    this.os = { id: res.body.id, numero: res.body.numero };
    return res;
  }

  dadosPadraoDoCallback(type: string): Record<string, unknown> {
    const n = this.ordem.numero;
    const padrao: Record<string, Record<string, unknown>> = {
      'execucao.diagnostico-concluido': { mecanicoId: contexto().mecanicoId, diagnostico: 'Pastilhas gastas e disco empenado', itens: ITENS_DIAGNOSTICO },
      'billing.orcamento-aprovado': { orcamentoId: `orc-${n}` },
      'billing.orcamento-rejeitado': { orcamentoId: `orc-${n}`, motivo: 'cliente achou caro' },
      'execucao.finalizada': { finalizadaEm: new Date().toISOString() },
      'billing.pagamento-aprovado': { orderId: 'mp-bdd', valor: '300.00' },
      'billing.pagamento-recusado': { orderId: 'mp-bdd', motivo: 'cartao recusado' },
    };
    return padrao[type] ?? {};
  }

  /** `POST /ordens-servico/{numero}/eventos` com JWT de SERVICO do participante. */
  async enviarCallback(servico: ServicoCallback, type: string, extras: Record<string, unknown> = {}): Promise<RespostaHttp> {
    const { producer } = PRODUCER[servico];
    const envelope = criarEnvelopeHttp({ type, producer, data: { numeroOS: this.ordem.numero, ...this.dadosPadraoDoCallback(type), ...extras } });
    this.ultimoCallback = { servico, envelope };
    return this.postarEnvelope(servico, envelope);
  }

  /** Reenvia o ultimo envelope com o MESMO `id` (entrega duplicada). */
  async reenviarUltimoCallback(): Promise<RespostaHttp> {
    if (!this.ultimoCallback) throw new Error('Nenhum callback enviado ainda neste cenario.');
    return this.postarEnvelope(this.ultimoCallback.servico, this.ultimoCallback.envelope);
  }

  private async postarEnvelope(servico: ServicoCallback, envelope: object): Promise<RespostaHttp> {
    const res = await this.http.post(`/ordens-servico/${encodeURIComponent(this.ordem.numero)}/eventos`, envelope, tokenDe(PRODUCER[servico].token));
    this.ultimaResposta = res;
    return res;
  }

  async cancelarOS(ator: 'atendente' | 'admin' = 'atendente', motivo?: string): Promise<RespostaHttp> {
    const res = await this.http.post(`/ordens-servico/${this.ordem.id}/cancelar`, motivo ? { motivo } : {}, tokenDe(ator));
    this.ultimaResposta = res;
    return res;
  }

  async entregarVeiculo(): Promise<RespostaHttp> {
    const res = await this.http.post(`/ordens-servico/${this.ordem.id}/entregar`, undefined, tokenDe('atendente'));
    this.ultimaResposta = res;
    return res;
  }

  async reprocessarSaga(): Promise<RespostaHttp> {
    const res = await this.http.post(`/admin/sagas/${encodeURIComponent(this.ordem.numero)}/reprocessar`, undefined, tokenDe('admin'));
    this.ultimaResposta = res;
    return res;
  }

  // ---------- consultas (sempre via API) ----------

  async statusDaOS(): Promise<{ status: string; motivoCancelamento: string | null; valorTotal: number }> {
    const res = await this.http.get(`/ordens-servico/numero/${encodeURIComponent(this.ordem.numero)}/status`);
    expect(res.status).toBe(200);
    return res.body;
  }

  async sagaDaOS(): Promise<{ passo: string; status: string; compensacoes: Array<{ comando: string; confirmadaEm: string | null }>; historico: Array<{ evento: string; resultado: string; detalhe?: string }> }> {
    const res = await this.http.get(`/ordens-servico/numero/${encodeURIComponent(this.ordem.numero)}/saga`, tokenDe('atendente'));
    expect(res.status).toBe(200);
    return res.body;
  }

  /** Notificacoes desta OS no historico do cliente (`GET /clientes/:cpf/notificacoes`, token do proprio cliente). */
  async notificacoesDaOS(): Promise<Array<{ tipo: string; destinatario: string; assunto: string; mensagem: string; ordemDeServicoId: string }>> {
    const cpf = this.cliente!.cpf;
    const res = await this.http.get(`/clientes/${cpf}/notificacoes?limit=100`, tokenDe('cliente', { cpf }));
    expect(res.status).toBe(200);
    return res.body.data.filter((n: any) => n.ordemDeServicoId === this.ordem.id);
  }

  async aguardarStatus(status: string): Promise<void> {
    await aguardarAte(`OS ${this.ordem.numero} com status ${status}`, () => this.statusDaOS(), (s) => {
      expect(s.status).toBe(status);
    });
  }

  /**
   * Leva a OS do cenario ate `alvo` pelo caminho feliz (abrir -> callbacks ->
   * entrega), conferindo cada status no caminho. Usado pelos "Dado" de pre-condicao.
   */
  async levarAteStatus(alvo: string): Promise<void> {
    const caminho: Array<[string, () => Promise<unknown>]> = [
      ['EM_DIAGNOSTICO', () => this.abrirOS()],
      ['AGUARDANDO_APROVACAO', () => this.enviarCallback('Execução', 'execucao.diagnostico-concluido')],
      ['EM_EXECUCAO', () => this.enviarCallback('Billing', 'billing.orcamento-aprovado')],
      ['AGUARDANDO_PAGAMENTO', () => this.enviarCallback('Execução', 'execucao.finalizada')],
      ['FINALIZADA', () => this.enviarCallback('Billing', 'billing.pagamento-aprovado')],
      ['ENTREGUE', () => this.entregarVeiculo()],
    ];
    const indice = caminho.findIndex(([s]) => s === alvo);
    if (indice < 0) throw new Error(`Status "${alvo}" nao e alcancavel pelo caminho feliz. Use: ${caminho.map(([s]) => s).join(', ')}`);
    for (const [status, acao] of caminho.slice(0, indice + 1)) {
      await acao();
      await this.aguardarStatus(status);
    }
  }
}

setWorldConstructor(MundoOS);
