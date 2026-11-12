import { UnauthorizedException } from '@nestjs/common';
import { Request, Response } from 'express';
import { RequestContext } from '../context/request-context';
import { BusinessException } from '../exceptions/business.exception';
import { TenantContextMiddleware } from './tenant-context.middleware';

// jose is ESM-only and not needed here; the verifier is stubbed per test.
jest.mock('../gateway-auth/gateway-auth.service', () => ({
  GatewayAuthService: class {},
}));

const TOKEN = 'internal-secret';
const T = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const U = '33333333-3333-4333-8333-333333333333';
const INTERNAL_URL = '/billing/internal/sales/x';

function makeReq(url: string, headers: Record<string, string> = {}): Request {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    originalUrl: url,
    header: (name: string) => lower[name.toLowerCase()],
  } as unknown as Request;
}

const res = () => ({ setHeader: jest.fn() }) as unknown as Response;
const internalHeaders = (extra: Record<string, string> = {}) => ({
  Authorization: `Bearer ${TOKEN}`,
  'X-Tenant-Id': T,
  'X-Branch-Id': B,
  ...extra,
});

describe('TenantContextMiddleware', () => {
  const gatewayAuth = { verify: jest.fn() };
  const config = { get: jest.fn().mockReturnValue(TOKEN) };
  let mw: TenantContextMiddleware;

  beforeEach(() => {
    jest.clearAllMocks();
    config.get.mockReturnValue(TOKEN);
    mw = new TenantContextMiddleware(gatewayAuth as never, config as never);
  });

  /** Runs the middleware and returns the RequestContext seen by next(). */
  async function run(req: Request) {
    let seen: ReturnType<typeof RequestContext.get>;
    await mw.use(req, res(), () => {
      seen = RequestContext.get();
    });
    return seen;
  }

  it('seeds context from headers on an internal route (no JWT, no roles/permissions)', async () => {
    const ctx = await run(
      makeReq(
        INTERNAL_URL,
        internalHeaders({ 'X-User-Id': U, 'X-Request-Id': 'req-1' }),
      ),
    );
    expect(ctx).toMatchObject({
      tenantId: T,
      branchId: B,
      userId: U,
      roles: [],
      permissions: [],
      isInternal: true,
      requestId: 'req-1',
    });
    expect(gatewayAuth.verify).not.toHaveBeenCalled();
  });

  it('X-User-Id is optional (userId null), also when empty', async () => {
    expect(
      (await run(makeReq(INTERNAL_URL, internalHeaders())))?.userId,
    ).toBeNull();
    expect(
      (await run(makeReq(INTERNAL_URL, internalHeaders({ 'X-User-Id': '' }))))
        ?.userId,
    ).toBeNull();
  });

  it('internal prefix match is case-insensitive', async () => {
    const ctx = await run(
      makeReq('/billing/INTERNAL/sales/x', internalHeaders()),
    );
    expect(ctx?.isInternal).toBe(true);
  });

  it('"internal" segment mid-path is NOT internal and requires X-User-Context', async () => {
    await expect(
      run(makeReq('/billing/sales/internal/x', internalHeaders())),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(gatewayAuth.verify).not.toHaveBeenCalled();
  });

  it('missing or wrong token -> 401 before reading context headers', async () => {
    await expect(
      run(makeReq(INTERNAL_URL, { 'X-Tenant-Id': T, 'X-Branch-Id': B })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      run(
        makeReq(INTERNAL_URL, {
          Authorization: 'Bearer wrong',
          'X-Tenant-Id': T,
          'X-Branch-Id': B,
        }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      run(makeReq(INTERNAL_URL, { Authorization: 'Bearer wrong' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects when INTERNAL_SERVICE_TOKEN is not configured', async () => {
    config.get.mockReturnValue(undefined);
    await expect(
      run(makeReq(INTERNAL_URL, internalHeaders())),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each([
    ['X-Tenant-Id missing', { 'X-Tenant-Id': '' }],
    ['X-Tenant-Id not UUID', { 'X-Tenant-Id': 'abc' }],
    ['X-Branch-Id missing', { 'X-Branch-Id': '' }],
    ['X-Branch-Id not UUID', { 'X-Branch-Id': 'abc' }],
    ['X-User-Id not UUID', { 'X-User-Id': 'abc' }],
  ])('%s -> 400 VALIDATION_ERROR', async (_label, override) => {
    await expect(
      run(makeReq(INTERNAL_URL, internalHeaders(override))),
    ).rejects.toMatchObject({
      constructor: BusinessException,
      code: 'VALIDATION_ERROR',
    });
  });

  it('public route without X-User-Context -> 401', async () => {
    await expect(run(makeReq('/billing/sales', {}))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('public route ignores X-Tenant-Id/X-Branch-Id and uses the JWT claims', async () => {
    gatewayAuth.verify.mockResolvedValue({
      sub: U,
      tenantId: 'jwt-tenant',
      branchId: 'jwt-branch',
      sessionId: 's1',
      requestId: 'r1',
      roles: ['KASIR'],
      permissions: ['billing.sale.create'],
      name: 'Siti',
    });
    const ctx = await run(
      makeReq('/billing/sales', {
        'X-User-Context': 'jwt',
        'X-Tenant-Id': 'T2',
        'X-Branch-Id': 'Q2',
      }),
    );
    expect(ctx).toMatchObject({
      tenantId: 'jwt-tenant',
      branchId: 'jwt-branch',
      userId: U,
      roles: ['KASIR'],
      permissions: ['billing.sale.create'],
      userName: 'Siti',
      isInternal: false,
    });
  });

  it('JWT without name -> userName null', async () => {
    gatewayAuth.verify.mockResolvedValue({
      sub: U,
      tenantId: 'jwt-tenant',
      branchId: 'jwt-branch',
      sessionId: 's1',
      requestId: 'r1',
      roles: [],
      permissions: [],
    });
    const ctx = await run(
      makeReq('/billing/sales', { 'X-User-Context': 'jwt' }),
    );
    expect(ctx?.userName).toBeNull();
  });

  it('invalid JWT -> 401', async () => {
    gatewayAuth.verify.mockRejectedValue(new Error('bad'));
    await expect(
      run(makeReq('/billing/sales', { 'X-User-Context': 'jwt' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
