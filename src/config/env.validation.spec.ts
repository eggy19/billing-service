import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  it('accepts an empty/dev environment (defaults live in configuration.ts)', () => {
    expect(() => validateEnv({})).not.toThrow();
    expect(() =>
      validateEnv({ NODE_ENV: 'development', INTERNAL_SERVICE_TOKEN: '' }),
    ).not.toThrow();
  });

  it('rejects malformed ports and schema', () => {
    expect(() => validateEnv({ DB_PORT: 'abc' })).toThrow(/DB_PORT/);
    expect(() => validateEnv({ APP_PORT: '70000' })).toThrow(/APP_PORT/);
    expect(() => validateEnv({ DB_SCHEMA: 'bill"ing' })).toThrow(/DB_SCHEMA/);
  });

  it('production requires a real internal token, DB password and explicit CORS', () => {
    expect(() => validateEnv({ NODE_ENV: 'production' })).toThrow(
      /INTERNAL_SERVICE_TOKEN.*DB_PASSWORD.*CORS_ORIGINS/,
    );
    expect(() =>
      validateEnv({
        NODE_ENV: 'production',
        INTERNAL_SERVICE_TOKEN: 'change-me',
        DB_PASSWORD: 'x',
        CORS_ORIGINS: 'https://app.example.com',
      }),
    ).toThrow(/INTERNAL_SERVICE_TOKEN/);
    expect(() =>
      validateEnv({
        NODE_ENV: 'production',
        INTERNAL_SERVICE_TOKEN: 'a-real-secret',
        DB_PASSWORD: 'x',
        CORS_ORIGINS: 'https://app.example.com',
      }),
    ).not.toThrow();
  });

  it('strict for anything except development/test/empty (typos like prod/Production)', () => {
    for (const NODE_ENV of ['prod', 'Production', 'staging', 'Development']) {
      expect(() => validateEnv({ NODE_ENV })).toThrow(/INTERNAL_SERVICE_TOKEN/);
    }
    expect(() => validateEnv({ NODE_ENV: 'test' })).not.toThrow();
    expect(() => validateEnv({ NODE_ENV: '' })).not.toThrow();
  });

  it('error message never echoes secret values', () => {
    const run = () =>
      validateEnv({
        NODE_ENV: 'staging',
        INTERNAL_SERVICE_TOKEN: 'sekret-value',
        DB_PORT: 'abc',
      });
    expect(run).toThrow(/DB_PORT/);
    expect(run).not.toThrow(/sekret-value/);
  });
});
