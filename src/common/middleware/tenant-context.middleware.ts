import {
  Injectable,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import {
  GatewayAuthService,
  GatewayContext,
} from '../gateway-auth/gateway-auth.service';
import { RequestContext } from '../context/request-context';
import { BusinessException } from '../exceptions/business.exception';
import { isValidInternalToken } from '../guards/internal-token.guard';

/** Internal routes are recognised by prefix only (global prefix `billing`). */
const INTERNAL_PREFIX = '/billing/internal/';
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(
    private readonly gatewayAuth: GatewayAuthService,
    private readonly config: ConfigService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const requestPath = req.originalUrl.split('?')[0];
    const isInternal = requestPath.toLowerCase().startsWith(INTERNAL_PREFIX);

    // Internal endpoints skip JWT. The service token is validated first; only
    // then is the caller-supplied tenant/branch/user context trusted.
    if (isInternal) {
      const expected = this.config.get<string>('security.internalServiceToken');
      if (!isValidInternalToken(req.header('Authorization'), expected)) {
        throw new UnauthorizedException('Invalid internal service token');
      }

      const tenantId = this.requireUuidHeader(req, 'X-Tenant-Id');
      const branchId = this.requireUuidHeader(req, 'X-Branch-Id');
      const userIdHeader = req.header('X-User-Id');
      if (userIdHeader && !UUID_RE.test(userIdHeader)) {
        throw new BusinessException(
          'VALIDATION_ERROR',
          'X-User-Id must be a UUID',
        );
      }

      const correlationId = req.header('X-Request-Id') || randomUUID();
      res.setHeader('X-Request-Id', correlationId);
      RequestContext.run(
        {
          tenantId,
          branchId,
          userId: userIdHeader || null,
          roles: [],
          permissions: [],
          userName: null,
          correlationId,
          isInternal: true,
          sessionId: '',
          requestId: correlationId,
        },
        () => next(),
      );
      return;
    }

    const token = req.header('X-User-Context');
    if (!token) {
      throw new UnauthorizedException('Missing X-User-Context header');
    }

    let ctx: GatewayContext;
    try {
      ctx = await this.gatewayAuth.verify(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired gateway token');
    }

    res.setHeader('X-Request-Id', ctx.requestId);

    // Attach to request object so GatewayJwtGuard / GetGatewayContext can read it.
    (req as Request & { gatewayContext: GatewayContext }).gatewayContext = ctx;

    RequestContext.run(
      {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        userId: ctx.sub,
        roles: ctx.roles,
        permissions: ctx.permissions,
        userName: ctx.name ?? null,
        correlationId: ctx.requestId,
        isInternal: false,
        sessionId: ctx.sessionId,
        requestId: ctx.requestId,
      },
      () => next(),
    );
  }

  private requireUuidHeader(req: Request, name: string): string {
    const value = req.header(name);
    if (!value || !UUID_RE.test(value)) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        `${name} header must be a valid UUID`,
      );
    }
    return value;
  }
}
