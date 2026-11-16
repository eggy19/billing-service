import { UnauthorizedException } from '@nestjs/common';
import { FindOperator } from 'typeorm';
import type { RequestContextData } from '../../common/context/request-context';
import { BusinessException } from '../../common/exceptions/business.exception';
import type { BillingSettingService } from '../setting/billing-setting.service';
import { ListSaleQueryDto } from './dto/sale.dto';
import { Payment } from './entities/payment.entity';
import { SaleItem } from './entities/sale-item.entity';
import { Sale } from './entities/sale.entity';
import { SaleQueryService } from './sale-query.service';

function ctx(
  permissions: string[],
  over: Partial<RequestContextData> = {},
): RequestContextData {
  return {
    tenantId: 't-A',
    branchId: 'b-P',
    userId: 'u-rina',
    roles: [],
    permissions,
    userName: 'Rina',
    correlationId: 'r',
    isInternal: false,
    sessionId: 's',
    requestId: 'r',
    ...over,
  };
}

const KASIR = ctx(['billing.sale.read']);
const OWNER = ctx(['billing.sale.read_all'], { userId: 'u-oki' });

function query(over: Partial<ListSaleQueryDto> = {}): ListSaleQueryDto {
  return Object.assign(new ListSaleQueryDto(), over);
}

const SALE = {
  id: 'sale-1',
  sale_number: 'SAL-20261113-0007',
  status: 'PAID',
  source_type: 'OTC',
  shift_id: 'sh-1',
  shift: { shift_number: 'SHF-20261113-0001' },
  cashier_user_id: 'u-rina',
  cashier_name: 'Rina',
  customer_name: null,
  created_at: new Date('2026-11-13T03:15:20Z'),
  paid_at: new Date('2026-11-13T03:15:21Z'),
  subtotal: 11000,
  discount_total: 0,
  tax_rate: 11,
  tax_total: 1090.09,
  grand_total: 11000,
  paid_total: 11000,
  tendered_amount: 20000,
  change_amount: 9000,
  dispensing_number: 'DSP-20261113-0007',
  failure_code: null,
  failure_message: null,
  failure_errors: [{ field: 'x', message: 'rahasia' }],
  request_items: [{ item_id: 'rahasia' }],
  request_hash: 'h'.repeat(64),
  idempotency_key: 'k',
} as unknown as Sale;

function make(
  over: {
    sales?: Sale[];
    total?: number;
    one?: Sale | null;
    items?: unknown[];
    payments?: unknown[];
  } = {},
) {
  const sales = {
    findAndCount: jest.fn(() =>
      Promise.resolve([over.sales ?? [SALE], over.total ?? 1]),
    ),
    findOne: jest.fn(() =>
      Promise.resolve(over.one === undefined ? SALE : over.one),
    ),
  };
  const items = {
    find: jest.fn(() =>
      Promise.resolve(
        over.items ?? [
          {
            line_no: 1,
            item_code: 'OBT-0001',
            item_name: 'Paracetamol 500 mg',
            unit_code: 'STRIP',
            unit_name: 'Strip',
            quantity: 2,
            unit_price: 5500,
            discount_amount: 0,
            tax_amount: 1090.09,
            line_total: 11000,
            drug_group_code: 'OBT_BEBAS',
            item_id: 'rahasia',
          },
        ],
      ),
    ),
  };
  const payments = {
    find: jest.fn(() =>
      Promise.resolve(
        over.payments ?? [
          {
            method_code: 'CASH',
            payment_method: { name: 'Tunai' },
            amount: 11000,
            tendered_amount: 20000,
            change_amount: 9000,
            reference_no: null,
          },
        ],
      ),
    ),
  };
  const repos = new Map<unknown, unknown>([
    [Sale, sales],
    [SaleItem, items],
    [Payment, payments],
  ]);
  const dataSource = { getRepository: (e: unknown) => repos.get(e) };
  const settings = {
    getOrCreate: jest.fn(() =>
      Promise.resolve({
        receipt_header: 'APOTEK SEHAT PUSAT\nJl. Mawar 1',
        receipt_footer: 'Terima kasih',
      }),
    ),
  };
  const service = new SaleQueryService(
    dataSource as never,
    settings as unknown as BillingSettingService,
  );
  return { service, sales, items, payments, settings };
}

type Opts = {
  where: Record<string, unknown>;
  order: unknown;
  skip: number;
  take: number;
  relations: unknown;
};
const optsOf = (fn: jest.Mock): Opts =>
  (fn.mock.calls as unknown[][])[0][0] as Opts;

