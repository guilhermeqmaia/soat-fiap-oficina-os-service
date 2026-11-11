import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { autenticar, ErroAuth, Principal } from './auth';
import { rotaDoComando, validarCorpoDoComando, validarResposta } from './contratos';
import { Log, traceIdDe } from './log';

/**
 * Servidor HTTP minimo (node:http, sem framework) compartilhado pelos dois stubs.
 *
 * Cada rota declara:
 * - `comando` (opcional): chave de `endpoints-participantes.json`. Rotas com
 *   comando sao as do contrato SERVICO — o corpo recebido e a resposta sao
 *   validados contra os schemas, a chamada fica registrada (`GET /__stub/chamadas`)
 *   e as falhas do cenario (5xx, 409, atraso) se aplicam a elas;
 * - `roles`: roles aceitos no JWT (`null` = sem autenticacao, rotas `/__stub`).
 *
 * As rotas usam `{n}` no lugar do numero da OS, igual aos `.feature`
 * ("POST /orcamentos/{n}/cobrar").
 */
export interface Requisicao {
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  headers: IncomingMessage['headers'];
  principal?: Principal;
  correlationId?: string;
  traceparent?: string;
}

export interface Resposta {
  status: number;
  body?: unknown;
}

export interface Rota {
  metodo: 'GET' | 'POST' | 'DELETE';
  caminho: string;
  roles: readonly string[] | null;
  comando?: string;
  handler: (req: Requisicao) => Resposta | Promise<Resposta>;
}

export interface ChamadaRegistrada {
  em: string;
  rota: string;
  metodo: string;
  caminho: string;
  params: Record<string, string>;
  numeroOS?: string;
  body: unknown;
  headers: { authorization?: string; 'x-correlation-id'?: string; traceparent?: string; 'x-tentativa'?: string };
  sub?: string;
  role?: string;
  status?: number;
  injetado?: '5xx' | '409' | null;
}

export interface Violacao {
  em: string;
  tipo: 'requisicao' | 'resposta' | 'callback';
  rota: string;
  numeroOS?: string;
  detalhe: string;
  corpo?: unknown;
}

/** Comportamento controlavel pelos cenarios de BDD (`POST /__stub/cenario`). */
export interface Cenario {
  /** Resultado do proximo pagamento simulado (Billing). */
  pagamento: 'aprovado' | 'recusado';
  motivoRecusaPagamento: string;
  /** Quantas proximas chamadas do contrato respondem 5xx (0 = nenhuma). Com 3 o retry do OS esgota. */
  falhar5xx: number;
  /** Status da falha injetada (default 503). */
  statusFalha: number;
  /** Restringe falhar5xx/recusar/atraso a uma rota ("POST /orcamentos"); vazio = todas as do contrato. */
  rota?: string;
  /** Recusa de negocio: responde 409 { motivo } na rota. */
  recusar?: { rota: string; motivo: string };
  /** Atraso artificial (ms) antes de responder, para provocar timeout no cliente. */
  atrasoMs: number;
}

const CENARIO_PADRAO: Cenario = { pagamento: 'aprovado', motivoRecusaPagamento: 'cartao recusado', falhar5xx: 0, statusFalha: 503, atrasoMs: 0 };

/** "POST /orcamentos/{numeroOS}/cobrar" e "POST /orcamentos/{n}/cobrar" sao a mesma rota. */
export function normalizarRota(rota: string): string {
  return rota.trim().replace(/\{[^}]+\}/g, '{n}').replace(/\s+/g, ' ');
}

interface RotaCompilada extends Rota {
  regex: RegExp;
  nomes: string[];
  rota: string;
}

function compilar(r: Rota): RotaCompilada {
  const nomes: string[] = [];
  const regex = new RegExp(
    '^' + r.caminho.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\w+)\}/g, (_, nome) => (nomes.push(nome), '([^/]+)')) + '/?$',
  );
  return { ...r, regex, nomes, rota: `${r.metodo} ${r.caminho}` };
}

export class ServidorStub {
  readonly chamadas: ChamadaRegistrada[] = [];
  readonly violacoes: Violacao[] = [];
  cenario: Cenario = { ...CENARIO_PADRAO };
  private readonly rotas: RotaCompilada[] = [];

