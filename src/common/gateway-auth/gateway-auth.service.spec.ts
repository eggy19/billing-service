import { importSPKI, jwtVerify } from 'jose';
import { GatewayAuthService } from './gateway-auth.service';

// jose is ESM-only; the verifier is mocked.
jest.mock('jose', () => ({ importSPKI: jest.fn(), jwtVerify: jest.fn() }));

const U = '33333333-3333-4333-8333-333333333333';
const T = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const BASE = {
  sub: U,
  tenantId: T,
  branchId: B,
  sessionId: 's1',
  requestId: 'r1',
};

describe('GatewayAuthService.verify', () => {
  const verify = jwtVerify as unknown as jest.Mock;
  const importKey = importSPKI as unknown as jest.Mock;
  const config = {
    get: jest.fn(
      (key: string) =>
        ({
          'jwt.publicKeyPath': 'certs/public.pem',
          'jwt.issuer': 'gateway-identity-service',
          'jwt.audience': 'billing-service',
        })[key],
    ),
  };
  const service = new GatewayAuthService(config as never);

  beforeAll(async () => {
    importKey.mockResolvedValue({});
    await service.onModuleInit();
  });

  const withPayload = (extra: Record<string, unknown>) => {
    verify.mockResolvedValue({ payload: { ...BASE, ...extra } });
    return service.verify('token');
  };

  it('verifies EdDSA only, with issuer gateway-identity-service and aud billing-service', async () => {
    await withPayload({});
    expect(importKey).toHaveBeenCalledWith(expect.any(String), 'EdDSA');
    expect(verify).toHaveBeenCalledWith('token', expect.anything(), {
      issuer: 'gateway-identity-service',
      audience: 'billing-service',
      algorithms: ['EdDSA'],
      requiredClaims: ['exp', 'sub', 'tenantId', 'branchId', 'requestId'],
    });
  });

  it.each(['sub', 'tenantId', 'branchId', 'requestId'])(
    'missing %s claim -> 401 (not undefined context)',
    async (claim) => {
      await expect(withPayload({ [claim]: undefined })).rejects.toMatchObject({
        status: 401,
      });
    },
  );

  it.each([
    ['sub', 'u1'],
    ['tenantId', 'not-a-uuid'],
    ['branchId', 42],
    ['requestId', ''],
    ['requestId', 7],
  ])('invalid %s=%j -> 401', async (claim, value) => {
    await expect(withPayload({ [claim]: value })).rejects.toMatchObject({
      status: 401,
    });
  });

  it('maps sub, tenantId, branchId, roles, permissions and name claims', async () => {
    const ctx = await withPayload({
      roles: ['KASIR'],
      permissions: ['billing.sale.create'],
      name: 'Siti',
    });
    expect(ctx).toMatchObject({
      sub: U,
      tenantId: T,
      branchId: B,
      roles: ['KASIR'],
      permissions: ['billing.sale.create'],
      name: 'Siti',
    });
  });

  it('JWT without roles/permissions -> []', async () => {
    const ctx = await withPayload({});
    expect(ctx.roles).toEqual([]);
    expect(ctx.permissions).toEqual([]);
    expect(ctx.name).toBeUndefined();
  });

  it.each([['x'], [{ a: 1 }], [[1, 2]], [['ok', 3]], [null]])(
    'non string-array claim %j -> []',
    async (bad) => {
      const ctx = await withPayload({ roles: bad, permissions: bad });
      expect(ctx.roles).toEqual([]);
      expect(ctx.permissions).toEqual([]);
    },
  );

  it('ignores a non-string name', async () => {
    expect((await withPayload({ name: 5 })).name).toBeUndefined();
  });

  it('verification failure (wrong aud/iss/alg/exp) -> 401', async () => {
    verify.mockRejectedValue(new Error('"aud" claim check failed'));
    await expect(service.verify('token')).rejects.toMatchObject({
      status: 401,
    });
  });
});