describe('SaleQueryService.list (BR-SL-12, §7.5)', () => {
  it('KASIR (read): dibatasi tenant + cabang JWT + miliknya, urut created_at DESC, paginasi', async () => {
    const t = make();
    const r = await t.service.list(KASIR, query({ page: 2, limit: 20 }));
    expect(optsOf(t.sales.findAndCount)).toEqual({
      where: {
        tenant_id: 't-A',
        branch_id: 'b-P',
        cashier_user_id: 'u-rina',
      },
      relations: { shift: true },
      order: { created_at: 'DESC', id: 'DESC' },
      skip: 20,
      take: 20,
    });
    expect(r.pagination).toEqual({
      page: 2,
      limit: 20,
      total: 1,
      totalPages: 1,
    });
    expect(r.data[0]).toMatchObject({
      id: 'sale-1',
      sale_number: 'SAL-20261113-0007',
      shift_number: 'SHF-20261113-0001',
      grand_total: 11000,
    });
  });

  it('SaleSummary tanpa items/payments/receipt dan tanpa data internal (failure_errors, request_*)', async () => {
    const t = make();
    const r = await t.service.list(KASIR, query());
    const row = r.data[0] as unknown as Record<string, unknown>;
    for (const k of [
      'items',
      'payments',
      'receipt',
      'failure_errors',
      'request_items',
      'request_hash',
      'idempotency_key',
    ]) {
      expect(row).not.toHaveProperty(k);
    }
    expect(JSON.stringify(row)).not.toContain('rahasia');
  });

  it('KASIR memfilter kasir lain -> list kosong tanpa query (AC-RW-01)', async () => {
    const t = make();
    const r = await t.service.list(KASIR, query({ cashier_user_id: 'u-dewi' }));
    expect(r.data).toEqual([]);
    expect(r.pagination.total).toBe(0);
    expect(t.sales.findAndCount).not.toHaveBeenCalled();
  });

  it('KASIR memfilter dirinya sendiri -> tetap terscope', async () => {
    const t = make();
    await t.service.list(KASIR, query({ cashier_user_id: 'u-rina' }));
    expect(optsOf(t.sales.findAndCount).where.cashier_user_id).toBe('u-rina');
  });

  it('read_all: semua sale cabang, filter kasir diteruskan bila ada (AC-RW-02)', async () => {
    const t = make();
    await t.service.list(OWNER, query());
    expect(optsOf(t.sales.findAndCount).where).toEqual({
      tenant_id: 't-A',
      branch_id: 'b-P',
    });

    const t2 = make();
    await t2.service.list(OWNER, query({ cashier_user_id: 'u-dewi' }));
    expect(optsOf(t2.sales.findAndCount).where.cashier_user_id).toBe('u-dewi');
  });

  it('tenant/cabang selalu dari JWT, bukan dari query', async () => {
    const t = make();
    await t.service.list(
      ctx(['billing.sale.read_all'], { tenantId: 't-B', branchId: 'b-Q' }),
      query(),
    );
    expect(optsOf(t.sales.findAndCount).where).toMatchObject({
      tenant_id: 't-B',
      branch_id: 'b-Q',
    });
  });

  it('status dan q (sebagian nomor, wildcard di-escape) menjadi filter', async () => {
    const t = make();
    await t.service.list(OWNER, query({ status: 'FAILED', q: ' SAL_1% ' }));
    const where = optsOf(t.sales.findAndCount).where;
    expect(where.status).toBe('FAILED');
    const q = where.sale_number as FindOperator<string>;
    expect(q).toBeInstanceOf(FindOperator);
    expect(q.type).toBe('ilike');
    expect(q.value).toBe('%SAL\\_1\\%%');
  });

  it('date_from saja: created_at >= 00:00 WIB tanggal itu (UTC-7 jam)', async () => {
    const t = make();
    await t.service.list(OWNER, query({ date_from: '2026-11-13' }));
    const op = optsOf(t.sales.findAndCount).where
      .created_at as FindOperator<Date>;
    expect(op.type).toBe('moreThanOrEqual');
    expect(op.value.toISOString()).toBe('2026-11-12T17:00:00.000Z');
  });

  it('date_to saja: created_at < 00:00 WIB hari berikutnya (inklusif tanggal itu)', async () => {
    const t = make();
    await t.service.list(OWNER, query({ date_to: '2026-11-13' }));
    const op = optsOf(t.sales.findAndCount).where
      .created_at as FindOperator<Date>;
    expect(op.type).toBe('lessThan');
    expect(op.value.toISOString()).toBe('2026-11-13T17:00:00.000Z');
  });

  it('date_from + date_to digabung dengan AND; sale 00:30 WIB masuk hari WIB-nya, bukan hari UTC', async () => {
    const t = make();
    await t.service.list(
      OWNER,
      query({ date_from: '2026-11-14', date_to: '2026-11-14' }),
    );
    const op = optsOf(t.sales.findAndCount).where
      .created_at as FindOperator<Date>;
    expect(op.type).toBe('and');
    const [from, to] = op.value as unknown as FindOperator<Date>[];
    expect(from.type).toBe('moreThanOrEqual');
    expect(to.type).toBe('lessThan');
    // 14 Nov 00:30 WIB = 13 Nov 17:30 UTC: >= 13 Nov 17:00 UTC dan < 14 Nov 17:00 UTC
    const saleAt = new Date('2026-11-13T17:30:00Z').getTime();
    expect(saleAt).toBeGreaterThanOrEqual(from.value.getTime());
    expect(saleAt).toBeLessThan(to.value.getTime());
  });

  it('tanpa userId di konteks (route internal) -> Unauthorized', async () => {
    const t = make();
    await expect(
      t.service.list(ctx(['billing.sale.read'], { userId: null }), query()),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('SaleQueryService.findOne (BR-SL-12, BR-RC-01..09)', () => {
  it('KASIR: where memuat id + tenant + cabang + miliknya; hasil = bentuk Sale lengkap', async () => {
    const t = make();
    const view = await t.service.findOne(KASIR, 'sale-1');
    expect(t.sales.findOne).toHaveBeenCalledWith({
      where: {
        id: 'sale-1',
        tenant_id: 't-A',
        branch_id: 'b-P',
        cashier_user_id: 'u-rina',
      },
      relations: { shift: true },
    });
    expect(view).toMatchObject({
      id: 'sale-1',
      sale_number: 'SAL-20261113-0007',
      status: 'PAID',
      source_type: 'OTC',
      shift_number: 'SHF-20261113-0001',
      cashier_name: 'Rina',
      tax_rate: 11,
      tax_total: 1090.09,
      grand_total: 11000,
      tendered_amount: 20000,
      change_amount: 9000,
      dispensing_number: 'DSP-20261113-0007',
      items: [
        {
          line_no: 1,
          item_code: 'OBT-0001',
          item_name: 'Paracetamol 500 mg',
          unit_name: 'Strip',
          quantity: 2,
          unit_price: 5500,
          tax_amount: 1090.09,
          line_total: 11000,
          drug_group_code: 'OBT_BEBAS',
        },
      ],
      payments: [
        {
          method_code: 'CASH',
          method_name: 'Tunai',
          amount: 11000,
          tendered_amount: 20000,
          change_amount: 9000,
        },
      ],
      receipt: {
        header: 'APOTEK SEHAT PUSAT\nJl. Mawar 1',
        footer: 'Terima kasih',
      },
    });
    // data internal tidak bocor
    expect(JSON.stringify(view)).not.toContain('rahasia');
    expect(view).not.toHaveProperty('failure_errors');
    expect(t.settings.getOrCreate).toHaveBeenCalledWith('t-A', 'b-P');
  });

  it('item & payment dibaca dengan scope tenant + cabang, urut line_no', async () => {
    const t = make();
    await t.service.findOne(KASIR, 'sale-1');
    expect(t.items.find).toHaveBeenCalledWith({
      where: { sale_id: 'sale-1', tenant_id: 't-A', branch_id: 'b-P' },
      order: { line_no: 'ASC' },
    });
    expect(t.payments.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sale_id: 'sale-1', tenant_id: 't-A', branch_id: 'b-P' },
        relations: { payment_method: true },
      }),
    );
  });

  it('read_all: tanpa filter kasir', async () => {
    const t = make();
    await t.service.findOne(OWNER, 'sale-1');
    expect(
      (t.sales.findOne.mock.calls[0] as unknown as [{ where: object }])[0]
        .where,
    ).toEqual({ id: 'sale-1', tenant_id: 't-A', branch_id: 'b-P' });
  });

  it('di luar scope (kasir lain, cabang/tenant lain) -> 404 BIL_005 (AC-RW-01, AC-RW-02)', async () => {
    const t = make({ one: null });
    let err: unknown;
    try {
      await t.service.findOne(KASIR, 'sale-dewi');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BusinessException);
    if (!(err instanceof BusinessException)) return;
    expect(err.getStatus()).toBe(404);
    expect(err.code).toBe('BIL_005');
    expect(t.items.find).not.toHaveBeenCalled();
  });

  it('sale non-PAID (FAILED/NEEDS_RECONCILIATION) tampil dengan failureMessage tanpa item (AC-RW-03)', async () => {
    const t = make({
      one: {
        ...SALE,
        status: 'NEEDS_RECONCILIATION',
        sale_number: null,
        paid_at: null,
        failure_code: 'FINALIZE_FAILED',
        failure_message: 'Penyimpanan transaksi gagal',
      },
      items: [],
      payments: [],
    });
    const view = await t.service.findOne(KASIR, 'sale-1');
    expect(view).toMatchObject({
      status: 'NEEDS_RECONCILIATION',
      sale_number: null,
      failure_code: 'FINALIZE_FAILED',
      failure_message: 'Penyimpanan transaksi gagal',
      items: [],
      payments: [],
    });
  });

  it('viewById (untuk response checkout) tanpa filter kasir', async () => {
    const t = make();
    await t.service.viewById('t-A', 'b-P', 'sale-1');
    expect(
      (t.sales.findOne.mock.calls[0] as unknown as [{ where: object }])[0]
        .where,
    ).toEqual({ id: 'sale-1', tenant_id: 't-A', branch_id: 'b-P' });
  });
});
