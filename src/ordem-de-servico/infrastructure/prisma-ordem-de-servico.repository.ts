import { Inject, Injectable } from "@nestjs/common";
import {
  criarEnvelope,
  OUTBOX_REPOSITORY,
  OutboxRepository,
} from "@guilhermeqmaia/oficina-kit/messaging";
import { PrismaService } from "../../prisma/prisma.service";
import {
  OrdemDeServicoRepository,
  FindAllParams,
  PaginatedResult,
} from "../domain/ordem-de-servico.repository";
import { OrdemDeServico } from "../domain/ordem-de-servico.entity";
import { StatusOS } from "../domain/value-objects/status-os.vo";
import { MotivoCancelamento } from "../domain/value-objects/motivo-cancelamento";
import { ItemServicoOS } from "../domain/value-objects/item-servico-os.vo";
import { ItemProdutoOS } from "../domain/value-objects/item-produto-os.vo";
import { ConcurrentModificationError } from "../domain/errors/concurrent-modification.error";

/** Subconjunto do client Prisma usado por este repositorio (vale para o client global e o transacional). */
type PrismaTx = {
  ordemDeServico: PrismaService['ordemDeServico'];
  itemOrdemDeServicoServico: PrismaService['itemOrdemDeServicoServico'];
};

const INCLUDE_ITENS = {
  itensServico: { include: { produtos: true } },
} as const;

/** Prioridade de exibicao na listagem (mais avancada primeiro: AGUARDANDO_PAGAMENTO, EM_EXECUCAO...; terminais por ultimo). */
const STATUS_PRIORITY: Record<string, number> = {
  AGUARDANDO_PAGAMENTO: 0,
  EM_EXECUCAO: 1,
  AGUARDANDO_APROVACAO: 2,
  EM_DIAGNOSTICO: 3,
  RECEBIDA: 4,
  CANCELADA: 5,
  FINALIZADA: 6,
  ENTREGUE: 7,
};

@Injectable()
export class PrismaOrdemDeServicoRepository implements OrdemDeServicoRepository {
  constructor(
    private prisma: PrismaService,
    /** Outbox (ADR-0009) — obrigatorio: nenhuma mudanca de OS sem o evento correspondente. */
    @Inject(OUTBOX_REPOSITORY)
    private readonly outbox: OutboxRepository<unknown>,
  ) {}

  async create(os: OrdemDeServico, txExterno?: unknown): Promise<OrdemDeServico> {
    const data = await this.naTransacao(txExterno, async (tx) => {
      const criada = await tx.ordemDeServico.create({
        data: {
          numero: os.numero,
          clienteId: os.clienteId,
          veiculoId: os.veiculoId,
          usuarioId: os.mecanicoId,
          descricaoInicial: os.descricaoInicial,
          diagnostico: os.diagnostico,
          status: os.status,
          motivoCancelamento: os.motivoCancelamento,
          itensServico: { create: os.itensServico.map(this.toItemCreate) },
        },
        include: INCLUDE_ITENS,
      });
      await this.gravarEventosIntegracao(os, tx);
      return criada;
    });
    return this.toDomain(data);
  }

  async findById(id: string): Promise<OrdemDeServico | null> {
    const data = await this.prisma.ordemDeServico.findUnique({
      where: { id },
      include: INCLUDE_ITENS,
    });
    return data ? this.toDomain(data) : null;
  }

  async findAll(
    params: FindAllParams,
  ): Promise<PaginatedResult<OrdemDeServico>> {
    const page = params.page ?? 1;
    const limit = params.limit ?? 10;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (params.clienteId) where.clienteId = params.clienteId;
    if (params.status) where.status = params.status;
    if (params.numero)
      where.numero = { contains: params.numero, mode: "insensitive" };
    // Estados terminais ficam de fora por padrao (working set = OS ativas).
    if (!params.incluirEncerradas) {
      where.NOT = [
        { status: "FINALIZADA" },
        { status: "ENTREGUE" },
        { status: "CANCELADA" },
      ];
    }

    // Ordenacao por prioridade de status nao e expressavel no orderBy do
    // Prisma: ordena em memoria o conjunto (limitado as OS ativas) e pagina depois.
    const [data, total] = await Promise.all([
      this.prisma.ordemDeServico.findMany({ where, include: INCLUDE_ITENS }),
      this.prisma.ordemDeServico.count({ where }),
    ]);
    const sorted = [...data].sort((a, b) => {
      const pa = STATUS_PRIORITY[a.status] ?? 999;
      const pb = STATUS_PRIORITY[b.status] ?? 999;
      return pa !== pb
        ? pa - pb
        : a.createdAt.getTime() - b.createdAt.getTime();
    });
    return {
      data: sorted.slice(skip, skip + limit).map((d) => this.toDomain(d)),
      total,
      page,
      limit,
    };
  }

