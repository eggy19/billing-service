import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import type { Logger } from 'winston';
import type { RequestContextData } from '../../common/context/request-context';
import { DocumentNumberService } from '../../common/document-number/document-number.service';
import { BillingSetting } from '../setting/entities/billing-setting.entity';
import { BillingSettingService } from '../setting/billing-setting.service';
import { PaymentMethod } from '../payment-method/entities/payment-method.entity';
import { PaymentMethodController } from '../payment-method/payment-method.controller';
import { PaymentMethodService } from '../payment-method/payment-method.service';
import { CashierShift } from '../shift/entities/cashier-shift.entity';
import { ShiftGuardService } from '../shift/shift-guard.service';
import { ShiftService } from '../shift/shift.service';
import type { CreateSaleDto } from './dto/sale.dto';
import { Payment } from './entities/payment.entity';
import { Sale } from './entities/sale.entity';
import type {
  DispensingOutcome,
  DispensingRequest,
  InventoryDispensingClient,
} from './inventory/inventory-dispensing.port';
import { ListSaleQueryDto } from './dto/sale.dto';
import { SaleQueryService } from './sale-query.service';
import { SaleService } from './sale.service';

/**
 * Integrasi dengan PostgreSQL nyata (schema billing sudah di-migrate) dan FAKE
 * Inventory. Hanya jalan bila `BILLING_IT=1`; suite biasa melewatinya. Memakai
 * tenant/cabang acak dan membersihkan semua barisnya di akhir. Tidak menyentuh
 * Inventory sungguhan (itu BL-18).
 */
const describeDb = process.env.BILLING_IT === '1' ? describe : describe.skip;

const codeOf = (e: unknown) => (e as { code?: string }).code;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Outcome = DispensingOutcome | Promise<DispensingOutcome>;

class FakeInventory implements InventoryDispensingClient {
  calls: DispensingRequest[] = [];
  next?: (req: DispensingRequest) => Outcome;

  okBody(req: DispensingRequest, over: Record<string, unknown> = {}): unknown {
    const items = req.items.map((it, i) => ({
      lineNo: i + 1,
      itemId: it.item_id,
      unitId: it.unit_id,
      itemCode: `OBT-000${i + 1}`,
      itemName: `Obat ${i + 1}`,
      unitCode: 'STRIP',
      unitName: 'Strip',
      quantity: it.quantity,
      unitPrice: it.expected_unit_price,
      lineTotal: it.quantity * it.expected_unit_price,
      drugGroupCode: 'OBT_BEBAS',
      ...over,
    }));
    return {
      success: true,
      data: {
        dispensingId: randomUUID(),
        dispensingNumber: 'DSP-20261113-0007',
        grandTotal: items.reduce((s, i) => s + i.lineTotal, 0),
        items,
      },
    };
  }

  createDispensing(req: DispensingRequest): Promise<DispensingOutcome> {
    this.calls.push(req);
    if (this.next) return Promise.resolve(this.next(req));
    return Promise.resolve({
      kind: 'SUCCESS',
      httpStatus: 201,
      body: this.okBody(req),
    });
  }
}

