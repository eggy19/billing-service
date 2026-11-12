import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';
import { Request } from 'express';

/**
 * Constant-time check of an `Authorization: Bearer <token>` header against the
 * expected internal service token. Both sides are hashed first so the
 * comparison does not leak the token length.
 */
export function isValidInternalToken(
  authorization: string | undefined,
  expected: string | undefined,
): boolean {
  const header = authorization ?? '';
  const token = header.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : '';
  if (!expected || !token) return false;
  const digest = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(digest(token), digest(expected));
}

/**
 * Protects /internal/* endpoints. Service-to-service callers must present
 * `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`. No user/JWT auth here —
 * end-user auth is terminated at the Gateway.
 */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const expected = this.config.get<string>('security.internalServiceToken');
    if (!isValidInternalToken(req.header('Authorization'), expected)) {
      throw new UnauthorizedException('Invalid internal service token');
    }
    return true;
  }
}
