import { createServer, IncomingMessage, Server } from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * Stub HTTP local (sem dependencia externa) para substituir os outros servicos
 * no BDD de nivel de servico. Cada rota e declarada como no contrato
 * (`docs/contratos/http-interno.md`), ex.: `POST /orcamentos/{n}/cobrar`, com uma
 * resposta padrao; os cenarios sobrescrevem a resposta (`responder`) para
 * simular 409/5xx e consultam as chamadas recebidas (`chamadasEm`).
 *
 * Generico de proposito: os outros servicos copiam este arquivo e so trocam a
 * tabela de rotas (ver `participantes-stub.ts`).
 */
export interface ChamadaRecebida {
  rota: string;
  metodo: string;
  caminho: string;
  params: Record<string, string>;
  headers: IncomingMessage['headers'];
  body: any;
}

export interface RespostaStub {
  status: number;
  body?: unknown;
}

export type Handler = (chamada: ChamadaRecebida) => RespostaStub;

interface RotaCompilada {
  rota: string;
  metodo: string;
  regex: RegExp;
  nomes: string[];
  padrao: Handler;
}

function compilar(rota: string, padrao: Handler): RotaCompilada {
  const [metodo, template] = rota.split(' ');
  const nomes: string[] = [];
  const regex = new RegExp(
    '^' + template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\w+)\}/g, (_, nome) => (nomes.push(nome), '([^/]+)')) + '$',
  );
  return { rota, metodo, regex, nomes, padrao };
}

export class StubHttp {
  readonly chamadas: ChamadaRecebida[] = [];
  private readonly rotas: RotaCompilada[];
  private readonly sobrescritas = new Map<string, Handler>();
  private server?: Server;
  private porta?: number;

  constructor(rotas: Record<string, Handler>) {
    this.rotas = Object.entries(rotas).map(([rota, h]) => compilar(rota, h));
  }

  get url(): string {
    if (!this.porta) throw new Error('StubHttp nao iniciado');
    return `http://127.0.0.1:${this.porta}`;
  }

  async iniciar(): Promise<void> {
    this.server = createServer((req, res) => {
      const partes: Buffer[] = [];
      req.on('data', (p) => partes.push(p));
      req.on('end', () => {
        const caminho = decodeURI((req.url ?? '/').split('?')[0]);
        const texto = Buffer.concat(partes).toString('utf8');
        let body: any = undefined;
        try {
          body = texto ? JSON.parse(texto) : undefined;
        } catch {
          body = texto;
        }
        const alvo = this.rotas.find((r) => r.metodo === req.method && r.regex.test(caminho));
        if (!alvo) {
          res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ message: `stub: rota nao declarada ${req.method} ${caminho}` }));
          return;
        }
        const valores = alvo.regex.exec(caminho)!.slice(1);
        const params = Object.fromEntries(alvo.nomes.map((n, i) => [n, valores[i]]));
        const chamada: ChamadaRecebida = { rota: alvo.rota, metodo: req.method!, caminho, params, headers: req.headers, body };
        this.chamadas.push(chamada);
        const resposta = (this.sobrescritas.get(alvo.rota) ?? alvo.padrao)(chamada);
        res.writeHead(resposta.status, { 'content-type': 'application/json' });
        res.end(resposta.body === undefined ? '' : JSON.stringify(resposta.body));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.porta = (this.server!.address() as AddressInfo).port;
  }

  async parar(): Promise<void> {
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  /** Sobrescreve a resposta de uma rota (ex.: `responder('POST /orcamentos', { status: 503 })`). */
  responder(rota: string, resposta: RespostaStub | Handler): void {
    this.garantirRota(rota);
    this.sobrescritas.set(rota, typeof resposta === 'function' ? resposta : () => resposta);
  }

  /** Volta a rota (ou todas) para a resposta padrao. */
  restaurar(rota?: string): void {
    if (rota) this.sobrescritas.delete(rota);
    else this.sobrescritas.clear();
  }

  /** Limpa sobrescritas e chamadas (rodado antes de cada cenario). */
  reset(): void {
    this.sobrescritas.clear();
    this.chamadas.length = 0;
  }

  chamadasEm(rota: string, filtro: Record<string, string> = {}): ChamadaRecebida[] {
    this.garantirRota(rota);
    return this.chamadas.filter((c) => c.rota === rota && Object.entries(filtro).every(([k, v]) => c.params[k] === v));
  }

  temRota(rota: string): boolean {
    return this.rotas.some((r) => r.rota === rota);
  }

  private garantirRota(rota: string): void {
    if (!this.temRota(rota)) {
      throw new Error(`Rota "${rota}" nao existe no stub. Rotas: ${this.rotas.map((r) => r.rota).join(', ')}`);
    }
  }
}
