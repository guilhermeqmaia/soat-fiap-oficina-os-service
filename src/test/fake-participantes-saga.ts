import { ComandoSaga, TipoComando } from '../ordem-de-servico/saga/domain/saga-os.entity';
import { ParticipantesSagaGateway, ResultadoComando } from '../ordem-de-servico/saga/application/ports/participantes-saga.gateway';

/**
 * Participantes da saga em memoria para os testes: responde cada comando como
 * `docs/contratos/http-interno.md` define (201/200 = evento de sucesso com o
 * corpo da resposta) e registra as chamadas. `recusar()` simula um 409
 * `{ motivo }`; `indisponivel()` simula tentativas esgotadas (5xx/timeout).
 */
export class FakeParticipantesSaga implements ParticipantesSagaGateway {
  readonly chamadas: ComandoSaga[] = [];
  private readonly recusas = new Map<TipoComando, string>();
  private readonly indisponiveis = new Set<TipoComando>();
  private seq = 0;

  recusar(type: TipoComando, motivo: string): void {
    this.recusas.set(type, motivo);
  }
  indisponivel(type: TipoComando): void {
    this.indisponiveis.add(type);
  }
  /** Volta a responder normalmente (todos os comandos ou so um). */
  restaurar(type?: TipoComando): void {
    if (type) {
      this.recusas.delete(type);
      this.indisponiveis.delete(type);
    } else {
      this.recusas.clear();
      this.indisponiveis.clear();
    }
  }
  limparChamadas(): void {
    this.chamadas.length = 0;
  }
  tipos(numeroOS?: string): TipoComando[] {
    return this.chamadas.filter((c) => !numeroOS || c.data.numeroOS === numeroOS).map((c) => c.type);
  }
  de(type: TipoComando, numeroOS?: string): ComandoSaga[] {
    return this.chamadas.filter((c) => c.type === type && (!numeroOS || c.data.numeroOS === numeroOS));
  }

  async executar(comando: ComandoSaga): Promise<ResultadoComando> {
    this.chamadas.push(comando);
    const numeroOS = String(comando.data.numeroOS);
    if (this.indisponiveis.has(comando.type)) {
      return { entregue: false, erro: `${comando.type}: tentativas esgotadas (fake indisponivel)`, status: 503, tentativas: 3, resultado: 'esgotado' };
    }
    const motivo = this.recusas.get(comando.type);
    if (motivo !== undefined) {
      if (comando.type === 'execucao.enfileirar' || comando.type === 'execucao.iniciar') {
        return { entregue: true, evento: { type: 'execucao.recusada', data: { numeroOS, motivo } } };
      }
      return { entregue: false, erro: `${comando.type}: 409 ${motivo}`, status: 409, tentativas: 1, resultado: 'recusa' };
    }
    switch (comando.type) {
      case 'execucao.enfileirar':
        return { entregue: true, evento: { type: 'execucao.enfileirada', data: { numeroOS, posicaoFila: 1 } } };
      case 'execucao.iniciar':
        return { entregue: true, evento: { type: 'execucao.iniciada', data: { numeroOS } } };
      case 'execucao.liberar-reservas':
        return { entregue: true, evento: { type: 'execucao.reservas-liberadas', data: { numeroOS } } };
      case 'billing.gerar-orcamento': {
        const itens = (comando.data.itens as Array<{ quantidade: number; precoUnitario: string | number }>) ?? [];
        const total = itens.reduce((acc, i) => acc + i.quantidade * Number(i.precoUnitario), 0).toFixed(2);
        return {
          entregue: true,
          evento: {
            type: 'billing.orcamento-gerado',
            data: { numeroOS, orcamentoId: `orc-${numeroOS}`, total, validoAte: new Date(Date.now() + 3 * 86_400_000).toISOString() },
          },
        };
      }
      case 'billing.cobrar': {
        const orderId = `mp-${++this.seq}`;
        return {
          entregue: true,
          evento: { type: 'billing.cobranca-criada', data: { numeroOS, orderId, linkPagamento: `https://mp.test/pay/${orderId}`, valor: '300.00' } },
        };
      }
      case 'billing.cancelar-orcamento':
        return { entregue: true, evento: { type: 'billing.orcamento-cancelado', data: { numeroOS, orcamentoId: `orc-${numeroOS}`, estornado: false } } };
    }
  }
}
