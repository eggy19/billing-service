import { HttpException } from '@nestjs/common';
import {
  ERROR_CODES,
  ErrorCodeDef,
  ErrorCodeKey,
} from '../constants/error-codes';

/** Detail per baris/field di envelope error (`errors[]`). */
export interface ErrorFieldDetail {
  field: string;
  message: string;
}

/** Tambahan aditif untuk envelope error; kedua field opsional. */
export interface BusinessExceptionExtras {
  /** `errors[]` per baris, mis. dari Inventory (`field: "items[0]"`). */
  errors?: ErrorFieldDetail[];
  /** `details` bebas, mis. `{ saleId, saleNumber }` untuk BIL_016/BIL_017 (BR-PS-08). */
  details?: Record<string, unknown>;
}

/**
 * Domain/business rule violation tied to a catalog error code.
 * Thrown by services; rendered by AllExceptionsFilter into the standard
 * { success: false, code, message, errors?, details? } envelope.
 */
export class BusinessException extends HttpException {
  readonly code: string;

  constructor(
    key: ErrorCodeKey,
    overrideMessage?: string,
    extras?: BusinessExceptionExtras,
  ) {
    const def: ErrorCodeDef = ERROR_CODES[key];
    super(
      {
        code: def.code,
        message: overrideMessage ?? def.message,
        ...(extras?.errors ? { errors: extras.errors } : {}),
        ...(extras?.details ? { details: extras.details } : {}),
      },
      def.status,
    );
    this.code = def.code;
  }
}
