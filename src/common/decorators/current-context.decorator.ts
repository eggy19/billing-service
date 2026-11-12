import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { RequestContext, RequestContextData } from '../context/request-context';

/**
 * Injects the active RequestContext into a controller handler param.
 * Convenience over calling RequestContext.get() directly in controllers.
 */
export const CurrentContext = createParamDecorator(
  (_data: unknown, _ctx: ExecutionContext): RequestContextData | undefined =>
    RequestContext.get(),
);
