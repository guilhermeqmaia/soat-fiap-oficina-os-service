import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CoreModule } from '@guilhermeqmaia/oficina-kit/core';
import { AuthModule as KitAuthModule } from '@guilhermeqmaia/oficina-kit/auth';
import { CorrelationIdMiddleware, LoggerModule } from '@guilhermeqmaia/oficina-kit/logging';
import { MetricsModule } from '@guilhermeqmaia/oficina-kit/metrics';
import { HealthModule } from '@guilhermeqmaia/oficina-kit/health';
import { InProcessMessagingModule } from '@guilhermeqmaia/oficina-kit/messaging';
import { HttpInternoModule } from '@guilhermeqmaia/oficina-kit/http';
import { validateEnv } from './config/env.validation';
import { PRODUCER_NAME, SERVICE_NAME } from './config/service-name';
import { httpInternoConfig } from './config/servicos.config';
import { THROTTLER_LIMIT, THROTTLER_TTL_MS, shouldSkipThrottling } from './config/throttler.config';
import { PrismaHealthIndicator } from './health/prisma-health.indicator';
import { SharedModule } from './shared/shared.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { ClienteModule } from './cliente/cliente.module';
import { VeiculoModule } from './veiculo/veiculo.module';
import { OrdemDeServicoModule } from './ordem-de-servico/ordem-de-servico.module';
import { UsuarioModule } from './usuario/usuario.module';
import { NotificacaoModule } from './notificacao/notificacao.module';
import { ObservabilidadeModule } from './observabilidade/observabilidade.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    // --- infraestrutura comum aos microsservicos (ADR-0010) ---
    CoreModule,
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        serviceName: SERVICE_NAME,
        nodeEnv: config.get<string>('NODE_ENV'),
        level: config.get<string>('LOG_LEVEL'),
      }),
    }),
    KitAuthModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        issuer: config.get<string>('JWT_ISSUER'),
      }),
    }),
    MetricsModule.forRoot({ serviceName: SERVICE_NAME }),
    HealthModule.forRoot({ imports: [PrismaModule], indicators: [PrismaHealthIndicator] }),
    // Eventos de dominio in-process (notificacao, audit log, metricas).
    InProcessMessagingModule,
    // Fase 4 (US-F4-18 / RFC-0008): chamadas HTTP diretas a Execucao e ao Billing
    // com JWT de servico, correlacao e retry. Enderecos em config/servicos.config.ts.
    HttpInternoModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        servico: PRODUCER_NAME,
        jwtSecret: config.getOrThrow<string>('JWT_SECRET'),
        issuer: config.get<string>('JWT_ISSUER'),
        ...httpInternoConfig(),
      }),
    }),
    // Rate limiting global (anti brute-force/DoS). Desabilitado sob jest
    // (JEST_WORKER_ID), sob THROTTLER_DISABLED=true (testes de carga) e nas
    // rotas de infra (/health, /metrics) consumidas pelo cluster.
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: THROTTLER_TTL_MS, limit: THROTTLER_LIMIT }],
      skipIf: (context) => shouldSkipThrottling(process.env, context),
    }),
    // --- este servico ---
    SharedModule,
    PrismaModule,
    AuthModule,
    UsuarioModule,
    ClienteModule,
    VeiculoModule,
    OrdemDeServicoModule,
    NotificacaoModule,
    ObservabilidadeModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
