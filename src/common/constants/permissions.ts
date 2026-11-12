/**
 * Katalog permission `billing.*` yang dipakai endpoint MVP (spec billing-mvp-spec §3).
 * Endpoint baru wajib memakai salah satu permission di sini, atau menambahkannya
 * (beserta matriks role di dokumentasi/rbac/role-dan-permission.md dan seed Gateway).
 * Permission lain di matriks (void, refund, report, dst.) belum dipakai di MVP.
 */
export const BILLING_PERMISSIONS = [
  'billing.shift.open',
  'billing.shift.close',
  'billing.shift.read',
  'billing.shift.read_all',
  'billing.sale.create',
  'billing.sale.read',
  'billing.sale.read_all',
] as const;

export type BillingPermission = (typeof BILLING_PERMISSIONS)[number];
