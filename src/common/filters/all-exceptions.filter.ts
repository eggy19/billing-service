import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
} from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { Response } from 'express';
import { ERROR_CODES } from '../constants/error-codes';
import { RequestContext } from '../context/request-context';

interface ErrorEnvelope {
  success: false;
  code: string;
  message: string;
  errors?: { field: string; message: string }[];
  details?: Record<string, unknown>;
  timestamp: string;
}

/**
 * Renders every thrown error into the handbook's error envelope:
 *  - class-validator failures   -> VALIDATION_ERROR with field list
 *  - BusinessException/Http      -> their code + message
 *  - anything else               -> INTERNAL_SERVER_ERROR (stack logged, hidden from client)
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: string = ERROR_CODES.INTERNAL_SERVER_ERROR.code;
    let message: string = ERROR_CODES.INTERNAL_SERVER_ERROR.message;
    let fieldErrors: { field: string; message: string }[] | undefined;
    let details: Record<string, unknown> | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();

      if (typeof body === 'string') {
        message = body;
        code = this.codeFromStatus(status);
      } else if (typeof body === 'object' && body !== null) {
        const b = body as Record<string, unknown>;
        // class-validator / NestJS ValidationPipe shape
        if (Array.isArray(b.message)) {
          code = ERROR_CODES.VALIDATION_ERROR.code;
          message = ERROR_CODES.VALIDATION_ERROR.message;
          fieldErrors = (b.message as string[]).map((m) => ({
            field: m.split(' ')[0],
            message: m,
          }));
        } else {
          code = (b.code as string) ?? this.codeFromStatus(status);
          message = (b.message as string) ?? message;
          // Tambahan aditif BusinessException (errors per baris, details).
          if (Array.isArray(b.errors)) {
            fieldErrors = b.errors as { field: string; message: string }[];
          }
          if (typeof b.details === 'object' && b.details !== null) {
            details = b.details as Record<string, unknown>;
          }
        }
      }
    }

    if (status >= 500) {
      this.logger.error('Unhandled exception', {
        action: 'exception',
        correlationId: RequestContext.correlationId,
        message: exception instanceof Error ? exception.message : 'unknown',
        stack: exception instanceof Error ? exception.stack : undefined,
      });
    }

    const envelope: ErrorEnvelope = {
      success: false,
      code,
      message,
      ...(fieldErrors ? { errors: fieldErrors } : {}),
      ...(details ? { details } : {}),
      timestamp: new Date().toISOString(),
    };

    response.status(status).json(envelope);
  }

  private codeFromStatus(status: number): string {
    if (status === 401) {
      return ERROR_CODES.UNAUTHORIZED.code;
    }
    if (status === 400) {
      return ERROR_CODES.VALIDATION_ERROR.code;
    }
    return `HTTP_${status}`;
  }
}
