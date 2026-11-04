import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsInt, IsNotEmpty, IsObject, IsString, IsUUID, Matches, Min } from 'class-validator';
import { ENVELOPE_HTTP_TYPE_RE } from '@guilhermeqmaia/oficina-kit/http';

/**
 * Envelope dos callbacks dos participantes (`docs/contratos/http-interno.md`).
 * Sem `correlationId` no corpo: a correlacao e o `:numero` do path.
 */
export class EnvelopeCallbackDto {
  @ApiProperty({ description: 'UUID (v7) do evento — chave de idempotencia do callback', example: '0192f3a0-7c6e-7d2a-9b1e-3f4c5d6e7f80' })
  @IsUUID('all')
  id: string;

  @ApiProperty({
    description: 'Tipo do evento (vocabulario do asyncapi.yaml): `<dominio>.<fato>`',
    example: 'execucao.diagnostico-concluido',
    pattern: ENVELOPE_HTTP_TYPE_RE.source,
  })
  @IsString()
  @Matches(ENVELOPE_HTTP_TYPE_RE, { message: 'type deve seguir o padrao <dominio>.<fato> (minusculas, hifen)' })
  type: string;

  @ApiProperty({ description: 'Versao do contrato do evento', example: 1, minimum: 1 })
  @IsInt()
  @Min(1)
  version: number;

  @ApiProperty({ description: 'Quando o fato ocorreu (ISO 8601)', example: '2026-11-03T18:00:00Z' })
  @IsDateString()
  occurredAt: string;

  @ApiProperty({ description: 'Servico que emitiu o evento', example: 'execucao-service' })
  @IsString()
  @IsNotEmpty()
  producer: string;

  @ApiProperty({
    description: 'Payload do evento (asyncapi.yaml). `numeroOS`, se vier, deve ser igual ao :numero do path.',
    type: 'object',
    additionalProperties: true,
    example: { numeroOS: 'OS-2026-0001', mecanicoId: 'uuid', diagnostico: 'Pastilhas gastas', itens: [] },
  })
  @IsObject()
  data: Record<string, unknown>;
}
