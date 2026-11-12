import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContextData {
  tenantId: string;
  branchId: string;
  userId: string | null;
  roles: string[];
  /** Permission claim dari Internal JWT; selalu [] untuk route internal. */
  permissions: string[];
  /** Nama user dari claim `name`; null bila tidak ada (jangan di-log, BR-BL-04). */
  userName: string | null;
  correlationId: string;
  isInternal: boolean;
  sessionId: string;
  requestId: string;
}

/**
 * AsyncLocalStorage-backed request context so services can read the
 * tenant/branch/user without threading them through every method signature.
 *
 * Populated by TenantMiddleware (HTTP) and must be explicitly seeded for
 * background jobs (BullMQ) where there is no incoming request.
 */
export class RequestContext {
  private static readonly storage = new AsyncLocalStorage<RequestContextData>();

  static run<T>(data: RequestContextData, callback: () => T): T {
    return this.storage.run(data, callback);
  }

  static get(): RequestContextData | undefined {
    return this.storage.getStore();
  }

  /** Throws if no context — use when tenant/branch are required. */
  static require(): RequestContextData {
    const ctx = this.storage.getStore();
    if (!ctx) {
      throw new Error('RequestContext is not available in this scope');
    }
    return ctx;
  }

  static get tenantId(): string {
    return this.require().tenantId;
  }

  static get branchId(): string {
    return this.require().branchId;
  }

  static get userId(): string | null {
    return this.require().userId;
  }

  static get correlationId(): string {
    return this.get()?.correlationId ?? 'unknown';
  }
}
