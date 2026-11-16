import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'winston';
import type { RequestContextData } from '../../common/context/request-context';
import type { DocumentNumberService } from '../../common/document-number/document-number.service';
import { BusinessException } from '../../common/exceptions/business.exception';
import type { PaymentMethod } from '../payment-method/entities/payment-method.entity';
import type { PaymentMethodService } from '../payment-method/payment-method.service';
import type { BillingSettingService } from '../setting/billing-setting.service';
import type { CreateSaleDto } from './dto/sale.dto';
import { Payment } from './entities/payment.entity';
import { SaleItem } from './entities/sale-item.entity';
import { Sale } from './entities/sale.entity';
import type {
  DispensingOutcome,
  DispensingRequest,
} from './inventory/inventory-dispensing.port';
import { computeRequestHash } from './sale-calc.util';
import type { SaleQueryService } from './sale-query.service';
import { SaleService, mapRejection } from './sale.service';

/** Menolak dengan nilai apa adanya (mis. objek error pg `{ code: '55P03' }`). */
const rejectWith = (reason: unknown): Promise<never> =>
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
  Promise.reject(reason);

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const KEY = '5b1d7c2e-8a7f-4f3e-9c55-2f1f0c9a0e11';
const NOW = new Date('2026-11-13T03:15:21.000Z');
const NOWAIT_SQL =
  'SELECT "status" FROM "billing"."sale" WHERE "id" = $1 AND "tenant_id" = $2 AND "branch_id" = $3 AND "deleted_at" IS NULL FOR UPDATE NOWAIT';

const TABLES = new Map<unknown, string>([
  [Sale, 'sale'],
  [SaleItem, 'sale_item'],
  [Payment, 'payment'],
]);

const DTO = {
  customer_name: null,
  items: [
    {
      item_id: 'it-1',
      unit_id: 'un-1',
      quantity: 2,
      expected_unit_price: 5500,
    },
  ],
  payments: [{ method_code: 'CASH', tendered_amount: 20000 }],
} as CreateSaleDto;

const hashOf = (dto: CreateSaleDto, branchId = 'b-P') =>
  computeRequestHash({
    branchId,
    customerName: dto.customer_name ?? null,
    items: dto.items,
    payments: dto.payments,
  });
const HASH = hashOf(DTO);

function ctx(over: Partial<RequestContextData> = {}): RequestContextData {
  return {
    tenantId: 't-A',
    branchId: 'b-P',
    userId: 'u-rina',
    roles: ['KASIR'],
    permissions: ['billing.sale.create'],
    userName: 'Rina',
    correlationId: 'req-1',
    isInternal: false,
    sessionId: 's',
    requestId: 'req-1',
    ...over,
  };
}

function saleRow(over: Partial<Sale> = {}): Sale {
  return {
    id: 'sale-1',
    tenant_id: 't-A',
    branch_id: 'b-P',
    sale_number: null,
    shift_id: 'sh-1',
    cashier_user_id: 'u-rina',
    status: 'PENDING',
    idempotency_key: KEY,
    request_hash: HASH,
    request_items: DTO.items.map((i) => ({ ...i })),
    tax_rate: 11,
    grand_total: 11000,
    tendered_amount: 20000,
    failure_code: null,
    failure_message: null,
    failure_errors: null,
    ...over,
  } as Sale;
}

function okBody(
  req: DispensingRequest,
  over: Record<string, unknown> = {},
  priceOf: (i: number) => number = (i) => req.items[i].expected_unit_price,
): unknown {
  const items = req.items.map((it, i) => ({
    lineNo: i + 1,
    itemId: it.item_id,
    unitId: it.unit_id,
    itemCode: `OBT-000${i + 1}`,
    itemName: `Obat ${i + 1}`,
    unitCode: 'STRIP',
    unitName: 'Strip',
    quantity: it.quantity,
    unitPrice: priceOf(i),
    lineTotal: it.quantity * priceOf(i),
    drugGroupCode: 'OBT_BEBAS',
  }));
  return {
    success: true,
    data: {
      dispensingId: 'd-1',
      dispensingNumber: 'DSP-20261113-0007',
      replayed: false,
      grandTotal: items.reduce((s, i) => s + i.lineTotal, 0),
      items,
      ...over,
    },
  };
}

interface Env {
  /** Hasil berurutan pencarian sale by key. */
  found?: Array<Sale | null>;
  saveError?: unknown;
  lockError?: unknown;
  lockStatus?: string;
  fresh?: Sale;
  insertError?: { entity: unknown; error: unknown };
  updateError?: (patch: Record<string, unknown>) => unknown;
  nextError?: unknown;
  shiftOpen?: boolean;
  guardError?: unknown;
  outcome?: DispensingOutcome | ((req: DispensingRequest) => DispensingOutcome);
  method?: Partial<PaymentMethod> | null;
  taxRate?: number;
}

