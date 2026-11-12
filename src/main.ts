import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));

  const config = app.get(ConfigService);

  // CORS — origins from env (comma-separated). Empty = reflect any origin (dev).
  const corsOrigins = (config.get<string>('cors.origins') ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-User-Context',
      'X-Request-Id',
    ],
    exposedHeaders: ['X-Request-Id'],
    credentials: true,
  });

  // Gateway meneruskan /api/v1/billing/* sebagai /billing/*. Health probe di /health
  // dan /billing/health tidak diberi prefix tambahan.
  app.setGlobalPrefix('billing', { exclude: ['health', 'billing/health'] });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Billing Service')
    .setDescription('Shift kasir, penjualan, pembayaran.')
    .setVersion('0.1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'internal-token')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = config.get<number>('app.port') ?? 3002;
  await app.listen(port);
}

void bootstrap();