describeDb('Checkout (DB nyata + fake Inventory): BL-16', () => {
  let ds: DataSource;
  let sales: SaleService;
  let queries: SaleQueryService;
  let shifts: ShiftService;
  let methods: PaymentMethodService;
  let settings: BillingSettingService;
  const inventory = new FakeInventory();
  const tenantId = randomUUID();
  const branchId = randomUUID();
  const otherTenant = randomUUID();
  const noop = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

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
      'billing.sale.create',
      'billing.sale.read',
    ],
    userName: 'Kasir Uji',
    correlationId: 'it',
    isInternal: false,
    sessionId: 's',
    requestId: 'it-req',
    ...over,
  });

  const dtoOf = (tendered = 20000): CreateSaleDto => ({
    customer_name: null,
    items: [
      {
        item_id: randomUUID(),
        unit_id: randomUUID(),
        quantity: 2,
        expected_unit_price: 5500,
      },
    ],
    payments: [{ method_code: 'CASH', tendered_amount: tendered }],
  });

  const count = async (table: string, extra = ''): Promise<number> => {
    const schema = ds.getMetadata(Sale).schema as string;
    const rows: { n: string }[] = await ds.query(
      `SELECT COUNT(*) AS n FROM "${schema}"."${table}" WHERE "tenant_id" = $1 ${extra}`,
      [tenantId],
    );
    return Number(rows[0].n);
  };

  beforeAll(async () => {
    const mod = await import('../../database/data-source');
    ds = mod.default;
    if (!ds.isInitialized) await ds.initialize();
    const numbers = new DocumentNumberService();
    settings = new BillingSettingService(ds.getRepository(BillingSetting));
    methods = new PaymentMethodService(ds.getRepository(PaymentMethod));
    queries = new SaleQueryService(ds, settings);
    shifts = new ShiftService(ds, numbers, noop as unknown as Logger);
    sales = new SaleService(
      ds,
      numbers,
      settings,
      methods,
      queries,
      new ShiftGuardService(),
      inventory,
      noop as unknown as Logger,
    );
    // Cabang uji PKP 11% dengan kepala struk.
    await settings.getOrCreate(tenantId, branchId);
    await ds.getRepository(BillingSetting).update(
      { tenant_id: tenantId, branch_id: branchId },
      {
        tax_rate: 11,
        receipt_header: 'APOTEK UJI',
        receipt_footer: 'Terima kasih',
      },
    );
  });

  beforeEach(() => {
    inventory.calls = [];
    inventory.next = undefined;
  });

  afterAll(async () => {
    if (!ds?.isInitialized) return;
    const schema = ds.getMetadata(Sale).schema as string;
    for (const t of [
      'payment',
      'sale_item',
      'sale',
      'cashier_shift',
      'payment_method',
      'billing_setting',
      'document_number_sequence',
    ]) {
      for (const tenant of [tenantId, otherTenant]) {
        await ds.query(
          `DELETE FROM "${schema}"."${t}" WHERE "tenant_id" = $1`,
          [tenant],
        );
      }
    }
    await ds.destroy();
  });

  it('AC-SL-01/02/12 + AC-SH-03: sukses, replay PAID, riwayat, dan tutup shift membaca kas dari payment', async () => {
    const rina = randomUUID();
    const dewi = randomUUID();
    const rc = ctxOf(rina);
    const shift = await shifts.open(rc, { opening_cash: 200000 });
    const key = randomUUID();
    const dto = dtoOf(20000);

    const first = await sales.checkout(rc, key, dto);
    expect(first.replayed).toBe(false);
    expect(first.sale).toMatchObject({
      status: 'PAID',
      source_type: 'OTC',
      shift_id: shift.id,
      shift_number: shift.shift_number,
      cashier_user_id: rina,
      cashier_name: 'Kasir Uji',
      subtotal: 11000,
      tax_rate: 11,
      tax_total: 1090.09,
      grand_total: 11000,
      paid_total: 11000,
      tendered_amount: 20000,
      change_amount: 9000,
      dispensing_number: 'DSP-20261113-0007',
      receipt: { header: 'APOTEK UJI', footer: 'Terima kasih' },
    });
    expect(first.sale.sale_number).toMatch(/^SAL-\d{8}-\d{4}$/);
    expect(first.sale.items).toHaveLength(1);
    expect(first.sale.items[0]).toMatchObject({
      line_no: 1,
      item_code: 'OBT-0001',
      unit_name: 'Strip',
      quantity: 2,
      unit_price: 5500,
      tax_amount: 1090.09,
      line_total: 11000,
      drug_group_code: 'OBT_BEBAS',
    });
    expect(first.sale.payments).toEqual([
      {
        method_code: 'CASH',
        method_name: 'Tunai',
        amount: 11000,
        tendered_amount: 20000,
        change_amount: 9000,
      },
    ]);

    // Inventory dipanggil sekali dengan referensi sale.
    expect(inventory.calls).toHaveLength(1);
    expect(inventory.calls[0]).toMatchObject({
      idempotency_key: `billing.sale:${first.sale.id}`,
      reference_type: 'billing.sale',
      reference_id: first.sale.id,
    });

    // payment: shift_id, payment_method_id, amount terisi benar (dibaca tutup shift)
    const pay = await ds.getRepository(Payment).findOneByOrFail({
      sale_id: first.sale.id,
    });
    expect(pay).toMatchObject({
      shift_id: shift.id,
      method_code: 'CASH',
      amount: 11000,
      status: 'SUCCESS',
    });
    const method = await ds
      .getRepository(PaymentMethod)
      .findOneByOrFail({ id: pay.payment_method_id });
    expect(method.is_cash).toBe(true);

    // replay PAID -> 200 replayed, sale sama, tanpa Inventory & tanpa sale baru
    const again = await sales.checkout(rc, key, dto);
    expect(again.replayed).toBe(true);
    expect(again.sale.id).toBe(first.sale.id);
    expect(inventory.calls).toHaveLength(1);
    expect(await count('sale', `AND "idempotency_key" = '${key}'`)).toBe(1);

    // key sama oleh kasir lain / isi berbeda -> BIL_009 tanpa data sale
    await expect(sales.checkout(ctxOf(dewi), key, dto)).rejects.toMatchObject({
      code: 'BIL_009',
    });
    await expect(
      sales.checkout(rc, key, {
        ...dto,
        payments: [{ method_code: 'CASH', tendered_amount: 30000 }],
      }),
    ).rejects.toMatchObject({ code: 'BIL_009' });

    // riwayat & detail (scope)
    const list = await queries.list(
      rc,
      Object.assign(new ListSaleQueryDto(), {}),
    );
    expect(list.data.map((s) => s.id)).toContain(first.sale.id);
    const detail = await queries.findOne(rc, first.sale.id);
    expect(detail.items).toHaveLength(1);
    await expect(
      queries.findOne(ctxOf(dewi), first.sale.id),
    ).rejects.toMatchObject({ code: 'BIL_005' });
    const dewiList = await queries.list(
      ctxOf(dewi),
      Object.assign(new ListSaleQueryDto(), {}),
    );
    expect(dewiList.data).toHaveLength(0);
    await expect(
      queries.findOne(
        {
          ...ctxOf(dewi),
          tenantId: otherTenant,
          permissions: ['billing.sale.read_all'],
        },
        first.sale.id,
      ),
    ).rejects.toMatchObject({ code: 'BIL_005' });
    const owner = await queries.list(
      ctxOf(randomUUID(), { permissions: ['billing.sale.read_all'] }),
      Object.assign(new ListSaleQueryDto(), {
        cashier_user_id: rina,
        status: 'PAID' as const,
      }),
    );
    expect(owner.data.map((s) => s.id)).toContain(first.sale.id);
    const bySearch = await queries.list(
      ctxOf(rina),
      Object.assign(new ListSaleQueryDto(), {
        q: first.sale.sale_number!.slice(-6),
      }),
    );
    expect(bySearch.data.map((s) => s.id)).toContain(first.sale.id);

    // nomor SAL berikutnya naik
    const second = await sales.checkout(rc, randomUUID(), dtoOf(11000));
    const n1 = Number(first.sale.sale_number!.slice(-4));
    const n2 = Number(second.sale.sale_number!.slice(-4));
    expect(n2).toBe(n1 + 1);

    // tutup shift: kas seharusnya = modal + 2 x 11.000 (tunai diterima tidak dihitung)
    const closed = await shifts.close(rc, shift.id, {
      closing_cash_counted: 222000,
    });
    expect(closed).toMatchObject({
      status: 'CLOSED',
      expected_cash: 222000,
      cash_difference: 0,
    });
    expect(closed.summary.sale_count).toBe(2);

    // setelah shift CLOSED: checkout -> BIL_003, tidak ada sale baru
    const before = await count('sale');
    await expect(
      sales.checkout(rc, randomUUID(), dtoOf()),
    ).rejects.toMatchObject({ code: 'BIL_003' });
    expect(await count('sale')).toBe(before);
  });

  it('AC-SL-03/15: uang kurang BIL_006 dan metode salah BIL_007 tidak menyimpan sale', async () => {
    const user = randomUUID();
    const c = ctxOf(user);
    await shifts.open(c, { opening_cash: 0 });
    const before = await count('sale');
    await expect(
      sales.checkout(c, randomUUID(), dtoOf(10000)),
    ).rejects.toMatchObject({
      code: 'BIL_006',
    });
    await expect(
      sales.checkout(c, randomUUID(), {
        ...dtoOf(),
        payments: [{ method_code: 'QRIS', tendered_amount: 20000 }],
      }),
    ).rejects.toMatchObject({ code: 'BIL_007' });
    expect(await count('sale')).toBe(before);
    expect(inventory.calls).toHaveLength(0);
  });

  it('AC-SL-04/05: ditolak Inventory -> sale FAILED, replay mengembalikan error + errors[] sama tanpa memanggil Inventory', async () => {
    const user = randomUUID();
    const c = ctxOf(user);
    await shifts.open(c, { opening_cash: 0 });
    const errors = [{ field: 'items[0]', message: 'Harga saat ini 6000.00' }];
    inventory.next = () => ({
      kind: 'REJECTED',
      httpStatus: 409,
      code: 'INV_062',
      errors,
    });
    const key = randomUUID();
    const dto = dtoOf();
    const first = await sales.checkout(c, key, dto).catch((e: unknown) => e);
    expect(codeOf(first)).toBe('BIL_012');
    const row = await ds.getRepository(Sale).findOneByOrFail({
      tenant_id: tenantId,
      idempotency_key: key,
    });
    expect(row).toMatchObject({
      status: 'FAILED',
      failure_code: 'INV_062',
      sale_number: null,
      dispensing_id: null,
      failure_errors: errors,
    });
    expect(await count('sale_item', `AND "sale_id" = '${row.id}'`)).toBe(0);
    expect(await count('payment', `AND "sale_id" = '${row.id}'`)).toBe(0);

    inventory.calls = [];
    const replay = await sales.checkout(c, key, dto).catch((e: unknown) => e);
    expect(codeOf(replay)).toBe('BIL_012');
    expect(
      (replay as { getResponse(): { errors: unknown } }).getResponse().errors,
    ).toEqual(errors);
    expect(inventory.calls).toHaveLength(0);

    // key baru dengan harga yang sama kini sukses
    inventory.next = undefined;
    const ok = await sales.checkout(c, randomUUID(), dto);
    expect(ok.sale.status).toBe('PAID');
  });

  it('AC-SL-06 + AC-SH-05: Inventory mati -> PENDING (503), retry key sama -> PAID; PENDING yang ditinggal jadi NEEDS_RECONCILIATION saat tutup shift', async () => {
    const user = randomUUID();
    const c = ctxOf(user);
    const shift = await shifts.open(c, { opening_cash: 100000 });

    inventory.next = () => ({
      kind: 'UNAVAILABLE',
      attempts: 3,
      reason: 'timeout',
    });
    const key = randomUUID();
    const dto = dtoOf();
    await expect(sales.checkout(c, key, dto)).rejects.toMatchObject({
      code: 'BIL_015',
    });
    const pending = await ds.getRepository(Sale).findOneByOrFail({
      tenant_id: tenantId,
      idempotency_key: key,
    });
    expect(pending.status).toBe('PENDING');
    expect(pending.sale_number).toBeNull();

    // retry key sama setelah Inventory hidup -> sale yang sama menjadi PAID
    inventory.next = undefined;
    const done = await sales.checkout(c, key, dto);
    expect(done.replayed).toBe(false);
    expect(done.sale.id).toBe(pending.id);
    expect(done.sale.status).toBe('PAID');
    expect(await count('sale', `AND "idempotency_key" = '${key}'`)).toBe(1);

    // sale PENDING lain yang ditinggalkan
    inventory.next = () => ({
      kind: 'UNAVAILABLE',
      attempts: 3,
      reason: 'http_503',
    });
    const abandonedKey = randomUUID();
    const abandonedDto = dtoOf();
    await expect(
      sales.checkout(c, abandonedKey, abandonedDto),
    ).rejects.toMatchObject({
      code: 'BIL_015',
    });

    const closed = await shifts.close(c, shift.id, {
      closing_cash_counted: 111000,
    });
    expect(closed.pending_converted_count).toBe(1);
    expect(closed.expected_cash).toBe(111000); // yang PENDING tidak dihitung

    inventory.calls = [];
    inventory.next = undefined;
    const e = await sales.checkout(c, abandonedKey, abandonedDto).catch(
      (x: unknown) =>
        x as {
          code: string;
          getResponse(): { details?: { saleId: string } };
        },
    );
    expect((e as { code: string }).code).toBe('BIL_016');
    expect(
      (e as { getResponse(): { details: { saleId: string } } }).getResponse()
        .details.saleId,
    ).toEqual(expect.any(String));
    expect(inventory.calls).toHaveLength(0);
  });

  it('AC-SL-08 + AC-SH-06: sale dikunci NOWAIT selama panggilan Inventory; request ganda dan tutup shift mendapat BIL_010, checkout tetap PAID', async () => {
    const user = randomUUID();
    const c = ctxOf(user);
    const shift = await shifts.open(c, { opening_cash: 0 });

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    inventory.next = async (req) => {
      await gate;
      return {
        kind: 'SUCCESS',
        httpStatus: 201,
        body: inventory.okBody(req),
      };
    };

    const key = randomUUID();
    const dto = dtoOf();
    const inFlight = sales.checkout(c, key, dto);
    for (let i = 0; i < 100 && inventory.calls.length === 0; i++)
      await sleep(50);
    expect(inventory.calls).toHaveLength(1);

    // request kedua dengan key sama saat yang pertama berjalan
    await expect(sales.checkout(c, key, dto)).rejects.toMatchObject({
      code: 'BIL_010',
    });
    expect(inventory.calls).toHaveLength(1); // Inventory tidak dipanggil dua kali

    // tutup shift saat checkout berjalan -> BIL_010, shift tetap OPEN
    await expect(
      shifts.close(c, shift.id, { closing_cash_counted: 11000 }),
    ).rejects.toMatchObject({ code: 'BIL_010' });
    const stillOpen = await ds
      .getRepository(CashierShift)
      .findOneByOrFail({ id: shift.id });
    expect(stillOpen.status).toBe('OPEN');

    release();
    const result = await inFlight;
    expect(result.sale.status).toBe('PAID');

    // setelah selesai, tutup shift berhasil dan sale PAID ikut dihitung
    const closed = await shifts.close(c, shift.id, {
      closing_cash_counted: 11000,
    });
    expect(closed).toMatchObject({ status: 'CLOSED', expected_cash: 11000 });
  });

  it('AC-SL-11: simpan langkah 7 gagal (DB nyata) -> rollback savepoint, NEEDS_RECONCILIATION, tanpa item/payment/nomor; retry -> BIL_016', async () => {
    const user = randomUUID();
    const c = ctxOf(user);
    const shift = await shifts.open(c, { opening_cash: 50000 });
    // itemName 300 karakter melanggar varchar(255) saat insert sale_item.
    inventory.next = (req) => ({
      kind: 'SUCCESS',
      httpStatus: 201,
      body: inventory.okBody(req, { itemName: 'x'.repeat(300) }),
    });
    const key = randomUUID();
    const dto = dtoOf();
    const err = await sales.checkout(c, key, dto).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('BIL_017');
    const details = (
      err as {
        getResponse(): { details: { saleId: string; saleNumber: null } };
      }
    ).getResponse().details;
    const row = await ds.getRepository(Sale).findOneByOrFail({
      tenant_id: tenantId,
      idempotency_key: key,
    });
    expect(details).toEqual({ saleId: row.id, saleNumber: null });
    expect(row).toMatchObject({
      status: 'NEEDS_RECONCILIATION',
      failure_code: 'FINALIZE_FAILED',
      sale_number: null,
      dispensing_id: null,
    });
    expect(await count('sale_item', `AND "sale_id" = '${row.id}'`)).toBe(0);
    expect(await count('payment', `AND "sale_id" = '${row.id}'`)).toBe(0);

    inventory.calls = [];
    inventory.next = undefined;
    await expect(sales.checkout(c, key, dto)).rejects.toMatchObject({
      code: 'BIL_016',
    });
    expect(inventory.calls).toHaveLength(0);

    // tidak dihitung ke kas shift
    const closed = await shifts.close(c, shift.id, {
      closing_cash_counted: 50000,
    });
    expect(closed).toMatchObject({ expected_cash: 50000, cash_difference: 0 });
    expect(closed.summary.reconciliation_count).toBe(1);
  });

  it('INV_063 dan total beda -> NEEDS_RECONCILIATION + BIL_017 di DB nyata', async () => {
    const user = randomUUID();
    const c = ctxOf(user);
    await shifts.open(c, { opening_cash: 0 });

    inventory.next = () => ({
      kind: 'REJECTED',
      httpStatus: 409,
      code: 'INV_063',
      errors: null,
    });
    const k1 = randomUUID();
    await expect(sales.checkout(c, k1, dtoOf())).rejects.toMatchObject({
      code: 'BIL_017',
    });
    const s1 = await ds
      .getRepository(Sale)
      .findOneByOrFail({ tenant_id: tenantId, idempotency_key: k1 });
    expect(s1).toMatchObject({
      status: 'NEEDS_RECONCILIATION',
      failure_code: 'INV_063',
    });

    inventory.next = (req) => ({
      kind: 'SUCCESS',
      httpStatus: 201,
      body: inventory.okBody(req, { unitPrice: 6000, lineTotal: 12000 }),
    });
    const k2 = randomUUID();
    await expect(sales.checkout(c, k2, dtoOf())).rejects.toMatchObject({
      code: 'BIL_017',
    });
    const s2 = await ds
      .getRepository(Sale)
      .findOneByOrFail({ tenant_id: tenantId, idempotency_key: k2 });
    expect(s2).toMatchObject({
      status: 'NEEDS_RECONCILIATION',
      failure_code: 'TOTAL_MISMATCH',
    });
    expect(await count('sale_item', `AND "sale_id" = '${s2.id}'`)).toBe(0);
  });

  it('AC-SL-08: dua checkout bersamaan dengan key sama -> satu PAID, satu BIL_010 atau replay, tepat satu sale', async () => {
    const user = randomUUID();
    const c = ctxOf(user);
    await shifts.open(c, { opening_cash: 0 });
    inventory.next = async (req) => {
      await sleep(300);
      return {
        kind: 'SUCCESS',
        httpStatus: 201,
        body: inventory.okBody(req),
      };
    };
    const key = randomUUID();
    const dto = dtoOf();
    const results = await Promise.allSettled([
      sales.checkout(c, key, dto),
      sales.checkout(c, key, dto),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const b of bad) expect(codeOf(b.reason)).toBe('BIL_010');
    expect(await count('sale', `AND "idempotency_key" = '${key}'`)).toBe(1);
    expect(
      await count(
        'sale',
        `AND "idempotency_key" = '${key}' AND "status" = 'PAID'`,
      ),
    ).toBe(1);
    expect(inventory.calls).toHaveLength(1);
  });

  it('AC-BL-04 / AC-SL-20: cabang baru, dua GET payment-methods paralel -> keduanya CASH, 1 setting + 1 metode', async () => {
    const newBranch = randomUUID();
    const controller = new PaymentMethodController(methods, settings);
    const c = ctxOf(randomUUID(), {
      tenantId: otherTenant,
      branchId: newBranch,
    });
    const [a, b] = await Promise.all([controller.list(c), controller.list(c)]);
    for (const r of [a, b]) {
      expect(r).toEqual([
        {
          id: expect.any(String) as string,
          code: 'CASH',
          name: 'Tunai',
          is_cash: true,
        },
      ]);
    }
    const schema = ds.getMetadata(Sale).schema as string;
    const cnt = async (t: string): Promise<number> => {
      const rows: { n: string }[] = await ds.query(
        `SELECT COUNT(*) AS n FROM "${schema}"."${t}" WHERE "tenant_id" = $1 AND "branch_id" = $2`,
        [otherTenant, newBranch],
      );
      return Number(rows[0].n);
    };
    expect(await cnt('billing_setting')).toBe(1);
    expect(await cnt('payment_method')).toBe(1);
    const setting = await ds
      .getRepository(BillingSetting)
      .findOneByOrFail({ tenant_id: otherTenant, branch_id: newBranch });
    expect(setting.tax_rate).toBe(0);

    // CASH dinonaktifkan -> [] dan checkout BIL_007 (AC-SL-20 / AC-SL-15)
    await ds
      .getRepository(PaymentMethod)
      .update(
        { tenant_id: otherTenant, branch_id: newBranch, code: 'CASH' },
        { is_active: false },
      );
    expect(await controller.list(c)).toEqual([]);
  });
});
