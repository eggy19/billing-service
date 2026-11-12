import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { PaginatedResult } from '../dto/pagination.dto';
import { RESPONSE_MESSAGE_KEY } from '../decorators/response-message.decorator';
import { toCamelCaseDeep } from '../utils/case.util';

interface SuccessEnvelope {
  success: true;
  message: string;
  data: unknown;
  pagination?: unknown;
  timestamp: string;
}

/**
 * Wraps every successful handler return value in the standard envelope.
 * PaginatedResult is unwrapped into top-level `data` + `pagination`.
 * Already-shaped responses (success flag present) are passed through untouched.
 */
@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const message =
      this.reflector.get<string>(RESPONSE_MESSAGE_KEY, context.getHandler()) ??
      'Success';

    return next.handle().pipe(
      map((payload): unknown => {
        // Pass through anything already wrapped (e.g. health checks).
        if (
          payload &&
          typeof payload === 'object' &&
          'success' in (payload as Record<string, unknown>)
        ) {
          return payload;
        }

        const envelope: SuccessEnvelope = {
          success: true,
          message,
          data: toCamelCaseDeep(payload ?? null),
          timestamp: new Date().toISOString(),
        };

        if (payload instanceof PaginatedResult) {
          envelope.data = toCamelCaseDeep(payload.data);
          envelope.pagination = payload.pagination;
        }

        return envelope;
      }),
    );
  }
}
