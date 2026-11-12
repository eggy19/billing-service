import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';

/**
 * Global JSON structured logger. Every log line carries service name and
 * (where available) the correlationId/tenantId passed in the meta object.
 * Jangan log body request/response, customer_name, atau claim `name` (BR-BL-04).
 */
@Global()
@Module({
  imports: [
    WinstonModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        level: config.get<string>('app.logLevel') ?? 'info',
        defaultMeta: {
          service: config.get<string>('app.serviceName') ?? 'billing-service',
        },
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.errors({ stack: true }),
          winston.format.json(),
        ),
        transports: [new winston.transports.Console()],
      }),
    }),
  ],
})
export class LoggerModule {}
