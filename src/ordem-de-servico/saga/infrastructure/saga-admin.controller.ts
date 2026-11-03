import { Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { Role, Roles } from '@guilhermeqmaia/oficina-kit/auth';
import { OrquestradorSagaService } from '../application/orquestrador-saga.service';
import { SagaPresenter } from './saga.presenter';

/** Operacao da saga (US-F4-11): retomar uma saga travada reenviando o comando pendente. */
@ApiTags('Saga (admin)')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token JWT ausente ou invalido' })
@ApiForbiddenResponse({ description: 'Somente ADMIN' })
@Controller('admin/sagas')
export class SagaAdminController {
  constructor(private readonly orquestrador: OrquestradorSagaService) {}

  @Post(':numero/reprocessar')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reprocessar saga travada (reenvia o comando do passo atual ou as compensacoes pendentes via outbox)',
    description:
      'Uso apos triagem da DLQ (runbook docs/runbooks/saga-dlq-reprocessar.md). Nao altera a OS: so reenfileira o que o ' +
      'participante nao respondeu. Passos que aguardam cliente/participante devolvem `reenviados: []`.',
  })
  @ApiOkResponse({ description: 'Saga apos o reprocessamento e lista de comandos reenviados' })
  @ApiNotFoundResponse({ description: 'Saga nao encontrada' })
  async reprocessar(@Param('numero') numero: string) {
    const { saga, reenviados } = await this.orquestrador.reprocessar(numero);
    return { reenviados, saga: SagaPresenter.toResponse(saga) };
  }
}