function make(env: Env = {}) {
  const events: string[] = [];
  const found = [...(env.found ?? [])];
  const queries: { sql: string; params: unknown[] }[] = [];
  const updates: {
    where: Record<string, unknown>;
    patch: Record<string, unknown>;
  }[] = [];
  const inserts: { entity: unknown; values: unknown }[] = [];

  const manager = {
    queryRunner: { isTransactionActive: true },
    connection: {
      getMetadata: (e: unknown) => ({
        schema: 'billing',
        tableName: TABLES.get(e),
      }),
    },
    query: jest.fn((sql: string, params: unknown[] = []) => {
      const text = norm(sql);
      queries.push({ sql: text, params });
      if (text.includes('NOWAIT')) {
        events.push('sql:NOWAIT');
        if (env.lockError) return rejectWith(env.lockError);
        return Promise.resolve([{ status: env.lockStatus ?? 'PENDING' }]);
      }
      if (text.startsWith('SAVEPOINT')) events.push('sql:SAVEPOINT');
      if (text.startsWith('RELEASE')) events.push('sql:RELEASE');
      if (text.startsWith('ROLLBACK TO')) events.push('sql:ROLLBACK');
      return Promise.resolve([]);
    }),
    create: jest.fn((_e: unknown, v: Record<string, unknown>) => ({ ...v })),
    save: jest.fn((_e: unknown, v: Record<string, unknown>) => {
      events.push('save');
      if (env.saveError) return rejectWith(env.saveError);
      return Promise.resolve({ ...v, id: 'sale-1' });
    }),
    findOneOrFail: jest.fn(() => Promise.resolve(env.fresh)),
    update: jest.fn(
      (
        _e: unknown,
        where: Record<string, unknown>,
        patch: Record<string, unknown>,
      ) => {
        events.push(`update:${String(patch.status)}`);
        updates.push({ where, patch });
        const err = env.updateError?.(patch);
        return err ? rejectWith(err) : Promise.resolve();
      },
    ),
    insert: jest.fn((entity: unknown, values: unknown) => {
      events.push(`insert:${entity === SaleItem ? 'SaleItem' : 'Payment'}`);
      inserts.push({ entity, values });
      if (env.insertError && env.insertError.entity === entity) {
        return rejectWith(env.insertError.error);
      }
      return Promise.resolve();
    }),
  };

  const repoFindOne = jest.fn(() => Promise.resolve(found.shift() ?? null));
  const repoUpdate = jest.fn(() => Promise.resolve());
  const dataSource = {
    transaction: jest.fn((cb: (m: typeof manager) => Promise<unknown>) =>
      cb(manager),
    ),
    getRepository: () => ({ findOne: repoFindOne, update: repoUpdate }),
  };

  const guard = {
    lockOpenShiftForSale: jest.fn(() => {
      events.push('guard.lock');
      if (env.guardError) return rejectWith(env.guardError);
      return Promise.resolve({
        id: 'sh-1',
        shiftNumber: 'SHF-20261113-0001',
        cashierUserId: 'u-rina',
        cashierName: 'Rina',
      });
    }),
    isShiftOpenForFinalize: jest.fn(() => {
      events.push('guard.finalize');
      return Promise.resolve(env.shiftOpen ?? true);
    }),
  };

  const inventory = {
    createDispensing: jest.fn((req: DispensingRequest) => {
      events.push('inventory');
      const outcome = env.outcome;
      if (typeof outcome === 'function') return Promise.resolve(outcome(req));
      return Promise.resolve<DispensingOutcome>(
        outcome ?? { kind: 'SUCCESS', httpStatus: 201, body: okBody(req) },
      );
    }),
  };

  const documentNumbers = {
    next: jest.fn(() => {
      events.push('next');
      if (env.nextError) return rejectWith(env.nextError);
      return Promise.resolve('SAL-20261113-0007');
    }),
  };
  const settings = {
    getOrCreate: jest.fn(() =>
      Promise.resolve({ tax_rate: env.taxRate ?? 11 }),
    ),
  };
  const methodRow =
    env.method === null
      ? null
      : ({
          id: 'pm-1',
          code: 'CASH',
          is_cash: true,
          ...env.method,
        } as PaymentMethod);
  const paymentMethods = {
    findActiveByCode: jest.fn(() => Promise.resolve(methodRow)),
  };
  const queriesSvc = {
    viewById: jest.fn((_t: string, _b: string, id: string) =>
      Promise.resolve({ id }),
    ),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new SaleService(
    dataSource as never,
    documentNumbers as unknown as DocumentNumberService,
    settings as unknown as BillingSettingService,
    paymentMethods as unknown as PaymentMethodService,
    queriesSvc as unknown as SaleQueryService,
    guard,
    inventory,
    logger as unknown as Logger,
  );
  return {
    service,
    events,
    queries,
    updates,
    inserts,
    manager,
    dataSource,
    guard,
    inventory,
    documentNumbers,
    paymentMethods,
    queriesSvc,
    logger,
    repoFindOne,
    repoUpdate,
  };
}

async function rejection(p: Promise<unknown>): Promise<BusinessException> {
  try {
    await p;
  } catch (e) {
    return e as BusinessException;
  }
  throw new Error('expected promise to reject');
}

const body = (e: BusinessException) =>
  e.getResponse() as {
    code: string;
    errors?: { field: string; message: string }[];
    details?: Record<string, unknown>;
  };

describe('SaleService.checkout - sukses (AC-SL-01, AC-SL-12, BR-SL-08)', () => {
  it('TX-A -> NOWAIT -> Inventory -> cek shift -> item/payment -> nomor SAL -> PAID, berurutan', async () => {
    const t = make();
    const result = await t.service.checkout(ctx(), KEY, DTO, NOW);

    expect(result).toEqual({ sale: { id: 'sale-1' }, replayed: false });
    expect(t.queriesSvc.viewById).toHaveBeenCalledWith('t-A', 'b-P', 'sale-1');
    expect(t.dataSource.transaction).toHaveBeenCalledTimes(2); // TX-A dan TX-B
    expect(t.events).toEqual([
      'guard.lock',
      'save',
      'sql:NOWAIT',
      'inventory',
      'guard.finalize',
      'sql:SAVEPOINT',
      'insert:SaleItem',
      'insert:Payment',
      'next', // paling akhir, sedekat mungkin dengan commit
      'update:PAID',
      'sql:RELEASE',
    ]);

    // TX-A
    expect(t.guard.lockOpenShiftForSale).toHaveBeenCalledWith(t.manager, {
      tenantId: 't-A',
      branchId: 'b-P',
      userId: 'u-rina',
    });
    expect(t.manager.create.mock.calls[0][1]).toMatchObject({
      tenant_id: 't-A',
      branch_id: 'b-P',
      sale_number: null,
      shift_id: 'sh-1',
      cashier_user_id: 'u-rina',
      cashier_name: 'Rina',
      source_type: 'OTC',
      status: 'PENDING',
      idempotency_key: KEY,
      request_hash: HASH,
      subtotal: 11000,
      grand_total: 11000,
      tax_rate: 11,
      tax_total: 1090.09,
      paid_total: 0,
      tendered_amount: 20000,
      change_amount: 0,
      request_items: DTO.items,
      created_by: 'u-rina',
    });

    // TX-B
    expect(t.queries.find((q) => q.sql.includes('NOWAIT'))).toEqual({
      sql: NOWAIT_SQL,
      params: ['sale-1', 't-A', 'b-P'],
    });
    expect(t.inventory.createDispensing).toHaveBeenCalledTimes(1);
    expect(t.inventory.createDispensing).toHaveBeenCalledWith(
      {
        idempotency_key: 'billing.sale:sale-1',
        reference_type: 'billing.sale',
        reference_id: 'sale-1',
        items: [
          {
            item_id: 'it-1',
            unit_id: 'un-1',
            quantity: 2,
            expected_unit_price: 5500,
          },
        ],
      },
      {
        tenantId: 't-A',
        branchId: 'b-P',
        userId: 'u-rina',
        requestId: 'req-1',
        saleId: 'sale-1',
      },
    );
    expect(t.guard.isShiftOpenForFinalize).toHaveBeenCalledWith(
      t.manager,
      'sh-1',
      { tenantId: 't-A', branchId: 'b-P', userId: 'u-rina' },
    );

    // Finalisasi
    expect(t.inserts[0].values).toEqual([
      expect.objectContaining({
        sale_id: 'sale-1',
        line_no: 1,
        line_type: 'STOCK_ITEM',
        item_id: 'it-1',
        item_code: 'OBT-0001',
        item_name: 'Obat 1',
        unit_id: 'un-1',
        unit_code: 'STRIP',
        unit_name: 'Strip',
        drug_group_code: 'OBT_BEBAS',
        quantity: 2,
        unit_price: 5500,
        discount_amount: 0,
        tax_amount: 1090.09,
        line_total: 11000,
      }),
    ]);
    expect(t.inserts[1].values).toMatchObject({
      sale_id: 'sale-1',
      shift_id: 'sh-1',
      payment_method_id: 'pm-1',
      method_code: 'CASH',
      amount: 11000,
      tendered_amount: 20000,
      change_amount: 9000,
      status: 'SUCCESS',
    });
    expect(t.documentNumbers.next).toHaveBeenCalledWith(t.manager, {
      tenantId: 't-A',
      branchId: 'b-P',
      docType: 'SALE',
      now: NOW,
    });
    const paid = t.updates.find((u) => u.patch.status === 'PAID')!;
    expect(paid.where).toEqual({
      id: 'sale-1',
      tenant_id: 't-A',
      branch_id: 'b-P',
    });
    expect(paid.patch).toMatchObject({
      sale_number: 'SAL-20261113-0007',
      subtotal: 11000,
      discount_total: 0,
      tax_total: 1090.09,
      grand_total: 11000,
      paid_total: 11000,
      change_amount: 9000,
      dispensing_id: 'd-1',
      dispensing_number: 'DSP-20261113-0007',
      paid_at: NOW,
      updated_by: 'u-rina',
    });
    expect(t.logger.error).not.toHaveBeenCalled();
  });

  it('key huruf besar dicari dalam huruf kecil, scope tenant dari JWT', async () => {
    const t = make();
    await t.service.checkout(ctx(), KEY.toUpperCase(), DTO, NOW);
    expect(t.repoFindOne).toHaveBeenCalledWith({
      where: { tenant_id: 't-A', idempotency_key: KEY },
    });
  });

  it('tax_rate 0: pajak 0, grandTotal tidak berubah (AC-SL-12 negatif)', async () => {
    const t = make({ taxRate: 0 });
    await t.service.checkout(ctx(), KEY, DTO, NOW);
    expect(t.inserts[0].values).toEqual([
      expect.objectContaining({ tax_amount: 0, line_total: 11000 }),
    ]);
    expect(
      t.updates.find((u) => u.patch.status === 'PAID')!.patch,
    ).toMatchObject({ tax_total: 0, grand_total: 11000 });
  });

  it('pajak Σ per baris (AC-RC-01): 11.000 + 32.000 pada 11% = 4.261,26', async () => {
    const dto = {
      ...DTO,
      items: [
        DTO.items[0],
        {
          item_id: 'it-2',
          unit_id: 'un-2',
          quantity: 1,
          expected_unit_price: 32000,
        },
      ],
      payments: [{ method_code: 'CASH', tendered_amount: 50000 }],
    };
    const t = make();
    await t.service.checkout(ctx(), KEY, dto, NOW);
    expect(
      t.updates.find((u) => u.patch.status === 'PAID')!.patch,
    ).toMatchObject({
      grand_total: 43000,
      tax_total: 4261.26,
      change_amount: 7000,
    });
  });

  it('batas: tunai tepat sama dengan total -> sukses, kembalian 0 (AC-SL-03)', async () => {
    const dto = {
      ...DTO,
      payments: [{ method_code: 'CASH', tendered_amount: 11000 }],
    };
    const t = make();
    const r = await t.service.checkout(ctx(), KEY, dto, NOW);
    expect(r.replayed).toBe(false);
    expect(t.inserts[1].values).toMatchObject({ change_amount: 0 });
  });

  it('customer_name di-trim; string kosong -> NULL (BR-SL-10)', async () => {
    const t = make();
    await t.service.checkout(
      ctx(),
      KEY,
      { ...DTO, customer_name: '  Bpk. Andi ' },
      NOW,
    );
    expect(t.manager.create.mock.calls[0][1]).toMatchObject({
      customer_name: 'Bpk. Andi',
    });
    const t2 = make();
    await t2.service.checkout(
      ctx(),
      KEY,
      { ...DTO, customer_name: '   ' },
      NOW,
    );
    expect(t2.manager.create.mock.calls[0][1]).toMatchObject({
      customer_name: null,
    });
  });

  it('claim name hilang di shift & JWT -> cashier_name null, tetap sukses (AC-RC-03 negatif)', async () => {
    const t = make();
    t.guard.lockOpenShiftForSale.mockResolvedValueOnce({
      id: 'sh-1',
      shiftNumber: 'SHF-1',
      cashierUserId: 'u-rina',
      cashierName: null,
    } as never);
    await t.service.checkout(ctx({ userName: null }), KEY, DTO, NOW);
    expect(t.manager.create.mock.calls[0][1]).toMatchObject({
      cashier_name: null,
    });
  });
});

describe('SaleService.checkout - validasi sebelum sale dibuat', () => {
  it.each([undefined, '', 'abc', '5b1d7c2e-8a7f-4f3e-9c55'])(
    'Idempotency-Key %p -> 400 BIL_008, tanpa query (AC-SL-10)',
    async (bad) => {
      const t = make();
      const e = await rejection(t.service.checkout(ctx(), bad, DTO, NOW));
      expect(e.getStatus()).toBe(400);
      expect(body(e).code).toBe('BIL_008');
      expect(t.repoFindOne).not.toHaveBeenCalled();
      expect(t.dataSource.transaction).not.toHaveBeenCalled();
    },
  );

  it('baris (item_id, unit_id) ganda -> 400 VALIDATION_ERROR dengan errors[] (AC-SL-16)', async () => {
    const t = make();
    const dto = {
      ...DTO,
      items: [DTO.items[0], DTO.items[0]],
    };
    const e = await rejection(t.service.checkout(ctx(), KEY, dto, NOW));
    expect(e.getStatus()).toBe(400);
    expect(body(e).code).toBe('VALIDATION_ERROR');
    expect(body(e).errors).toEqual([
      { field: 'items[1]', message: expect.any(String) as string },
    ]);
    expect(t.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('key lama + baris ganda -> BIL_009 (replay dicek sebelum baris ganda)', async () => {
    const dup = {
      ...DTO,
      items: [DTO.items[0], DTO.items[0]],
    };
    const t = make({ found: [saleRow({ status: 'PAID' })] });
    const e = await rejection(t.service.checkout(ctx(), KEY, dup, NOW));
    expect(body(e).code).toBe('BIL_009');
  });

  it('uang kurang -> 422 BIL_006, tidak ada sale/transaksi (AC-SL-03)', async () => {
    const t = make();
    const dto = {
      ...DTO,
      payments: [{ method_code: 'CASH', tendered_amount: 10000 }],
    };
    const e = await rejection(t.service.checkout(ctx(), KEY, dto, NOW));
    expect(e.getStatus()).toBe(422);
    expect(body(e).code).toBe('BIL_006');
    expect(t.dataSource.transaction).not.toHaveBeenCalled();
    expect(t.inventory.createDispensing).not.toHaveBeenCalled();
  });

  it.each([
    ['QRIS', [{ method_code: 'QRIS', tendered_amount: 20000 }]],
    [
      'dua elemen payments',
      [
        { method_code: 'CASH', tendered_amount: 10000 },
        { method_code: 'CASH', tendered_amount: 10000 },
      ],
    ],
    ['payments kosong', []],
  ])('%s -> 422 BIL_007 (AC-SL-15)', async (_label, payments) => {
    const t = make();
    const dto = { ...DTO, payments };
    const e = await rejection(t.service.checkout(ctx(), KEY, dto, NOW));
    expect(e.getStatus()).toBe(422);
    expect(body(e).code).toBe('BIL_007');
    expect(t.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('metode CASH nonaktif -> 422 BIL_007 (AC-SL-15, AC-SL-20)', async () => {
    const t = make({ method: null });
    const e = await rejection(t.service.checkout(ctx(), KEY, DTO, NOW));
    expect(body(e).code).toBe('BIL_007');
    expect(t.paymentMethods.findActiveByCode).toHaveBeenCalledWith(
      't-A',
      'b-P',
      'CASH',
    );
    expect(t.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('total melebihi numeric(14,2) -> 400 VALIDATION_ERROR', async () => {
    const t = make();
    const dto = {
      ...DTO,
      items: [
        {
          item_id: 'it-1',
          unit_id: 'un-1',
          quantity: 1_000_000,
          expected_unit_price: 999_999_999_999.99,
        },
      ],
      payments: [{ method_code: 'CASH', tendered_amount: 999_999_999_999.99 }],
    };
    const e = await rejection(t.service.checkout(ctx(), KEY, dto, NOW));
    expect(body(e).code).toBe('VALIDATION_ERROR');
    expect(t.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('tanpa shift OPEN -> 422 BIL_003, tidak ada sale tersimpan, Inventory tidak dipanggil (AC-SL-01 negatif)', async () => {
    const t = make({ guardError: new BusinessException('BIL_003') });
    const e = await rejection(t.service.checkout(ctx(), KEY, DTO, NOW));
    expect(e.getStatus()).toBe(422);
    expect(body(e).code).toBe('BIL_003');
    expect(t.manager.save).not.toHaveBeenCalled();
    expect(t.inventory.createDispensing).not.toHaveBeenCalled();
    expect(t.dataSource.transaction).toHaveBeenCalledTimes(1);
  });
});

describe('SaleService.checkout - replay idempotency (BR-SL-04, BR-SL-14)', () => {
  it('PAID + hash sama -> 200 replayed, sale yang sama, Inventory tidak dipanggil (AC-SL-02)', async () => {
    const t = make({
      found: [saleRow({ status: 'PAID', sale_number: 'SAL-20261113-0007' })],
    });
    const r = await t.service.checkout(ctx(), KEY, DTO, NOW);
    expect(r).toEqual({ sale: { id: 'sale-1' }, replayed: true });
    expect(t.dataSource.transaction).not.toHaveBeenCalled();
    expect(t.inventory.createDispensing).not.toHaveBeenCalled();
  });

  it('replay dicek SEBELUM validasi BR-SL-03 (BIL_009 mengalahkan BIL_006/BIL_007)', async () => {
    const lessCash = {
      ...DTO,
      payments: [{ method_code: 'CASH', tendered_amount: 5000 }],
    };
    const t = make({ found: [saleRow({ status: 'PAID' })] });
    const e = await rejection(t.service.checkout(ctx(), KEY, lessCash, NOW));
    expect(body(e).code).toBe('BIL_009');
    expect(t.paymentMethods.findActiveByCode).not.toHaveBeenCalled();
  });

  it.each([
    [
      'isi keranjang berbeda',
      { ...DTO, items: [{ ...DTO.items[0], quantity: 3 }] },
    ],
    [
      'tendered_amount berbeda (AC-SL-09)',
      { ...DTO, payments: [{ method_code: 'CASH', tendered_amount: 30000 }] },
    ],
  ])('hash berbeda: %s -> 422 BIL_009', async (_label, dto) => {
    for (const status of [
      'PAID',
      'FAILED',
      'PENDING',
      'NEEDS_RECONCILIATION',
    ] as const) {
      const t = make({ found: [saleRow({ status })] });
      const e = await rejection(t.service.checkout(ctx(), KEY, dto, NOW));
      expect(e.getStatus()).toBe(422);
      expect(body(e).code).toBe('BIL_009');
      expect(t.inventory.createDispensing).not.toHaveBeenCalled();
    }
  });

  it('key milik kasir lain atau cabang lain -> 422 BIL_009 tanpa data sale (AC-SL-02 negatif)', async () => {
    const other = make({
      found: [saleRow({ status: 'PAID', cashier_user_id: 'u-dewi' })],
    });
    const e1 = await rejection(other.service.checkout(ctx(), KEY, DTO, NOW));
    expect(body(e1).code).toBe('BIL_009');
    expect(JSON.stringify(e1.getResponse())).not.toContain('sale-1');
    expect(other.queriesSvc.viewById).not.toHaveBeenCalled();

    const otherBranch = make({
      found: [saleRow({ status: 'PAID', branch_id: 'b-Q' })],
    });
    const e2 = await rejection(
      otherBranch.service.checkout(ctx(), KEY, DTO, NOW),
    );
    expect(body(e2).code).toBe('BIL_009');
  });

  it('FAILED + hash sama -> HTTP + kode + errors[] tersimpan sama, Inventory tidak dipanggil (AC-SL-04)', async () => {
    const errors = [
      {
        field: 'items[0]',
        message: 'Harga saat ini 6000.00, diharapkan 5500.00',
      },
    ];
    const t = make({
      found: [
        saleRow({
          status: 'FAILED',
          failure_code: 'INV_062',
          failure_errors: errors,
        }),
      ],
    });
    const e = await rejection(t.service.checkout(ctx(), KEY, DTO, NOW));
    expect(e.getStatus()).toBe(409);
    expect(body(e)).toMatchObject({ code: 'BIL_012', errors });
    expect(t.inventory.createDispensing).not.toHaveBeenCalled();
    expect(t.dataSource.transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['INV_003', 422, 'BIL_013'],
    ['INV_060', 422, 'BIL_014'],
    ['VALIDATION_ERROR', 500, 'BIL_017'],
    ['HTTP_404', 500, 'BIL_017'],
  ])('replay FAILED %s -> %d %s', async (failureCode, status, code) => {
    const t = make({
      found: [
        saleRow({
          status: 'FAILED',
          failure_code: failureCode,
          failure_errors: [{ field: 'items[0]', message: 'x' }],
        }),
      ],
    });
    const e = await rejection(t.service.checkout(ctx(), KEY, DTO, NOW));
    expect(e.getStatus()).toBe(status);
    expect(body(e).code).toBe(code);
    if (code !== 'BIL_017') {
      expect(body(e).errors).toEqual([{ field: 'items[0]', message: 'x' }]);
    } else {
      expect(body(e).errors).toBeUndefined();
      expect(body(e).details).toEqual({ saleId: 'sale-1', saleNumber: null });
    }
  });

  it('NEEDS_RECONCILIATION -> 409 BIL_016 dengan details saleId/saleNumber (BR-PS-08, AC-SH-05)', async () => {
    const t = make({
      found: [saleRow({ status: 'NEEDS_RECONCILIATION' })],
    });
    const e = await rejection(t.service.checkout(ctx(), KEY, DTO, NOW));
    expect(e.getStatus()).toBe(409);
    expect(body(e).code).toBe('BIL_016');
    expect(body(e).details).toEqual({ saleId: 'sale-1', saleNumber: null });
    expect(t.inventory.createDispensing).not.toHaveBeenCalled();
    expect(t.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('PENDING + hash sama: lanjut dari langkah 5 tanpa TX-A (AC-SL-06 setelah Inventory hidup)', async () => {
    const t = make({ found: [saleRow()] });
    const r = await t.service.checkout(ctx(), KEY, DTO, NOW);
    expect(r.replayed).toBe(false);
    expect(t.guard.lockOpenShiftForSale).not.toHaveBeenCalled();
    expect(t.manager.save).not.toHaveBeenCalled();
    expect(t.dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(t.events[0]).toBe('sql:NOWAIT');
    expect(t.inventory.createDispensing).toHaveBeenCalledTimes(1);
    expect(t.updates.map((u) => u.patch.status)).toEqual(['PAID']);
  });

  it('PENDING lanjut bila CASH sudah nonaktif -> BIL_007, sale tetap PENDING', async () => {
    const t = make({ found: [saleRow()], method: null });
    const e = await rejection(t.service.checkout(ctx(), KEY, DTO, NOW));
    expect(body(e).code).toBe('BIL_007');
    expect(t.inventory.createDispensing).not.toHaveBeenCalled();
  });
});

describe('SaleService.checkout - konkurensi (KB-17, BR-SL-18)', () => {
  it.each([
    ['langsung', { code: '55P03' }],
    ['dibungkus driverError', { driverError: { code: '55P03' } }],
  ])(
    'sale dikunci request lain (%s) -> 409 BIL_010, Inventory tidak dipanggil (AC-SL-08)',
    async (_l, lockError) => {
      const t = make({ found: [saleRow()], lockError });
      const e = await rejection(t.service.checkout(ctx(), KEY, DTO, NOW));
      expect(e.getStatus()).toBe(409);
      expect(body(e).code).toBe('BIL_010');
      expect(t.inventory.createDispensing).not.toHaveBeenCalled();
      expect(t.queries.filter((q) => q.sql === NOWAIT_SQL)).toHaveLength(1);
      expect(t.updates).toHaveLength(0); // sale tidak diubah oleh request yang kalah
    },
  );

  it('error lain saat mengunci tidak disamarkan menjadi BIL_010', async () => {
    const t = make({ found: [saleRow()], lockError: new Error('db down') });
    const e = await rejection(t.service.checkout(ctx(), KEY, DTO, NOW));
    expect(e.message).toBe('db down');
  });

  it('dua request pertama bersamaan: yang kalah di uq_sale_idempotency memakai perilaku replay -> BIL_010', async () => {
    const t = make({
      found: [null, saleRow()],
      saveError: {
        driverError: { code: '23505', constraint: 'uq_sale_idempotency' },
      },
      lockError: { code: '55P03' },
    });
    const e = await rejection(t.service.checkout(ctx(), KEY, DTO, NOW));
    expect(body(e).code).toBe('BIL_010');
    expect(t.repoFindOne).toHaveBeenCalledTimes(2);
    expect(t.inventory.createDispensing).not.toHaveBeenCalled();
  });

  it('yang kalah setelah pemenang selesai -> 200 replay PAID', async () => {
    const t = make({
      found: [null, saleRow({ status: 'PAID' })],
      saveError: {
        driverError: { code: '23505', constraint: 'uq_sale_idempotency' },
      },
    });
    const r = await t.service.checkout(ctx(), KEY, DTO, NOW);
    expect(r.replayed).toBe(true);
  });

  it('unique violation pada constraint lain tidak ditelan', async () => {
    const err = {
      driverError: { code: '23505', constraint: 'uq_sale_number' },
    };
    const t = make({ found: [null], saveError: err });
    await expect(t.service.checkout(ctx(), KEY, DTO, NOW)).rejects.toBe(err);
  });

  it.each([
    ['PAID', undefined, true],
    ['FAILED', 'INV_003', 'BIL_013'],
    ['NEEDS_RECONCILIATION', 'TOTAL_MISMATCH', 'BIL_016'],
  ] as const)(
    'status berubah selagi menunggu kunci (%s): Inventory tidak dipanggil',
    async (status, failureCode, expected) => {
      const fresh = saleRow({ status, failure_code: failureCode ?? null });
      const t = make({ found: [saleRow()], lockStatus: status, fresh });
      if (expected === true) {
        const r = await t.service.checkout(ctx(), KEY, DTO, NOW);
        expect(r.replayed).toBe(true);
      } else {
        const e = await rejection(t.service.checkout(ctx(), KEY, DTO, NOW));
        expect(body(e).code).toBe(expected);
      }
      expect(t.inventory.createDispensing).not.toHaveBeenCalled();
      expect(t.inserts).toHaveLength(0);
    },
  );
});

describe('SaleService.checkout - pemetaan hasil Inventory (BR-SL-06)', () => {
  const rej = (
    httpStatus: number,
    code: string | null,
    errors: { field: string; message: string }[] | null = null,
  ): DispensingOutcome => ({ kind: 'REJECTED', httpStatus, code, errors });
  const ERRS = [{ field: 'items[0]', message: 'pesan asli Inventory' }];

  it.each([
    [409, 'INV_062', 409, 'BIL_012'], // harga berubah (AC-SL-04)
    [422, 'INV_003', 422, 'BIL_013'], // stok kurang (AC-SL-05)
    [422, 'INV_060', 422, 'BIL_014'], // golongan terblokir (AC-SL-13)
    [422, 'INV_061', 422, 'BIL_014'],
    [422, 'INV_018', 422, 'BIL_014'],
    [422, 'INV_054', 422, 'BIL_014'],
    [404, 'INV_001', 422, 'BIL_014'],
    [404, 'INV_021', 422, 'BIL_014'],
  ])(
    '%d %s -> sale FAILED, %d %s dengan errors[] diteruskan apa adanya',
    async (httpStatus, invCode, status, bil) => {
      const t = make({ outcome: rej(httpStatus, invCode, ERRS) });
      const e = await rejection(t.service.checkout(ctx(), KEY, DTO, NOW));

      expect(e.getStatus()).toBe(status);
      expect(body(e)).toMatchObject({ code: bil, errors: ERRS });
      expect(body(e).details).toBeUndefined();
      expect(t.inventory.createDispensing).toHaveBeenCalledTimes(1);
      const failed = t.updates.find((u) => u.patch.status === 'FAILED')!;
      expect(failed.patch).toMatchObject({
        failure_code: invCode,
        failure_errors: ERRS,
        updated_by: 'u-rina',
      });
      expect(failed.where).toEqual({
        id: 'sale-1',
        tenant_id: 't-A',
        branch_id: 'b-P',
      });
      // sale FAILED: tanpa item/payment/nomor, stok pasti tidak terpotong
      expect(t.inserts).toHaveLength(0);
      expect(t.documentNumbers.next).not.toHaveBeenCalled();
      expect(t.logger.error).not.toHaveBeenCalled();
    },
  );

  it.each([
    [400, 'VALIDATION_ERROR'],
    [401, 'UNAUTHORIZED'], // INTERNAL_SERVICE_TOKEN salah (AC-SL-17 negatif)
    [403, 'FORBIDDEN'],
    [404, null], // route tidak ada
    [418, 'SOMETHING_NEW'],
  ])(
    '%d %s (bug integrasi) -> FAILED + 500 BIL_017, log error, stok pasti tidak terpotong',
    async (httpStatus, invCode) => {
      const t = make({ outcome: rej(httpStatus, invCode) });
      const e = await rejection(t.service.checkout(ctx(), KEY, DTO, NOW));

      expect(e.getStatus()).toBe(500);
      expect(body(e).code).toBe('BIL_017');
      expect(body(e).details).toEqual({ saleId: 'sale-1', saleNumber: null });
      expect(t.updates.map((u) => u.patch.status)).toEqual(['FAILED']);
      expect(t.updates[0].patch.failure_code).toBe(
        invCode ?? `HTTP_${httpStatus}`,
      );
      expect(t.logger.error).toHaveBeenCalledWith(
        'inventory_rejected_integration_error',
        expect.objectContaining({ saleId: 'sale-1', requestId: 'req-1' }),
      );
      expect(t.inserts).toHaveLength(0);
    },
  );

  it('BIL_017 dari 400 VALIDATION_ERROR: errors[] Inventory tidak dikirim ke kasir dan tidak disimpan', async () => {
    const t = make({
      outcome: rej(400, 'VALIDATION_ERROR', [
        { field: 'items[0].quantity', message: 'nama field internal' },
      ]),
    });
    const e = await rejection(t.service.checkout(ctx(), KEY, DTO, NOW));
    expect(body(e).code).toBe('BIL_017');
    expect(body(e).errors).toBeUndefined();
    expect(JSON.stringify(e.getResponse())).not.toContain(
      'nama field internal',
    );
    expect(t.updates[0].patch.failure_errors).toBeNull();
  });

  it('409 INV_063 -> NEEDS_RECONCILIATION + 500 BIL_017 (AC-SL-17)', async () => {
    const t = make({ outcome: rej(409, 'INV_063') });
    const e = await rejection(t.service.checkout(ctx(), KEY, DTO, NOW));
    expect(e.getStatus()).toBe(500);
    expect(body(e)).toMatchObject({
      code: 'BIL_017',
      details: { saleId: 'sale-1', saleNumber: null },
    });
    expect(t.updates).toHaveLength(1);
    expect(t.updates[0].patch).toMatchObject({
      status: 'NEEDS_RECONCILIATION',
      failure_code: 'INV_063',
    });
    expect(t.logger.error).toHaveBeenCalledWith(
      'sale_needs_reconciliation',
      expect.objectContaining({ saleId: 'sale-1', failureCode: 'INV_063' }),
    );
  });

  it('Inventory mati/timeout setelah retry -> 503 BIL_015, sale tetap PENDING, log warn (AC-SL-06)', async () => {
    const t = make({
      outcome: { kind: 'UNAVAILABLE', attempts: 3, reason: 'timeout' },
    });
    const e = await rejection(t.service.checkout(ctx(), KEY, DTO, NOW));
    expect(e.getStatus()).toBe(503);
    expect(body(e).code).toBe('BIL_015');
    expect(t.updates).toHaveLength(0);
    expect(t.inserts).toHaveLength(0);
    expect(t.logger.warn).toHaveBeenCalledWith(
      'inventory_unavailable',
      expect.objectContaining({
        saleId: 'sale-1',
        attempts: 3,
        reason: 'timeout',
      }),
    );
    expect(t.logger.error).not.toHaveBeenCalled();
  });

  it('status tak dikenal (3xx) -> NEEDS_RECONCILIATION + BIL_017', async () => {
    const t = make({ outcome: { kind: 'UNEXPECTED', httpStatus: 302 } });
    const e = await rejection(t.service.checkout(ctx(), KEY, DTO, NOW));
    expect(body(e).code).toBe('BIL_017');
    expect(t.updates[0].patch).toMatchObject({
      status: 'NEEDS_RECONCILIATION',
      failure_code: 'INVENTORY_UNEXPECTED_STATUS',
    });
  });

  it('2xx tanpa dispensingId (AC-SL-18) -> NEEDS_RECONCILIATION + 500 BIL_017', async () => {
    const t = make({
      outcome: (req) => ({
        kind: 'SUCCESS',
        httpStatus: 201,
        body: okBody(req, { dispensingId: undefined }),
      }),
    });
    const e = await rejection(t.service.checkout(ctx(), KEY, DTO, NOW));
    expect(e.getStatus()).toBe(500);
    expect(body(e).code).toBe('BIL_017');
    expect(t.updates).toHaveLength(1);
    expect(t.updates[0].patch).toMatchObject({
      status: 'NEEDS_RECONCILIATION',
      failure_code: 'INVENTORY_RESPONSE_INVALID',
    });
    expect(t.inserts).toHaveLength(0);
  });

  it('2xx dengan body tidak bisa di-parse -> NEEDS_RECONCILIATION', async () => {
    const t = make({
      outcome: { kind: 'SUCCESS', httpStatus: 201, body: undefined },
    });
    const e = await rejection(t.service.checkout(ctx(), KEY, DTO, NOW));
    expect(body(e).code).toBe('BIL_017');
    expect(t.updates[0].patch.status).toBe('NEEDS_RECONCILIATION');
  });

  it('2xx dengan jumlah baris beda, dispensingId tercatat di log error (BR-SL-19)', async () => {
    const t = make({
      outcome: (req) => ({
        kind: 'SUCCESS',
        httpStatus: 201,
        body: okBody(req, { items: [] }),
      }),
    });
    await rejection(t.service.checkout(ctx(), KEY, DTO, NOW));
    expect(t.logger.error).toHaveBeenCalledWith(
      'sale_needs_reconciliation',
      expect.objectContaining({
        saleId: 'sale-1',
        dispensingId: 'd-1',
        failureCode: 'INVENTORY_RESPONSE_INVALID',
      }),
    );
  });

  it('grandTotal Inventory != total preview -> NEEDS_RECONCILIATION + BIL_017 (BR-SL-07, AC-SL-18)', async () => {
    const t = make({
      outcome: (req) => ({
        kind: 'SUCCESS',
        httpStatus: 201,
        body: okBody(req, {}, () => 6000), // 2 x 6000 = 12.000 != 11.000
      }),
    });
    const e = await rejection(t.service.checkout(ctx(), KEY, DTO, NOW));
    expect(e.getStatus()).toBe(500);
    expect(body(e)).toMatchObject({
      code: 'BIL_017',
      details: { saleId: 'sale-1', saleNumber: null },
    });
    expect(t.updates[0].patch).toMatchObject({
      status: 'NEEDS_RECONCILIATION',
      failure_code: 'TOTAL_MISMATCH',
    });
    expect(t.inserts).toHaveLength(0);
    expect(t.documentNumbers.next).not.toHaveBeenCalled();
  });

  it('beda 1 sen sudah dianggap beda (perbandingan dalam sen)', async () => {
    const t = make({
      outcome: (req) => ({
        kind: 'SUCCESS',
        httpStatus: 201,
        body: okBody(req, {}, () => 5500.01), // 2 x 5500,01 = 11.000,02
      }),
    });
    await rejection(t.service.checkout(ctx(), KEY, DTO, NOW));
    expect(t.updates[0].patch.failure_code).toBe('TOTAL_MISMATCH');
  });

  it('replay Inventory (200, replayed:true) diperlakukan sebagai sukses (AC-SL-07)', async () => {
    const t = make({
      found: [saleRow()],
      outcome: (req) => ({
        kind: 'SUCCESS',
        httpStatus: 200,
        body: okBody(req, { replayed: true }),
      }),
    });
    const r = await t.service.checkout(ctx(), KEY, DTO, NOW);
    expect(r.replayed).toBe(false); // bagi Billing ini penyelesaian pertama
    expect(t.updates.map((u) => u.patch.status)).toEqual(['PAID']);
  });
});

describe('SaleService.checkout - langkah 7 (BR-SL-17, AC-SL-11)', () => {
  it('shift sudah CLOSED -> NEEDS_RECONCILIATION SHIFT_CLOSED_DURING_CHECKOUT + 500 BIL_017', async () => {
    const t = make({ shiftOpen: false });
    const e = await rejection(t.service.checkout(ctx(), KEY, DTO, NOW));
    expect(e.getStatus()).toBe(500);
    expect(body(e)).toMatchObject({
      code: 'BIL_017',
      details: { saleId: 'sale-1', saleNumber: null },
    });
    // urutan: kunci sale dulu, baru cek shift
    expect(t.events.indexOf('sql:NOWAIT')).toBeLessThan(
      t.events.indexOf('guard.finalize'),
    );
    expect(t.updates[0].patch).toMatchObject({
      status: 'NEEDS_RECONCILIATION',
      failure_code: 'SHIFT_CLOSED_DURING_CHECKOUT',
    });
    expect(t.inserts).toHaveLength(0);
    expect(t.documentNumbers.next).not.toHaveBeenCalled();
    expect(t.logger.error).toHaveBeenCalledWith(
      'sale_needs_reconciliation',
      expect.objectContaining({ saleId: 'sale-1', dispensingId: 'd-1' }),
    );
  });

  it.each([
    [
      'insert sale_item gagal',
      { insertError: { entity: SaleItem, error: new Error('boom') } },
    ],
    [
      'insert payment gagal',
      { insertError: { entity: Payment, error: new Error('boom') } },
    ],
    ['nomor SAL gagal', { nextError: new Error('boom') }],
  ])(
    'penyimpanan gagal (%s): rollback ke savepoint lalu NEEDS_RECONCILIATION di transaksi yang sama',
    async (_label, env) => {
      const t = make(env);
      const e = await rejection(t.service.checkout(ctx(), KEY, DTO, NOW));

      expect(e.getStatus()).toBe(500);
      expect(body(e)).toMatchObject({
        code: 'BIL_017',
        details: { saleId: 'sale-1', saleNumber: null },
      });
      expect(t.events).toContain('sql:SAVEPOINT');
      expect(t.events).toContain('sql:ROLLBACK');
      expect(t.events).not.toContain('sql:RELEASE');
      expect(t.events.indexOf('sql:ROLLBACK')).toBeLessThan(
        t.events.indexOf('update:NEEDS_RECONCILIATION'),
      );
      expect(t.updates.map((u) => u.patch.status)).toEqual([
        'NEEDS_RECONCILIATION',
      ]);
      expect(t.updates[0].patch.failure_code).toBe('FINALIZE_FAILED');
      expect(t.dataSource.transaction).toHaveBeenCalledTimes(2); // satu transaksi TX-B
    },
  );

  it('log error memuat saleId + dispensingId tanpa body request/response (AC-SL-11)', async () => {
    const dto = {
      ...DTO,
      customer_name: 'Bpk. Rahasia',
    } as CreateSaleDto;
    const t = make({
      insertError: { entity: SaleItem, error: new Error('db down') },
    });
    await rejection(t.service.checkout(ctx(), KEY, dto, NOW));

    expect(t.logger.error).toHaveBeenCalledWith(
      'sale_finalize_failed',
      expect.objectContaining({
        saleId: 'sale-1',
        dispensingId: 'd-1',
        dispensingNumber: 'DSP-20261113-0007',
        requestId: 'req-1',
      }),
    );
    const logged = JSON.stringify([
      t.logger.error.mock.calls,
      t.logger.warn.mock.calls,
      t.logger.info.mock.calls,
    ]);
    for (const secret of [
      'Bpk. Rahasia',
      'Rina', // claim name
      'expected_unit_price',
      'Obat 1',
      'OBT-0001',
      'db down', // pesan error DB tidak ikut
    ]) {
      expect(logged).not.toContain(secret);
    }
  });

  it('retry dengan key sama setelah langkah 7 gagal -> 409 BIL_016, Inventory tidak dipanggil (AC-SL-11 negatif)', async () => {
    const t = make({
      found: [
        saleRow({
          status: 'NEEDS_RECONCILIATION',
          failure_code: 'FINALIZE_FAILED',
        }),
      ],
    });
    const e = await rejection(t.service.checkout(ctx(), KEY, DTO, NOW));
    expect(e.getStatus()).toBe(409);
    expect(body(e).code).toBe('BIL_016');
    expect(t.inventory.createDispensing).not.toHaveBeenCalled();
  });

  it('menulis status NEEDS_RECONCILIATION juga gagal: tetap BIL_017 + upaya tandai di luar transaksi', async () => {
    const t = make({
      insertError: { entity: SaleItem, error: new Error('boom') },
      updateError: (patch) =>
        patch.status === 'NEEDS_RECONCILIATION' ? new Error('db gone') : null,
    });
    const e = await rejection(t.service.checkout(ctx(), KEY, DTO, NOW));
    expect(e.getStatus()).toBe(500);
    expect(body(e)).toMatchObject({
      code: 'BIL_017',
      details: { saleId: 'sale-1', saleNumber: null },
    });
    expect(t.repoUpdate).toHaveBeenCalledWith(
      { id: 'sale-1', tenant_id: 't-A', branch_id: 'b-P', status: 'PENDING' },
      expect.objectContaining({
        status: 'NEEDS_RECONCILIATION',
        failure_code: 'UNEXPECTED_AFTER_DISPENSING',
      }),
    );
    expect(t.logger.error).toHaveBeenCalledWith(
      'sale_needs_reconciliation',
      expect.objectContaining({ saleId: 'sale-1', dispensingId: 'd-1' }),
    );
  });

  it('error tak terduga SEBELUM Inventory menyala dilempar apa adanya (sale tetap PENDING)', async () => {
    const t = make({ found: [saleRow()], lockError: new Error('db down') });
    await expect(t.service.checkout(ctx(), KEY, DTO, NOW)).rejects.toThrow(
      'db down',
    );
    expect(t.repoUpdate).not.toHaveBeenCalled();
  });
});

describe('mapRejection (tabel BR-SL-06)', () => {
  it.each([
    ['INV_062', 'BIL_012', 'FAILED'],
    ['INV_003', 'BIL_013', 'FAILED'],
    ['INV_060', 'BIL_014', 'FAILED'],
    ['INV_061', 'BIL_014', 'FAILED'],
    ['INV_018', 'BIL_014', 'FAILED'],
    ['INV_054', 'BIL_014', 'FAILED'],
    ['INV_001', 'BIL_014', 'FAILED'],
    ['INV_021', 'BIL_014', 'FAILED'],
    ['INV_063', 'BIL_017', 'NEEDS_RECONCILIATION'],
    ['UNAUTHORIZED', 'BIL_017', 'FAILED'],
    [null, 'BIL_017', 'FAILED'],
  ])('%s -> %s (%s)', (code, key, saleStatus) => {
    expect(mapRejection(code)).toEqual({ key, saleStatus });
  });
});

describe('BR-MD-07 / BR-MD-08', () => {
  it('modul sale tidak meng-import ShiftService atau repository shift', () => {
    const dir = __dirname;
    for (const file of [
      'sale.service.ts',
      'sale-query.service.ts',
      'sale.controller.ts',
      'sale.module.ts',
    ]) {
      const src = readFileSync(join(dir, file), 'utf8');
      const imports = src
        .split('\n')
        .filter((l) => /^\s*(import|} from)/.test(l))
        .join('\n');
      expect(imports).not.toMatch(/shift\.service/);
      expect(imports).not.toMatch(/ShiftService/);
      expect(imports).not.toMatch(/cashier-shift\.entity/);
    }
    const moduleSrc = readFileSync(join(dir, 'sale.module.ts'), 'utf8');
    expect(moduleSrc).toMatch(/ShiftModule/);
    expect(readFileSync(join(dir, 'sale.service.ts'), 'utf8')).toMatch(
      /@Inject\(SHIFT_GUARD\)/,
    );
  });
});
