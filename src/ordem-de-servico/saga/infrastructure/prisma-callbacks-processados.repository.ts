import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CallbacksProcessados } from '../application/ports/callbacks-processados';

/** Tabela `processed_messages`: `id` do envelope de cada callback ja aplicado (RFC-0008). */
@Injectable()
export class PrismaCallbacksProcessadosRepository implements CallbacksProcessados {
  constructor(private readonly prisma: PrismaService) {}

  async jaProcessado(id: string): Promise<boolean> {
    return (await this.prisma.processedMessage.findUnique({ where: { id } })) !== null;
  }

  async marcar(id: string, type: string): Promise<boolean> {
    try {
      await this.prisma.processedMessage.create({ data: { id, type } });
      return true;
    } catch (e) {
      // Duas entregas simultaneas do mesmo callback: a segunda perde a corrida pela PK.
      if ((e as { code?: string }).code === 'P2002') return false;
      throw e;
    }
  }

  async purgar(antesDe: Date): Promise<number> {
    return (await this.prisma.processedMessage.deleteMany({ where: { processadaEm: { lt: antesDe } } })).count;
  }
}