  constructor(
    readonly servico: string,
    readonly log: Log,
  ) {
    this.registrarRotasDeControle();
  }

  adicionar(...rotas: Rota[]): this {
    for (const r of rotas) {
      if (r.comando && normalizarRota(rotaDoComando(r.comando)) !== normalizarRota(`${r.metodo} ${r.caminho}`)) {
        throw new Error(`rota ${r.metodo} ${r.caminho} nao bate com o contrato de ${r.comando}: ${rotaDoComando(r.comando)}`);
      }
      this.rotas.push(compilar(r));
    }
    return this;
  }

  registrarViolacao(v: Omit<Violacao, 'em'>): void {
    const violacao = { em: new Date().toISOString(), ...v };
    this.violacoes.push(violacao);
    this.log.error('CONTRATO VIOLADO', { correlation_id: v.numeroOS, rota: v.rota, tipo: v.tipo, detalhe: v.detalhe });
  }

  ouvir(porta: number): void {
    createServer((req, res) => {
      this.atender(req, res).catch((e) => {
        this.log.error('erro no stub', { erro: (e as Error).stack });
        if (!res.headersSent) responder(res, { status: 500, body: { message: (e as Error).message } });
      });
    }).listen(porta, '0.0.0.0', () => this.log.info(`stub ${this.servico} ouvindo`, { porta }));
  }

  private async atender(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://stub');
    const caminho = decodeURIComponent(url.pathname);
    const alvo = this.rotas.find((r) => r.metodo === req.method && r.regex.test(caminho));
    if (!alvo) {
      responder(res, { status: 404, body: { message: `stub ${this.servico}: rota nao declarada ${req.method} ${caminho}` } });
      return;
    }
    const valores = alvo.regex.exec(caminho)!.slice(1);
    const params = Object.fromEntries(alvo.nomes.map((n, i) => [n, valores[i]]));
    const body = await lerCorpo(req);
    const correlationId = cabecalho(req, 'x-correlation-id');
    const traceparent = cabecalho(req, 'traceparent');
    const requisicao: Requisicao = { params, query: url.searchParams, body, headers: req.headers, correlationId, traceparent };
    const numeroOS = params.n ?? (typeof body?.numeroOS === 'string' ? body.numeroOS : undefined);
    const campos = { correlation_id: correlationId ?? numeroOS, trace_id: traceIdDe(traceparent), rota: alvo.rota, tentativa: cabecalho(req, 'x-tentativa') };

    const chamada: ChamadaRegistrada | undefined = alvo.comando
      ? {
          em: new Date().toISOString(),
          rota: alvo.rota,
          metodo: alvo.metodo,
          caminho,
          params,
          numeroOS,
          body,
          headers: {
            authorization: cabecalho(req, 'authorization'),
            'x-correlation-id': correlationId,
            traceparent,
            'x-tentativa': cabecalho(req, 'x-tentativa'),
          },
          injetado: null,
        }
      : undefined;
    if (chamada) this.chamadas.push(chamada);

    const resposta = await this.decidir(alvo, requisicao, chamada, numeroOS);
    if (chamada) chamada.status = resposta.status;

    if (alvo.comando) {
      const problema = validarResposta(alvo.comando, resposta.status, resposta.body);
      if (problema) this.registrarViolacao({ tipo: 'resposta', rota: alvo.rota, numeroOS, detalhe: problema, corpo: resposta.body });
      this.log.info(`${alvo.rota} -> ${resposta.status}`, { ...campos, sub: chamada?.sub, status: resposta.status, injetado: chamada?.injetado ?? undefined });
    } else if (!alvo.caminho.startsWith('/__stub') && alvo.caminho !== '/health') {
      this.log.info(`${alvo.rota} -> ${resposta.status}`, { ...campos, status: resposta.status });
    }
    responder(res, resposta);
  }

