import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { RequestContext } from '../context/request-context';
import {
  PERMISSION_EXEMPT_KEY,
  REQUIRE_PERMISSION_KEY,
} from '../decorators/require-permission.decorator';
import { BusinessException } from '../exceptions/business.exception';

/**
 * Global default-deny permission guard (BR-BL-02). Selalu aktif — tidak ada
 * flag rollout seperti Inventory karena Gateway sudah mengirim claim.
 * - `@PermissionExempt()` handlers/controllers (health, `/billing/internal/*`) are skipped.
 * - Any other handler needs one of its declared permissions in
 *   `RequestContext.permissions`; handler tanpa deklarasi ditolak.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const targets = [context.getHandler(), context.getClass()];
    if (
      this.reflector.getAllAndOverride<boolean>(PERMISSION_EXEMPT_KEY, targets)
    ) {
      return true;
    }

    // Route internal tidak di-bypass di sini: handler `/billing/internal/*` wajib
    // memakai @PermissionExempt() (CLAUDE.md), sehingga handler tanpa dekorator tetap ditolak.
    const ctx = RequestContext.get();

    const required =
      this.reflector.get<string[] | undefined>(
        REQUIRE_PERMISSION_KEY,
        context.getHandler(),
      ) ?? [];
    if (required.some((p) => ctx?.permissions?.includes(p))) return true;

    // Required permission is logged, never returned to the client.
    this.logger.warn('permission_denied', {
      action: context.getHandler().name,
      module: context.getClass().name,
      correlationId: RequestContext.correlationId,
      requiredPermission: required.length > 0 ? required : null,
    });
    throw new BusinessException('FORBIDDEN');
  }
}
