import type { EntityManager } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ShiftGuardService } from './shift-guard.service';

const actor = { tenantId: 't-A', branchId: 'b-P', userId: 'u-rina' };

function makeManager(rows: unknown[], inTransaction = true) {
  const query = jest.fn().mockResolvedValue(rows);
  const manager = {
    query,
    queryRunner: { isTransactionActive: inTransaction },
    connection: {
      getMetadata: () => ({ schema: 'billing', tableName: 'cashier_shift' }),
    },
  } as unknown as EntityManager;
  return { manager, query };
}

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('ShiftGuardService.lockOpenShiftForSale (AC-SG-01, BR-MD-03)', () => {
  it('mengunci shift OPEN milik actor dengan FOR SHARE di manager caller dan memetakan OpenShiftRef', async () => {
    const { manager, query } = makeManager([
      {
        id: 's1',
        shift_number: 'SHF-20261113-0001',
        cashier_user_id: 'u-rina',
        cashier_name: 'Rina',
      },
    ]);
    const ref = await new ShiftGuardService().lockOpenShiftForSale(
      manager,
      actor,
    );

    expect(ref).toEqual({
      id: 's1',
      shiftNumber: 'SHF-20261113-0001',
      cashierUserId: 'u-rina',
      cashierName: 'Rina',
    });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(norm(sql)).toBe(
      'SELECT "id", "shift_number", "cashier_user_id", "cashier_name" ' +
        'FROM "billing"."cashier_shift" ' +
        'WHERE "tenant_id" = $1 AND "branch_id" = $2 AND "cashier_user_id" = $3 ' +
        `AND "status" = 'OPEN' AND "deleted_at" IS NULL FOR SHARE`,
    );
    expect(params).toEqual(['t-A', 'b-P', 'u-rina']);
  });

  it('tidak ada shift OPEN (CLOSED / cabang lain / milik user lain) -> BIL_003', async () => {
    // Filter tenant+branch+kasir+status ada di SQL (assert di atas); baris kosong = tidak cocok.
    const { manager } = makeManager([]);
    const err = await new ShiftGuardService()
      .lockOpenShiftForSale(manager, actor)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BusinessException);
    expect((err as BusinessException).code).toBe('BIL_003');
  });

  it('tanpa transaksi aktif -> error pemrograman (bukan BusinessException) dan query tidak dijalankan', async () => {
    const { manager, query } = makeManager([], false);
    const err = await new ShiftGuardService()
      .lockOpenShiftForSale(manager, actor)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BusinessException);
    expect(query).not.toHaveBeenCalled();
  });

  it('manager tanpa queryRunner juga dianggap tanpa transaksi', async () => {
    const manager = { query: jest.fn() } as unknown as EntityManager;
    await expect(
      new ShiftGuardService().lockOpenShiftForSale(manager, actor),
    ).rejects.toThrow('active transaction');
  });
});

describe('ShiftGuardService.isShiftOpenForFinalize (AC-SG-02, BR-MD-04)', () => {
  it('true bila shift OPEN; SQL FOR SHARE dengan scope tenant+branch', async () => {
    const { manager, query } = makeManager([{ status: 'OPEN' }]);
    await expect(
      new ShiftGuardService().isShiftOpenForFinalize(manager, 's1', actor),
    ).resolves.toBe(true);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(norm(sql)).toBe(
      'SELECT "status" FROM "billing"."cashier_shift" ' +
        'WHERE "id" = $1 AND "tenant_id" = $2 AND "branch_id" = $3 ' +
        'AND "deleted_at" IS NULL FOR SHARE',
    );
    expect(params).toEqual(['s1', 't-A', 'b-P']);
  });

  it('false (tidak melempar) bila CLOSED', async () => {
    const { manager } = makeManager([{ status: 'CLOSED' }]);
    await expect(
      new ShiftGuardService().isShiftOpenForFinalize(manager, 's1', actor),
    ).resolves.toBe(false);
  });

  it('false (tidak melempar) bila tidak ditemukan (cabang Q / tenant B)', async () => {
    const { manager } = makeManager([]);
    await expect(
      new ShiftGuardService().isShiftOpenForFinalize(manager, 's1', actor),
    ).resolves.toBe(false);
  });

  it('tanpa transaksi aktif -> error pemrograman', async () => {
    const { manager, query } = makeManager([], false);
    await expect(
      new ShiftGuardService().isShiftOpenForFinalize(manager, 's1', actor),
    ).rejects.toThrow('active transaction');
    expect(query).not.toHaveBeenCalled();
  });
});
