import { SetMetadata } from '@nestjs/common';
import type { BillingPermission } from '../constants/permissions';

export const REQUIRE_PERMISSION_KEY = 'require_permission';
export const PERMISSION_EXEMPT_KEY = 'permission_exempt';

/**
 * Declares the permission a public handler needs (default-deny, BR-BL-02).
 * Satu argumen = tepat satu permission. Endpoint baca berdata-milik boleh
 * menyebut dua (`read`, `read_all`): salah satu cukup (any-of). Scope data
 * (milik sendiri vs semua) diterapkan di service layer, bukan di guard.
 */
export const RequirePermission = (...permissions: BillingPermission[]) =>
  SetMetadata(REQUIRE_PERMISSION_KEY, permissions);

/**
 * Explicit exemption from the permission guard. Only for `/health` and
 * `/billing/internal/*` — never for a user-facing handler.
 */
export const PermissionExempt = () => SetMetadata(PERMISSION_EXEMPT_KEY, true);
