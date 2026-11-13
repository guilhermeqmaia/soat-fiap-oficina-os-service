import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PassoSaga, StatusSaga } from '../../domain/saga-os.entity';

/** `200` de `POST /ordens-servico/{numero}/eventos` (http-interno.md). */
export class ResultadoCallbackDto {
  @ApiProperty({ description: 'false = ignorado (duplicado/fora de ordem)', example: true })
  aplicado!: boolean;

  @ApiPropertyOptional({ description: 'true quando o id do envelope ja tinha sido aplicado (so aparece nesse caso)', example: true })
  duplicado?: boolean;

  @ApiPropertyOptional({
    enum: PassoSaga,
    enumName: 'PassoSaga',
    description: 'Passo da saga apos o evento (sempre presente quando a saga existe)',
    example: PassoSaga.GERAR_ORCAMENTO,
  })
  passo?: PassoSaga;

  @ApiPropertyOptional({
    enum: StatusSaga,
    enumName: 'StatusSaga',
    description: 'Status da saga apos o evento (sempre presente quando a saga existe)',
    example: StatusSaga.EM_ANDAMENTO,
  })
  status?: StatusSaga;
}
