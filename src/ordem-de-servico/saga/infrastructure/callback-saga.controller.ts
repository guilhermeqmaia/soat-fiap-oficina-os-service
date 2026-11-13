import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiExtension,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { Role, Roles } from '@guilhermeqmaia/oficina-kit/auth';
import { ReceberCallbackUseCase } from '../application/receber-callback.use-case';
import { EnvelopeCallbackDto } from './dto/envelope-callback.dto';
import { ResultadoCallbackDto } from './dto/resultado-callback.dto';
import { ErroHttpDto } from '../../../shared/infrastructure/dto/erro-http.dto';
import { SCHEMA_ENVELOPE_CALLBACK } from '../../../config/openapi';

/**
 * Callbacks dos participantes da saga (Execucao/Billing -> OS), RFC-0008:
 * eventos que dependem de uma pessoa (mecanico, cliente) ou do Mercado Pago e
 * por isso nao cabem na resposta sincrona dos comandos.
 */
@ApiTags('Ordens de Servico')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token JWT ausente ou invalido', type: ErroHttpDto })
@ApiForbiddenResponse({ description: 'Somente outro servico (JWT com role SERVICO)', type: ErroHttpDto })
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
  @ApiExtension('x-role', 'SERVICO')
  @ApiBody({
    description: 'Envelope do callback; `data` segue o schema do `type` (docs/contratos/schemas/callbacks.schema.json)',
    schema: { $ref: getSchemaPath(SCHEMA_ENVELOPE_CALLBACK) },
  })
  @ApiOkResponse({ description: 'Resultado na saga (aplicado ou duplicado)', type: ResultadoCallbackDto })
  @ApiBadRequestResponse({ description: 'Envelope invalido ou data.numeroOS diferente do :numero', type: ErroHttpDto })
  @ApiNotFoundResponse({ description: 'OS inexistente (erro de configuracao — nao repetir)', type: ErroHttpDto })
  @ApiConflictResponse({ description: 'OS/saga alterada ao mesmo tempo (releia e repita o callback)', type: ErroHttpDto })
  async receberEvento(@Param('numero') numero: string, @Body() dto: EnvelopeCallbackDto): Promise<ResultadoCallbackDto> {
    const numeroNoCorpo = dto.data.numeroOS;
    if (numeroNoCorpo !== undefined && numeroNoCorpo !== numero) {
      throw new BadRequestException(`data.numeroOS (${String(numeroNoCorpo)}) diverge do numero do path (${numero})`);
    }
    return this.receberCallback.execute({ numero, envelope: { id: dto.id, type: dto.type, data: dto.data } });
  }
}
