import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import {
  InternalTokenGuard,
  isValidInternalToken,
} from './internal-token.guard';

describe('isValidInternalToken (G12, constant-time)', () => {
  it('accepts the exact bearer token', () => {
    expect(isValidInternalToken('Bearer abc', 'abc')).toBe(true);
  });
  it('rejects wrong, missing, malformed, or unconfigured tokens', () => {
    expect(isValidInternalToken('Bearer abd', 'abc')).toBe(false);
    expect(isValidInternalToken('Bearer abcd', 'abc')).toBe(false);
    expect(isValidInternalToken(undefined, 'abc')).toBe(false);
    expect(isValidInternalToken('abc', 'abc')).toBe(false);
    expect(isValidInternalToken('Bearer ', 'abc')).toBe(false);
    expect(isValidInternalToken('Bearer abc', undefined)).toBe(false);
    expect(isValidInternalToken('Bearer ', '')).toBe(false);
  });
});

describe('InternalTokenGuard.canActivate', () => {
  const guard = new InternalTokenGuard({ get: () => 'abc' } as never);
  const ctx = (authorization?: string) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ header: () => authorization }),
      }),
    }) as unknown as ExecutionContext;

  it('returns true for a valid token', () => {
    expect(guard.canActivate(ctx('Bearer abc'))).toBe(true);
  });
  it('throws UnauthorizedException for a wrong token', () => {
    expect(() => guard.canActivate(ctx('Bearer nope'))).toThrow(
      UnauthorizedException,
    );
  });
});
