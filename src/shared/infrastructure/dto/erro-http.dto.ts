import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Corpo de erro padrao do Nest (`HttpException`), produzido pelo
 * `DomainExceptionFilter` do kit, pelo `ValidationPipe` e pelos guards.
 * Documentado para que os testes de contrato (US-F4-15) validem 4xx tambem.
 */
export class ErroHttpDto {
  @ApiProperty({ example: 404 })
  statusCode!: number;

  @ApiProperty({
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    description: 'Mensagem (lista quando vem do ValidationPipe)',
    example: "Ordem de Servico 'OS-2026-000123' nao encontrada",
  })
  message!: string | string[];

  @ApiPropertyOptional({ example: 'Not Found', description: 'Ausente no 401 do guard JWT' })
  error?: string;
}
