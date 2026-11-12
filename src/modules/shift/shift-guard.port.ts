import type { EntityManager } from 'typeorm';

/**
 * Port `ShiftGuard` (spec billing-mvp-spec BR-MD-02). Diimplementasi modul
 * `shift` (BL-13), dipakai modul `sale` (BL-16) lewat token SHIFT_GUARD.
 * Modul `sale` tidak boleh meng-import ShiftService/repository shift (BR-MD-07).
 * Tidak ada implementasi di file ini.
 */
export const SHIFT_GUARD = Symbol('SHIFT_GUARD');

export interface ShiftActor {
  tenantId: string;
  branchId: string;
  userId: string;
}

export interface OpenShiftRef {
  id: string;
  shiftNumber: string;
  cashierUserId: string;
  cashierName: string | null;
}

export interface ShiftGuard {
  /**
   * Langkah 4 (TX-A). Mengunci shift OPEN milik actor dengan FOR SHARE.
   * Tidak ada → BusinessException BIL_003. Wajib dalam transaksi aktif milik
   * caller (BR-MD-03); tanpa transaksi → error pemrograman (500).
   */
  lockOpenShiftForSale(
    manager: EntityManager,
    actor: ShiftActor,
  ): Promise<OpenShiftRef>;

  /**
   * Langkah 7 (TX-B). Membaca ulang shift dengan FOR SHARE. true bila masih
   * OPEN; false bila CLOSED / tidak ditemukan. Tidak melempar error (BR-MD-04).
   */
  isShiftOpenForFinalize(
    manager: EntityManager,
    shiftId: string,
    actor: ShiftActor,
  ): Promise<boolean>;
}
