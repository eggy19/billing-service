import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import type { ErrorFieldDetail } from '../../../common/exceptions/business.exception';
import type {
  DispensingOutcome,
  DispensingRequest,
  InventoryCallContext,
  InventoryDispensingClient,
} from './inventory-dispensing.port';

/** Anggaran waktu §4.10: 3 percobaan x 10 dtk + jeda 1 dtk dan 3 dtk = 34 dtk terburuk. */
export const INVENTORY_ATTEMPT_TIMEOUT_MS = 10_000;
export const INVENTORY_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];

const DISPENSING_PATH = '/inventory/internal/dispensing';

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function toFieldErrors(value: unknown): ErrorFieldDetail[] | null {
  if (!Array.isArray(value)) return null;
  const out: ErrorFieldDetail[] = [];
  for (const e of value) {
    const r = e as Record<string, unknown> | null;
    if (r && typeof r.field === 'string' && typeof r.message === 'string') {
      out.push({ field: r.field, message: r.message });
    }
  }
  return out;
}

/**
 * Client HTTP Inventory (BR-SL-05, BR-IN-02). Langsung ke `INVENTORY_INTERNAL_URL`
 * (bukan lewat Gateway) dengan `Bearer INTERNAL_SERVICE_TOKEN`. Retry dengan body
 * dan idempotency key yang sama hanya untuk timeout, error jaringan, dan 5xx;
 * 4xx tidak di-retry. Token, header, dan body tidak pernah di-log (BR-IN-04, BR-BL-04).
 */
@Injectable()
export class InventoryHttpClient implements InventoryDispensingClient {
  /** Dapat diganti di test (tanpa jaringan nyata / tanpa menunggu jeda). */
  fetchFn: typeof fetch = (input, init) => fetch(input, init);
  sleepFn: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    private readonly config: ConfigService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  async createDispensing(
    request: DispensingRequest,
    context: InventoryCallContext,
  ): Promise<DispensingOutcome> {
    const baseUrl = (
      this.config.get<string>('inventory.internalUrl') ?? ''
    ).replace(/\/+$/, '');
    const token =
      this.config.get<string>('security.internalServiceToken') ?? '';
    const maxAttempts = INVENTORY_RETRY_DELAYS_MS.length + 1;
    const body = JSON.stringify(request);
    let reason = 'unknown';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let status = 0;
      let text = '';
      try {
        const res = await this.fetchFn(`${baseUrl}${DISPENSING_PATH}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'X-Tenant-Id': context.tenantId,
            'X-Branch-Id': context.branchId,
            'X-User-Id': context.userId,
            'X-Request-Id': context.requestId,
          },
          body,
          // 3xx tidak diikuti: Bearer token tidak boleh ikut ke host lain, dan
          // hasilnya masuk cabang UNEXPECTED (NEEDS_RECONCILIATION).
          redirect: 'manual',
          signal: AbortSignal.timeout(INVENTORY_ATTEMPT_TIMEOUT_MS),
        });
        status = res.status;
        text = await res.text();
      } catch (err) {
        reason = isTimeout(err) ? 'timeout' : 'network_error';
        if (await this.backoff(attempt, maxAttempts, reason, context)) continue;
        return { kind: 'UNAVAILABLE', attempts: attempt, reason };
      }

      if (status >= 500) {
        reason = `http_${status}`;
        if (await this.backoff(attempt, maxAttempts, reason, context)) continue;
        return { kind: 'UNAVAILABLE', attempts: attempt, reason };
      }
      return this.classify(status, text);
    }
    return { kind: 'UNAVAILABLE', attempts: maxAttempts, reason };
  }

  /** true bila masih ada percobaan berikutnya (setelah menunggu jeda). */
  private async backoff(
    attempt: number,
    maxAttempts: number,
    reason: string,
    context: InventoryCallContext,
  ): Promise<boolean> {
    if (attempt >= maxAttempts) return false;
    this.logger.warn('inventory_retry', {
      requestId: context.requestId,
      tenantId: context.tenantId,
      branchId: context.branchId,
      userId: context.userId,
      saleId: context.saleId,
      attempt,
      reason,
    });
    await this.sleepFn(INVENTORY_RETRY_DELAYS_MS[attempt - 1]);
    return true;
  }

  private classify(status: number, text: string): DispensingOutcome {
    if (status >= 200 && status < 300) {
      return { kind: 'SUCCESS', httpStatus: status, body: parseJson(text) };
    }
    if (status >= 400 && status < 500) {
      const parsed = parseJson(text) as Record<string, unknown> | undefined;
      return {
        kind: 'REJECTED',
        httpStatus: status,
        code: typeof parsed?.code === 'string' ? parsed.code : null,
        errors: toFieldErrors(parsed?.errors),
      };
    }
    return { kind: 'UNEXPECTED', httpStatus: status };
  }
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}
