import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import type { Logger } from 'winston';
import type { RequestContextData } from '../../common/context/request-context';
import { DocumentNumberService } from '../../common/document-number/document-number.service';
import { BusinessException } from '../../common/exceptions/business.exception';
import { PaymentMethod } from '../payment-method/entities/payment-method.entity';
import { Payment } from '../sale/entities/payment.entity';
import { Sale } from '../sale/entities/sale.entity';
import { ListShiftQueryDto } from './dto/shift.dto';
import { CashierShift } from './entities/cashier-shift.entity';
import { ShiftGuardService } from './shift-guard.service';
import { ShiftService } from './shift.service';

/**
 * Integrasi dengan PostgreSQL nyata (schema billing sudah di-migrate).
 * Hanya jalan bila `BILLING_IT=1`; suite biasa melewatinya. Memakai tenant
 * acak dan membersihkan semua barisnya di akhir.
 */
const describeDb = process.env.BILLING_IT === '1' ? describe : describe.skip;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const codeOf = (e: unknown) => (e as BusinessException).code;

describeDb('Shift (DB nyata): 1-OPEN, kunci tutup shift, ShiftGuard', () => {
  let ds: DataSource;
  let service: ShiftService;
  const guard = new ShiftGuardService();
  const tenantId = randomUUID();
  const branchId = randomUUID();
  const otherBranchId = randomUUID();
  const rina = randomUUID();
  const dewi = randomUUID();

  const ctxOf = (
    userId: string,
    over: Partial<RequestContextData> = {},
  ): RequestContextData => ({
    tenantId,
    branchId,
    userId,
    roles: [],
    permissions: [
      'billing.shift.open',
      'billing.shift.close',
      'billing.shift.read',
    ],
    userName: 'Kasir Uji',
    correlationId: 'it',
    isInternal: false,
    sessionId: 's',
    requestId: 'it',
    ...over,
  });

  beforeAll(async () => {
    const mod = await import('../../database/data-source');
    ds = mod.default;
    if (!ds.isInitialized) await ds.initialize();
    service = new ShiftService(ds, new DocumentNumberService(), {
      info: jest.fn(),
    } as unknown as Logger);
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    const schema = ds.getMetadata(CashierShift).schema as string;
    for (const t of [
      'payment',
      'sale',
      'cashier_shift',
      'payment_method',
      'document_number_sequence',
    ]) {
      await ds.query(`DELETE FROM "${schema}"."${t}" WHERE "tenant_id" = $1`, [
        tenantId,
      ]);
    }
    await ds.destroy();
  });

  async function insertSale(
    shiftId: string,
    status: Sale['status'],
    amount: number,
  ): Promise<string> {
    const res = await ds.manager.insert(Sale, {
      tenant_id: tenantId,
      branch_id: branchId,
      shift_id: shiftId,
      cashier_user_id: rina,
      cashier_name: 'Kasir Uji',
      source_type: 'OTC',
      status,
      idempotency_key: randomUUID(),
      request_hash: 'a'.repeat(64),
      subtotal: amount,
      discount_total: 0,
      tax_rate: 0,
      tax_total: 0,
      grand_total: amount,
      paid_total: status === 'PAID' ? amount : 0,
      tendered_amount: amount,
      request_items: [],
      change_amount: 0,
    });
    return res.identifiers[0].id as string;
  }

  it('AC-SH-02: dua buka shift bersamaan -> tepat satu sukses, satu BIL_002, satu OPEN di DB', async () => {
    const results = await Promise.allSettled([
      service.open(ctxOf(rina), { opening_cash: 1000 }),
      service.open(ctxOf(rina), { opening_cash: 1000 }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(codeOf(bad[0].reason)).toBe('BIL_002');
    const open = await ds.getRepository(CashierShift).count({
      where: {
        tenant_id: tenantId,
        branch_id: branchId,
        cashier_user_id: rina,
        status: 'OPEN',
      },
    });
    expect(open).toBe(1);

    // buka lagi saat OPEN -> BIL_002 juga (unique parsial)
    await expect(
      service.open(ctxOf(rina), { opening_cash: 0 }),
    ).rejects.toMatchObject({ code: 'BIL_002' });
  });

  it('AC-SG-01/02 + AC-SH-03/05/06: guard, kas seharusnya, NOWAIT, konversi PENDING, tutup', async () => {
    const current = await service.current(ctxOf(rina));
    const shiftId = current!.id;
    expect(current).toMatchObject({
      status: 'OPEN',
      cashier_name: 'Kasir Uji',
    });
    expect(current!.shift_number).toMatch(/^SHF-\d{8}-\d{4}$/);

    // --- ShiftGuard nyata ---
    // Tanpa transaksi aktif: error pemrograman.
    await expect(
      guard.lockOpenShiftForSale(ds.manager, {
        tenantId,
        branchId,
        userId: rina,
      }),
    ).rejects.toThrow('active transaction');
    // Kasir lain / cabang lain: BIL_003.
    await expect(
      ds.transaction((m) =>
        guard.lockOpenShiftForSale(m, { tenantId, branchId, userId: dewi }),
      ),
    ).rejects.toMatchObject({ code: 'BIL_003' });
    await expect(
      ds.transaction((m) =>
        guard.lockOpenShiftForSale(m, {
          tenantId,
          branchId: otherBranchId,
          userId: rina,
        }),
      ),
    ).rejects.toMatchObject({ code: 'BIL_003' });
    const ref = await ds.transaction((m) =>
      guard.lockOpenShiftForSale(m, { tenantId, branchId, userId: rina }),
    );
    expect(ref).toMatchObject({
      id: shiftId,
      cashierUserId: rina,
      cashierName: 'Kasir Uji',
    });
    await expect(
      ds.transaction((m) =>
        guard.isShiftOpenForFinalize(m, shiftId, {
          tenantId,
          branchId,
          userId: rina,
        }),
      ),
    ).resolves.toBe(true);
    await expect(
      ds.transaction((m) =>
        guard.isShiftOpenForFinalize(m, shiftId, {
          tenantId,
          branchId: otherBranchId,
          userId: rina,
        }),
      ),
    ).resolves.toBe(false);

    // --- tutup shift menunggu transaksi yang memegang FOR SHARE (AC-SG-01) ---
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    const holder = ds.transaction(async (m) => {
      await guard.lockOpenShiftForSale(m, { tenantId, branchId, userId: rina });
      held();
      await gate;
    });
    await holding;
    let closeDone = false;
    const closing = service
      .close(ctxOf(rina), shiftId, { closing_cash_counted: 1000 })
      .then((v) => {
        closeDone = true;
        return v;
      });
    await sleep(500);
    expect(closeDone).toBe(false); // menunggu kunci FOR SHARE milik holder
    release();
    await holder;
    const firstClose = await closing;
    expect(firstClose).toMatchObject({ status: 'CLOSED', cash_difference: 0 });

    // Setelah CLOSED: guard -> BIL_003, finalize -> false, tutup lagi -> BIL_004 (AC-SH-08).
    await expect(
      ds.transaction((m) =>
        guard.lockOpenShiftForSale(m, { tenantId, branchId, userId: rina }),
      ),
    ).rejects.toMatchObject({ code: 'BIL_003' });
    await expect(
      ds.transaction((m) =>
        guard.isShiftOpenForFinalize(m, shiftId, {
          tenantId,
          branchId,
          userId: rina,
        }),
      ),
    ).resolves.toBe(false);
    await expect(
      service.close(ctxOf(rina), shiftId, { closing_cash_counted: 1000 }),
    ).rejects.toMatchObject({ code: 'BIL_004' });
  });

  it('AC-SH-03/04/05/06/07/11: kas tunai PAID, FAILED tidak dihitung, NOWAIT -> BIL_010, PENDING dikonversi', async () => {
    const shift = await service.open(ctxOf(rina), { opening_cash: 200000 });
    const shiftId = shift.id;
    const [method] = await ds.manager.getRepository(PaymentMethod).save([
      ds.manager.getRepository(PaymentMethod).create({
        tenant_id: tenantId,
        branch_id: branchId,
        code: 'CASH',
        name: 'Tunai',
        is_cash: true,
        requires_reference: false,
        is_active: true,
      }),
    ]);
    for (const [amount, tendered] of [
      [11000, 20000],
      [43000, 50000],
      [32000, 32000],
    ]) {
      const saleId = await insertSale(shiftId, 'PAID', amount);
      await ds.manager.insert(Payment, {
        tenant_id: tenantId,
        branch_id: branchId,
        sale_id: saleId,
        shift_id: shiftId,
        payment_method_id: method.id,
        method_code: 'CASH',
        amount,
        tendered_amount: tendered,
        change_amount: tendered - amount,
        status: 'SUCCESS',
      });
    }
    await insertSale(shiftId, 'FAILED', 5000);
    const pendingId = await insertSale(shiftId, 'PENDING', 7000);

    // AC-SH-12: ringkasan
    const cur = await service.current(ctxOf(rina));
    expect(cur!.summary).toEqual({
      cash_sales_total: 86000,
      expected_cash: 286000,
      sale_count: 3,
      pending_count: 1,
      failed_count: 1,
      reconciliation_count: 0,
    });

    // AC-SH-11 / AC-SH-07: kasir lain tidak melihat / tidak bisa menutup
    await expect(service.findOne(ctxOf(dewi), shiftId)).rejects.toMatchObject({
      code: 'BIL_001',
    });
    await expect(
      service.close(ctxOf(dewi), shiftId, { closing_cash_counted: 1 }),
    ).rejects.toMatchObject({ code: 'BIL_001' });
    await expect(
      service.close(
        ctxOf(randomUUID(), {
          permissions: ['billing.shift.close', 'billing.shift.read_all'],
        }),
        shiftId,
        { closing_cash_counted: 1 },
      ),
    ).rejects.toMatchObject({ code: 'BIL_004' });
    // tenant lain
    await expect(
      service.findOne(ctxOf(rina, { tenantId: randomUUID() }), shiftId),
    ).rejects.toMatchObject({ code: 'BIL_001' });

    // AC-SH-04: selisih tanpa catatan -> BIL_011, tetap OPEN
    await expect(
      service.close(ctxOf(rina), shiftId, { closing_cash_counted: 280000 }),
    ).rejects.toMatchObject({ code: 'BIL_011' });
    expect((await service.findOne(ctxOf(rina), shiftId)).status).toBe('OPEN');

    // AC-SH-06: sale PENDING sedang dikunci checkout -> BIL_010 segera (NOWAIT), shift tetap OPEN
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    const schema = ds.getMetadata(CashierShift).schema as string;
    const checkout = ds.transaction(async (m) => {
      await m.query(
        `SELECT "id" FROM "${schema}"."sale" WHERE "id" = $1 FOR UPDATE NOWAIT`,
        [pendingId],
      );
      held();
      await gate;
    });
    await holding;
    const t0 = Date.now();
    const blocked = await service
      .close(ctxOf(rina), shiftId, { closing_cash_counted: 286000 })
      .catch((e: unknown) => e);
    expect(codeOf(blocked)).toBe('BIL_010');
    expect(Date.now() - t0).toBeLessThan(2000); // tidak menunggu
    expect((await service.findOne(ctxOf(rina), shiftId)).status).toBe('OPEN');
    release();
    await checkout;

    // Setelah checkout selesai: tutup berhasil, PENDING -> NEEDS_RECONCILIATION (AC-SH-05)
    const closed = await service.close(ctxOf(rina), shiftId, {
      closing_cash_counted: 280000,
      close_note: 'uang kembalian kurang',
    });
    expect(closed).toMatchObject({
      status: 'CLOSED',
      expected_cash: 286000,
      cash_difference: -6000,
      pending_converted_count: 1,
      close_note: 'uang kembalian kurang',
    });
    const sale = await ds
      .getRepository(Sale)
      .findOneByOrFail({ id: pendingId });
    expect(sale).toMatchObject({
      status: 'NEEDS_RECONCILIATION',
      failure_code: 'SHIFT_CLOSED_PENDING',
      paid_total: 0,
      grand_total: 7000,
      updated_by: rina,
    });
    const after = await service.findOne(ctxOf(rina), shiftId);
    expect(after.summary).toMatchObject({
      expected_cash: 286000,
      pending_count: 0,
      reconciliation_count: 1,
    });

    // AC-SH-11: daftar kasir hanya miliknya; AC-SH-10: read_all melihat semua
    const mine = await service.list(ctxOf(dewi), new ListShiftQueryDto());
    expect(mine.data).toHaveLength(0);
    const all = await service.list(
      ctxOf(dewi, { permissions: ['billing.shift.read_all'] }),
      new ListShiftQueryDto(),
    );
    expect(all.pagination.total).toBe(2);
    expect(all.data.every((s) => s.status === 'CLOSED')).toBe(true);

    // Shift yang di-soft-delete tidak muncul di daftar.
    await ds.getRepository(CashierShift).softDelete({ id: shiftId });
    const afterDelete = await service.list(
      ctxOf(dewi, { permissions: ['billing.shift.read_all'] }),
      new ListShiftQueryDto(),
    );
    expect(afterDelete.pagination.total).toBe(1);
    expect(afterDelete.data.map((s) => s.id)).not.toContain(shiftId);
  });
});
