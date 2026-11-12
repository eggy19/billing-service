import { HttpException } from '@nestjs/common';
import {
  ERROR_CODES,
  ErrorCodeDef,
  ErrorCodeKey,
} from '../constants/error-codes';

/**
 * Domain/business rule violation tied to a catalog error code.
 * Thrown by services; rendered by AllExceptionsFilter into the standard
 * { success: false, code, message } envelope.
 */
export class BusinessException extends HttpException {
  readonly code: string;

  constructor(key: ErrorCodeKey, overrideMessage?: string) {
    const def: ErrorCodeDef = ERROR_CODES[key];
    super(
      { code: def.code, message: overrideMessage ?? def.message },
      def.status,
    );
    this.code = def.code;
  }
}
