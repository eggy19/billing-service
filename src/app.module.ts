import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import configuration from './config/configuration';
import { buildTypeOrmOptions } from './config/database.config';
import { validateEnv } from './config/env.validation';
import { CommonModule } from './common/common.module';
import { DocumentNumberModule } from './common/document-number/document-number.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { PermissionGuard } from './common/guards/permission.guard';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { TenantContextMiddleware } from './common/middleware/tenant-context.middleware';
import { HealthController } from './health.controller';
import { LoggerModule } from './logger/logger.module';
import { PaymentMethodModule } from './modules/payment-method/payment-method.module';
import { SettingModule } from './modules/setting/setting.module';
import { ShiftModule } from './modules/shift/shift.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    LoggerModule,
    CommonModule,
    DocumentNumberModule,
    SettingModule,
    PaymentMethodModule,
    ShiftModule,
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => buildTypeOrmOptions(config),
    }),
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Health adalah liveness probe — tanpa token Gateway.
    consumer
      .apply(TenantContextMiddleware)
      .exclude('health', 'billing/health')
      .forRoutes('*');
  }
}
