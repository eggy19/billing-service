import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { GatewayContext } from './gateway-auth.service';

export const GetGatewayContext = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): GatewayContext => {
    const req = ctx
      .switchToHttp()
      .getRequest<Request & { gatewayContext: GatewayContext }>();
    return req.gatewayContext;
  },
);
