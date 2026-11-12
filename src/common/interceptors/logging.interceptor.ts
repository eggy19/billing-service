import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request } from 'express';
import { RequestContext } from '../context/request-context';

/** Emits one structured INFO log per request with timing and identity context. */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const start = Date.now();
    const ctx = RequestContext.get();

    // Tanpa query string dan tanpa body (BR-BL-04).
    const meta = (): Record<string, unknown> => ({
      module: context.getClass().name,
      action: context.getHandler().name,
      method: req.method,
      path: req.path,
      durationMs: Date.now() - start,
      userId: ctx?.userId ?? null,
      tenantId: ctx?.tenantId ?? null,
      branchId: ctx?.branchId ?? null,
      requestId: ctx?.requestId ?? 'unknown',
    });

    return next.handle().pipe(
      tap({
        next: () => this.logger.info('request_completed', meta()),
        error: (err: unknown) =>
          this.logger.warn('request_failed', {
            ...meta(),
            status: err instanceof HttpException ? err.getStatus() : 500,
          }),
      }),
    );
  }
}
