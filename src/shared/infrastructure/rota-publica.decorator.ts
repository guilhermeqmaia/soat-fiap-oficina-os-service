import { applyDecorators } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';
import { Public } from '@guilhermeqmaia/oficina-kit/auth';

/** Marcador lido por `criarDocumentoOpenApi` (src/config/openapi.ts) e removido do documento final. */
export const EXTENSAO_ROTA_PUBLICA = 'x-rota-publica';

/**
 * `@Public()` do kit + `security: []` no OpenAPI. Sem isto, o `@ApiBearerAuth`
 * do controller faria uma rota publica aparecer como protegida no contrato.
 */
export const RotaPublica = (): MethodDecorator & ClassDecorator =>
  applyDecorators(Public(), ApiExtension(EXTENSAO_ROTA_PUBLICA, true));
