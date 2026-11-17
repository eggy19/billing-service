import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

export const buildTypeOrmOptions = (
  config: ConfigService,
): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: config.get<string>('database.host'),
  port: config.get<number>('database.port'),
  username: config.get<string>('database.username'),
  password: config.get<string>('database.password'),
  database: config.get<string>('database.name'),
  schema: config.get<string>('database.schema'),
  entities: [__dirname + '/../**/*.entity{.ts,.js}'],
  migrations: [__dirname + '/../database/migrations/*{.ts,.js}'],
  // Schema changes go through migrations only — never auto-sync in any env.
  synchronize: false,
  // Off in every env: TypeORM's error logger prints the raw SQL + parameters
  // (customer_name, cashier_name, request_items) — BR-BL-04. Query errors still
  // surface through AllExceptionsFilter (message only).
  logging: false,
});
