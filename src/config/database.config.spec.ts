import { ConfigService } from '@nestjs/config';
import { buildTypeOrmOptions } from './database.config';

describe('buildTypeOrmOptions', () => {
  it.each(['development', 'test', 'production'])(
    'disables TypeORM query logging in %s (no raw SQL parameters in logs, BR-BL-04)',
    (env) => {
      const config = {
        get: (key: string) => (key === 'app.env' ? env : undefined),
      } as unknown as ConfigService;

      expect(buildTypeOrmOptions(config).logging).toBe(false);
    },
  );
});
