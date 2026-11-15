import { ApiProperty } from '@nestjs/swagger';
import { NotificacaoResponseDto } from './notificacao-response.dto';

/** Corpo de `GET /notificacoes` e `GET /clientes/:cpfCnpj/notificacoes`. */
export class NotificacoesPaginadasDto {
  @ApiProperty({ type: [NotificacaoResponseDto] })
  data!: NotificacaoResponseDto[];

  @ApiProperty({ example: 1 })
  total!: number;

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 10 })
  limit!: number;
}
