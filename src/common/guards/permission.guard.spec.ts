import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestContext, RequestContextData } from '../context/request-context';
import {
  PermissionExempt,
  RequirePermission,
} from '../decorators/require-permission.decorator';
import { BusinessException } from '../exceptions/business.exception';
import { PermissionGuard } from './permission.guard';

class SampleController {
  @RequirePermission('billing.sale.create')
  create() {}

  @RequirePermission('billing.sale.read', 'billing.sale.read_all')
  readEither() {}

  undeclared() {}
}

@PermissionExempt()
class ExemptController {
  anything() {}
}

const baseCtx: RequestContextData = {
  tenantId: 't1',
  branchId: 'b1',
  userId: 'u1',
  roles: [],
  permissions: [],
  userName: null,
  correlationId: 'c1',
  isInternal: false,
  sessionId: 's1',
  requestId: 'c1',
};

function exec(cls: new () => object, method: string): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => (cls.prototype as Record<string, () => void>)[method],
    getClass: () => cls,
  } as unknown as ExecutionContext;
}

describe('PermissionGuard (default-deny, always on)', () => {
  const logger = { warn: jest.fn() };
  const guard = new PermissionGuard(new Reflector(), logger as never);

  const check = (
    cls: new () => object,
    method: string,
    ctx?: Partial<RequestContextData>,
  ) => {
    const run = () => guard.canActivate(exec(cls, method));
    return ctx ? RequestContext.run({ ...baseCtx, ...ctx }, run) : run();
  };

  beforeEach(() => jest.clearAllMocks());

  it('allows when the declared permission is in the context', () => {
    expect(
      check(SampleController, 'create', {
        permissions: ['billing.sale.create'],
      }),
    ).toBe(true);
  });

  it('any-of: read OR read_all is enough', () => {
    expect(
      check(SampleController, 'readEither', {
        permissions: ['billing.sale.read'],
      }),
    ).toBe(true);
    expect(
      check(SampleController, 'readEither', {
        permissions: ['billing.sale.read_all'],
      }),
    ).toBe(true);
    expect(() =>
      check(SampleController, 'readEither', {
        permissions: ['billing.sale.create'],
      }),
    ).toThrow(BusinessException);
  });

  it('denies with 403 FORBIDDEN and does not leak the required permission', () => {
    try {
      check(SampleController, 'create', {
        permissions: ['billing.shift.read'],
      });
      fail('expected FORBIDDEN');
    } catch (e) {
      const ex = e as BusinessException;
      expect(ex).toBeInstanceOf(BusinessException);
      expect(ex.getStatus()).toBe(403);
      expect(ex.getResponse()).toEqual({
        code: 'FORBIDDEN',
        message: 'Anda tidak memiliki izin untuk aksi ini',
      });
      expect(JSON.stringify(ex.getResponse())).not.toContain(
        'billing.sale.create',
      );
      expect(logger.warn).toHaveBeenCalledWith(
        'permission_denied',
        expect.objectContaining({
          requiredPermission: ['billing.sale.create'],
        }),
      );
    }
  });

  it('denies when permissions = [] or there is no request context', () => {
    expect(() =>
      check(SampleController, 'create', { permissions: [] }),
    ).toThrow(BusinessException);
    expect(() => check(SampleController, 'create')).toThrow(BusinessException);
  });

  it('default-deny for a handler without declaration, even with permissions', () => {
    expect(() =>
      check(SampleController, 'undeclared', {
        permissions: ['billing.sale.create'],
      }),
    ).toThrow(BusinessException);
  });

  it('internal context does not bypass default-deny (needs @PermissionExempt)', () => {
    expect(() =>
      check(SampleController, 'create', { isInternal: true, permissions: [] }),
    ).toThrow(BusinessException);
    expect(check(ExemptController, 'anything', { isInternal: true })).toBe(
      true,
    );
  });

  it('@PermissionExempt controllers skip the check', () => {
    expect(check(ExemptController, 'anything')).toBe(true);
  });
});
