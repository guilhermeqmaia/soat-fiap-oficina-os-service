import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Role, Roles } from '@guilhermeqmaia/oficina-kit/auth';
import { ReceberCallbackUseCase } from '../application/receber-callback.use-case';
import { EnvelopeCallbackDto } from './dto/envelope-callback.dto';

/**
 * Callbacks dos participantes da saga (Execucao/Billing -> OS), RFC-0008:
 * eventos que dependem de uma pessoa (mecanico, cliente) ou do Mercado Pago e
 * por isso nao cabem na resposta sincrona dos comandos.
 */
@ApiTags('Ordens de Servico')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token JWT ausente ou invalido' })
@ApiForbiddenResponse({ description: 'Somente outro servico (JWT com role SERVICO)' })
@Controller('ordens-servico')
export class CallbackSagaController {
  constructor(private readonly receberCallback: ReceberCallbackUseCase) {}

  @Post(':numero/eventos')
  @Roles(Role.SERVICO)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Callback de evento de um participante da saga (Execucao/Billing) — role SERVICO',
    description:
      'Corpo = envelope (`id` uuid, `type`, `version`, `occurredAt`, `producer`, `data`). Idempotente pelo `id`: ' +
      'repeticao devolve `{ aplicado: false, duplicado: true }`. O orquestrador aplica o evento na saga/OS e executa os ' +
      'comandos seguintes por HTTP antes de responder. Tipos: execucao.diagnostico-concluido, execucao.finalizada, ' +
      'billing.orcamento-aprovado, billing.orcamento-rejeitado, billing.pagamento-aprovado, billing.pagamento-recusado ' +
      '(os demais eventos chegam como resposta sincrona dos comandos).',
  })
  @ApiOkResponse({
    description: 'Resultado na saga',
    schema: {
      example: { aplicado: true, passo: 'GERAR_ORCAMENTO', status: 'EM_ANDAMENTO' },
      properties: {
        aplicado: { type: 'boolean', description: 'false = ignorado (duplicado/fora de ordem)' },
        duplicado: { type: 'boolean', description: 'true quando o id ja tinha sido aplicado' },
        passo: { type: 'string' },
        status: { type: 'string', enum: ['EM_ANDAMENTO', 'COMPENSANDO', 'CONCLUIDA', 'CANCELADA'] },
      },
    },
  })
  @ApiBadRequestResponse({ description: 'Envelope invalido ou data.numeroOS diferente do :numero' })
  @ApiNotFoundResponse({ description: 'OS inexistente' })
  @ApiConflictResponse({ description: 'OS/saga alterada ao mesmo tempo (repita o callback)' })
  async receberEvento(@Param('numero') numero: string, @Body() dto: EnvelopeCallbackDto) {
    const numeroNoCorpo = dto.data.numeroOS;
    if (numeroNoCorpo !== undefined && numeroNoCorpo !== numero) {
      throw new BadRequestException(`data.numeroOS (${String(numeroNoCorpo)}) diverge do numero do path (${numero})`);
    }
    return this.receberCallback.execute({ numero, envelope: { id: dto.id, type: dto.type, data: dto.data } });
  }
}