  private async decidir(alvo: RotaCompilada, req: Requisicao, chamada: ChamadaRegistrada | undefined, numeroOS: string | undefined): Promise<Resposta> {
    if (alvo.roles) {
      try {
        req.principal = autenticar(cabecalho(req, 'authorization'), alvo.roles);
        if (chamada) Object.assign(chamada, { sub: req.principal.sub, role: req.principal.role });
      } catch (e) {
        if (e instanceof ErroAuth) return { status: e.status, body: { statusCode: e.status, message: e.message } };
        throw e;
      }
    }
    if (!alvo.comando) return alvo.handler(req);

    // Falhas injetadas pelo cenario (so nas rotas do contrato).
    const c = this.cenario;
    const casa = (rota?: string) => !rota || normalizarRota(rota) === normalizarRota(alvo.rota);
    if (c.atrasoMs > 0 && casa(c.rota)) await new Promise((r) => setTimeout(r, c.atrasoMs));
    if (c.falhar5xx > 0 && casa(c.rota)) {
      c.falhar5xx--;
      chamada!.injetado = '5xx';
      return { status: c.statusFalha, body: { statusCode: c.statusFalha, message: `stub ${this.servico}: falha injetada pelo cenario` } };
    }
    if (c.recusar && casa(c.recusar.rota)) {
      chamada!.injetado = '409';
      return { status: 409, body: { motivo: c.recusar.motivo } };
    }

    const problema = validarCorpoDoComando(alvo.comando, req.body);
    if (problema) {
      this.registrarViolacao({ tipo: 'requisicao', rota: alvo.rota, numeroOS, detalhe: problema, corpo: req.body });
      return { status: 400, body: { statusCode: 400, message: `corpo fora do contrato: ${problema}` } };
    }
    if (req.params.n && typeof req.body?.numeroOS === 'string' && req.body.numeroOS !== req.params.n) {
      return { status: 400, body: { statusCode: 400, message: 'numeroOS do corpo difere do path' } };
    }
    return alvo.handler(req);
  }

  /** Endpoints de controle `/__stub/*` (sem auth; nao existem nos servicos reais). */
  private registrarRotasDeControle(): void {
    const filtrar = (q: URLSearchParams) =>
      this.chamadas.filter(
        (c) => (!q.get('numeroOS') || c.numeroOS === q.get('numeroOS')) && (!q.get('rota') || normalizarRota(c.rota) === normalizarRota(q.get('rota')!)),
      );
    this.adicionar(
      { metodo: 'GET', caminho: '/health', roles: null, handler: () => ({ status: 200, body: { status: 'ok', servico: this.servico, stub: true } }) },
      { metodo: 'GET', caminho: '/__stub/cenario', roles: null, handler: () => ({ status: 200, body: this.cenario }) },
      {
        metodo: 'POST',
        caminho: '/__stub/cenario',
        roles: null,
        handler: (req) => {
          this.cenario = { ...this.cenario, ...(req.body ?? {}) };
          this.log.info('cenario alterado', { cenario: this.cenario });
          return { status: 200, body: this.cenario };
        },
      },
      {
        metodo: 'DELETE',
        caminho: '/__stub/cenario',
        roles: null,
        handler: () => {
          this.cenario = { ...CENARIO_PADRAO };
          return { status: 200, body: this.cenario };
        },
      },
      { metodo: 'GET', caminho: '/__stub/chamadas', roles: null, handler: (req) => ({ status: 200, body: filtrar(req.query) }) },
      {
        metodo: 'DELETE',
        caminho: '/__stub/chamadas',
        roles: null,
        handler: () => {
          this.chamadas.length = 0;
          return { status: 200, body: { ok: true } };
        },
      },
      { metodo: 'GET', caminho: '/__stub/violacoes', roles: null, handler: () => ({ status: 200, body: this.violacoes }) },
    );
  }
}

function cabecalho(req: Pick<IncomingMessage, 'headers'>, nome: string): string | undefined {
  const v = req.headers[nome];
  return Array.isArray(v) ? v[0] : v;
}

async function lerCorpo(req: IncomingMessage): Promise<any> {
  const partes: Buffer[] = [];
  for await (const p of req) partes.push(p as Buffer);
  const texto = Buffer.concat(partes).toString('utf8');
  if (!texto) return undefined;
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

function responder(res: ServerResponse, r: Resposta): void {
  res.writeHead(r.status, { 'content-type': 'application/json' });
  res.end(r.body === undefined ? '' : JSON.stringify(r.body));
}
