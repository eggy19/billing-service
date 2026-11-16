export default () => ({
  app: {
    port: parseInt(process.env.APP_PORT ?? process.env.PORT ?? '3002', 10),
    env: process.env.NODE_ENV ?? 'development',
    serviceName: process.env.SERVICE_NAME ?? 'billing-service',
    logLevel: process.env.LOG_LEVEL ?? 'info',
  },
  database: {
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    username: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD ?? 'postgres',
    name: process.env.DB_NAME ?? 'klinik',
    schema: process.env.DB_SCHEMA ?? 'billing',
  },
  jwt: {
    publicKeyPath: process.env.JWT_PUBLIC_KEY_PATH ?? 'certs/public.pem',
    issuer: process.env.JWT_ISSUER ?? 'gateway-identity-service',
    audience: process.env.JWT_AUDIENCE ?? 'billing-service',
  },
  security: {
    internalServiceToken: process.env.INTERNAL_SERVICE_TOKEN ?? '',
  },
  inventory: {
    // Billing -> Inventory langsung (bukan lewat Gateway), BR-IN-02.
    internalUrl: process.env.INVENTORY_INTERNAL_URL ?? 'http://localhost:3001',
  },
  cors: {
    // Comma-separated allowed origins. Empty = allow any origin (dev only).
    origins: process.env.CORS_ORIGINS ?? '',
  },
});
