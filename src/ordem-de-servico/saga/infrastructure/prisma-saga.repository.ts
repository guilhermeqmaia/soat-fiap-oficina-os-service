import { Inject, Injectable } from '@nestjs/common';
import { criarEnvelope, OUTBOX_REPOSITORY, OutboxRepository } from '@guilhermeqmaia/oficina-kit/messaging';
import { PrismaService } from '../../../prisma/prisma.service';
import { ConcurrentModificationError } from '../../domain/errors/concurrent-modification.error';
import { Compensacao, PassoHistorico, PassoSaga, SagaOS, StatusSaga } from '../domain/saga-os.entity';
import { SagaRepository } from '../domain/saga.repository';

type PrismaTx = { sagaOS: PrismaService['sagaOS'] };

/** Tabela `saga_os`; os comandos pendentes vao para o outbox na mesma transacao. */
@Injectable()
export class PrismaSagaRepository implements SagaRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository<unknown>,
  ) {}

  async findByNumero(numero: string, tx?: unknown): Promise<SagaOS | null> {
    const row = await this.db(tx).sagaOS.findUnique({ where: { numero } });
    return row ? this.toDomain(row) : null;
  }

  async save(saga: SagaOS, txExterno?: unknown): Promise<SagaOS> {
    const data = {
      numero: saga.numero,
      clienteId: saga.clienteId,
      veiculoId: saga.veiculoId,
      descricaoProblema: saga.descricaoProblema,
      passo: saga.passo,
      status: saga.status,
      passoDesde: saga.passoDesde,
      historico: saga.historico as unknown as object[],
      compensacoes: saga.compensacoes as unknown as object[],
      prazoAprovacao: saga.prazoAprovacao,
      prazoPagamento: saga.prazoPagamento,
      falhaSimulada: saga.falhaSimulada,
    };
    const row = await this.naTransacao(txExterno, async (tx) => {
      let id = saga.id;
      if (!id) {
        try {
          id = (await tx.sagaOS.create({ data })).id;
        } catch (e) {
          // Duas replicas adotando a mesma OS ao mesmo tempo: unique(numero).
          if ((e as { code?: string }).code === 'P2002') throw new ConcurrentModificationError(`saga ${saga.numero}`);
          throw e;
        }
      } else {
        const { count } = await tx.sagaOS.updateMany({
          where: { id, version: saga.version },
          data: { ...data, version: { increment: 1 } },
        });
        if (count === 0) throw new ConcurrentModificationError(`saga ${saga.numero}`);
      }
      for (const comando of saga.consumirComandos()) {
        await this.outbox.gravar(
          criarEnvelope({
            type: comando.type,
            data: comando.data,
            producer: 'os-service',
            correlationId: saga.numero,
            causationId: comando.causationId,
          }),
          tx,
        );
      }
      return tx.sagaOS.findUniqueOrThrow({ where: { id } });
    });
    return this.toDomain(row);
  }

  async deleteByNumero(numero: string, tx?: unknown): Promise<void> {
    await this.db(tx).sagaOS.deleteMany({ where: { numero } });
  }

  async findComPrazoVencido(agora: Date, limite = 100): Promise<SagaOS[]> {
    const rows = await this.prisma.sagaOS.findMany({
      where: {
        status: StatusSaga.EM_ANDAMENTO,
        OR: [{ prazoAprovacao: { lte: agora } }, { prazoPagamento: { lte: agora } }],
      },
      orderBy: { updatedAt: 'asc' },
      take: limite,
    });
    return rows.map((r) => this.toDomain(r));
  }

  async countPorStatus(): Promise<Record<string, number>> {
    const grupos = await this.prisma.sagaOS.groupBy({ by: ['status'], _count: { _all: true } });
    return Object.fromEntries(grupos.map((g) => [g.status, g._count._all]));
  }

  async countParadasDesde(desde: Date): Promise<number> {
    return this.prisma.sagaOS.count({ where: { status: StatusSaga.EM_ANDAMENTO, passoDesde: { lte: desde } } });
  }

  private db(tx?: unknown): PrismaTx {
    return (tx as PrismaTx | undefined) ?? (this.prisma as unknown as PrismaTx);
  }

  private naTransacao<T>(txExterno: unknown, fn: (tx: PrismaTx) => Promise<T>): Promise<T> {
    if (txExterno) return fn(txExterno as PrismaTx);
    return this.prisma.$transaction((tx) => fn(tx as unknown as PrismaTx));
  }

  private toDomain(r: {
    id: string; numero: string; clienteId: string; veiculoId: string; descricaoProblema: string; passo: string; status: string;
    passoDesde: Date; historico: unknown; compensacoes: unknown; prazoAprovacao: Date | null; prazoPagamento: Date | null; falhaSimulada?: string | null;
    version: number; createdAt: Date; updatedAt: Date;
  }): SagaOS {
    return SagaOS.reconstitute({
      id: r.id,
      numero: r.numero,
      clienteId: r.clienteId,
      veiculoId: r.veiculoId,
      descricaoProblema: r.descricaoProblema,
      passo: r.passo as PassoSaga,
      status: r.status as StatusSaga,
      passoDesde: r.passoDesde,
      historico: Array.isArray(r.historico) ? (r.historico as PassoHistorico[]) : [],
      compensacoes: Array.isArray(r.compensacoes) ? (r.compensacoes as Compensacao[]) : [],
      prazoAprovacao: r.prazoAprovacao ?? null,
      prazoPagamento: r.prazoPagamento ?? null,
      falhaSimulada: (r.falhaSimulada as PassoSaga | null) ?? null,
      version: r.version ?? 0,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    });
  }
}