  async findByNumero(numero: string, tx?: unknown): Promise<OrdemDeServico | null> {
    const data = await (this.db(tx)).ordemDeServico.findUnique({
      where: { numero },
      include: INCLUDE_ITENS,
    });
    return data ? this.toDomain(data) : null;
  }

  async update(os: OrdemDeServico, txExterno?: unknown): Promise<OrdemDeServico> {
    const data = await this.naTransacao(txExterno, async (tx) => {
      // Lock otimista: so grava se ninguem alterou a OS desde a leitura.
      const { count } = await tx.ordemDeServico.updateMany({
        where: { id: os.id, version: os.version },
        data: {
          descricaoInicial: os.descricaoInicial,
          diagnostico: os.diagnostico,
          status: os.status,
          usuarioId: os.mecanicoId,
          motivoCancelamento: os.motivoCancelamento,
          version: { increment: 1 },
        },
      });
      if (count === 0) throw new ConcurrentModificationError(os.id as string);
      // Snapshot substitui o anterior (cascade apaga os produtos filhos).
      await tx.itemOrdemDeServicoServico.deleteMany({
        where: { ordemDeServicoId: os.id },
      });
      for (const item of os.itensServico) {
        await tx.itemOrdemDeServicoServico.create({
          data: {
            ordemDeServicoId: os.id as string,
            ...this.toItemCreate(item),
          },
        });
      }
      await this.gravarEventosIntegracao(os, tx);
      return tx.ordemDeServico.findUnique({
        where: { id: os.id },
        include: INCLUDE_ITENS,
      });
    });
    return this.toDomain(data);
  }

  /**
   * Eventos `os.*` vao para o outbox NA MESMA transacao da OS (ADR-0009): ou a
   * OS muda e o evento sera entregue, ou nada acontece. `correlationId` = numero
   * da OS (MessageGroupId do FIFO, RFC-0006).
   */
  private async gravarEventosIntegracao(
    os: OrdemDeServico,
    tx: unknown,
  ): Promise<void> {
    for (const evento of os.consumirEventosIntegracao()) {
      await this.outbox.gravar(
        criarEnvelope({
          type: evento.type,
          data: evento.data,
          producer: "os-service",
          correlationId: os.numero,
          causationId: evento.causationId,
        }),
        tx,
      );
    }
  }

  async delete(id: string): Promise<void> {
    await this.prisma.ordemDeServico.delete({ where: { id } });
  }

  async existsByNumero(numero: string): Promise<boolean> {
    return (await this.prisma.ordemDeServico.count({ where: { numero } })) > 0;
  }

  /** Client transacional: o do unit of work do chamador ou o global. */
  private db(tx?: unknown): PrismaTx {
    return (tx as PrismaTx | undefined) ?? (this.prisma as unknown as PrismaTx);
  }

  /** Reusa a transacao do chamador (unit of work) ou abre uma propria. */
  private naTransacao<T>(txExterno: unknown, fn: (tx: PrismaTx) => Promise<T>): Promise<T> {
    if (txExterno) return fn(txExterno as PrismaTx);
    return this.prisma.$transaction((tx) => fn(tx as unknown as PrismaTx));
  }

  private toItemCreate(item: ItemServicoOS) {
    return {
      servicoId: item.servicoId,
      nome: item.nome,
      quantidade: item.quantidade,
      precoUnitario: item.precoUnitario,
      produtos: {
        create: item.produtos.map((p) => ({
          produtoId: p.produtoId,
          nome: p.nome,
          quantidade: p.quantidade,
          precoUnitario: p.precoUnitario,
        })),
      },
    };
  }

  private toDomain(data: any): OrdemDeServico {
    const itensServico: ItemServicoOS[] = (data.itensServico ?? []).map(
      (i: any) =>
        new ItemServicoOS(
          i.servicoId,
          i.nome,
          i.quantidade,
          Number(i.precoUnitario),
          (i.produtos ?? []).map(
            (p: any) =>
              new ItemProdutoOS(
                p.produtoId,
                p.nome,
                p.quantidade,
                Number(p.precoUnitario),
              ),
          ),
        ),
    );
    return OrdemDeServico.reconstitute({
      id: data.id,
      numero: data.numero,
      clienteId: data.clienteId,
      veiculoId: data.veiculoId,
      mecanicoId: data.usuarioId,
      descricaoInicial: data.descricaoInicial,
      diagnostico: data.diagnostico,
      status: data.status as StatusOS,
      motivoCancelamento:
        (data.motivoCancelamento as MotivoCancelamento | null) ?? null,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      version: data.version ?? 0,
      itensServico,
    });
  }
}
