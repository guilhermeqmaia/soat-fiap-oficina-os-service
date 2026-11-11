// Tracing precisa ser inicializado antes de qualquer outro import (US-F3-10).
import { iniciarTracing } from '@guilhermeqmaia/oficina-kit/metrics';
iniciarTracing();

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { criarDocumentoOpenApi } from './config/openapi';

async function bootstrap() {
  // `bufferLogs` segura os logs do bootstrap ate o Logger do nestjs-pino
  // (JSON estruturado) ser aplicado logo abaixo — evita perder/duplicar
  // linhas em formato texto antes da troca.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  // Security headers. CSP desabilitado para nao quebrar o Swagger UI em dev;
  // os demais headers (nosniff, frameguard, HSTS, etc.) permanecem ativos.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.getHttpAdapter().getInstance().disable('x-powered-by');

  const allowedOrigins = (process.env.WEB_ORIGINS ?? 'http://localhost:5173,http://localhost:5174')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  // Swagger/OpenAPI expoe todo o surface da API e exemplos — desabilitado em
  // producao para evitar information disclosure.
  if (process.env.NODE_ENV !== 'production') {
    // Mesmo documento publicado em docs/contratos/openapi/os-service.yaml (US-F4-15).
    const document = criarDocumentoOpenApi(app);
    SwaggerModule.setup('api', app, document);
  }

  // Encerra recursos (ex.: conexao Prisma via onModuleDestroy) ao receber
  // SIGTERM/SIGINT — essencial para rolling deploys sem cortar requests em voo.
  app.enableShutdownHooks();

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
}
bootstrap();
