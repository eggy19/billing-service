import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { GatewayContext } from './gateway-auth.service';

/** Asserts that the middleware already verified the Gateway JWT for this request. */
@Injectable()
export class GatewayJwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<Request & { gatewayContext?: GatewayContext }>();

    if (!req.gatewayContext) {
      throw new UnauthorizedException('Missing X-User-Context header');
    }
    return true;
  }
}
