import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { CashierShift } from './entities/cashier-shift.entity';
import type { OpenShiftRef, ShiftActor, ShiftGuard } from './shift-guard.port';
import { assertActiveTransaction, qualifiedTable } from './shift-table.util';

/**
 * Implementasi nyata port `ShiftGuard` (BR-MD-02..04). Bekerja di transaksi milik
 * caller: tidak membuka, meng-commit, atau me-rollback transaksi sendiri.
 */
@Injectable()
export class ShiftGuardService implements ShiftGuard {
  async lockOpenShiftForSale(
    manager: EntityManager,
    actor: ShiftActor,
  ): Promise<OpenShiftRef> {
    assertActiveTransaction(manager, 'ShiftGuard.lockOpenShiftForSale');
    const table = qualifiedTable(manager, CashierShift);
    const rows: {
      id: string;
      shift_number: string;
      cashier_user_id: string;
      cashier_name: string | null;
    }[] = await manager.query(
      `SELECT "id", "shift_number", "cashier_user_id", "cashier_name"
         FROM ${table}
        WHERE "tenant_id" = $1 AND "branch_id" = $2 AND "cashier_user_id" = $3
          AND "status" = 'OPEN' AND "deleted_at" IS NULL
          FOR SHARE`,
      [actor.tenantId, actor.branchId, actor.userId],
    );
    const row = rows[0];
    if (!row) throw new BusinessException('BIL_003');
    return {
      id: row.id,
      shiftNumber: row.shift_number,
      cashierUserId: row.cashier_user_id,
      cashierName: row.cashier_name,
    };
  }

  async isShiftOpenForFinalize(
    manager: EntityManager,
    shiftId: string,
    actor: ShiftActor,
  ): Promise<boolean> {
    assertActiveTransaction(manager, 'ShiftGuard.isShiftOpenForFinalize');
    const table = qualifiedTable(manager, CashierShift);
    const rows: { status: string }[] = await manager.query(
      `SELECT "status"
         FROM ${table}
        WHERE "id" = $1 AND "tenant_id" = $2 AND "branch_id" = $3
          AND "deleted_at" IS NULL
          FOR SHARE`,
      [shiftId, actor.tenantId, actor.branchId],
    );
    return rows[0]?.status === 'OPEN';
  }
}
