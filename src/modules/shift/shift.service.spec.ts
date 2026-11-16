import type { DataSource, FindManyOptions, FindOptionsWhere } from 'typeorm';
import { And, LessThan, MoreThanOrEqual } from 'typeorm';
import type { Logger } from 'winston';
import type { RequestContextData } from '../../common/context/request-context';
import { BusinessException } from '../../common/exceptions/business.exception';
import type { DocumentNumberService } from '../../common/document-number/document-number.service';
import { PaymentMethod } from '../payment-method/entities/payment-method.entity';
import { Payment } from '../sale/entities/payment.entity';
import { Sale } from '../sale/entities/sale.entity';
import { ListShiftQueryDto } from './dto/shift.dto';
import { CashierShift } from './entities/cashier-shift.entity';
import { ShiftService } from './shift.service';

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const TABLES = new Map<unknown, string>([
  [CashierShift, 'cashier_shift'],
  [Sale, 'sale'],
  [Payment, 'payment'],
  [PaymentMethod, 'payment_method'],
]);

function ctx(over: Partial<RequestContextData> = {}): RequestContextData {
  return {
    tenantId: 't-A',
    branchId: 'b-P',
    userId: 'u-rina',
    roles: ['KASIR'],
    permissions: [
      'billing.shift.open',
      'billing.shift.close',
      'billing.shift.read',
    ],
    userName: 'Rina',
    correlationId: 'req-1',
    isInternal: false,
    sessionId: 's',
    requestId: 'req-1',
    ...over,
  };
}

interface Fixture {
  /** Baris shift terkunci (hasil SELECT ... FOR UPDATE di close). */
  lockedShift?: { cashier_user_id: string; status: string } | null;
  pendingIds?: string[];
  openingCash?: string;
  cashTotal?: string;
  counts?: Record<string, number>;
  /** Error yang dilempar saat query tertentu. */
  failOn?: { match: string; error: unknown };
}

function makeEnv(f: Fixture = {}) {
  const sqlLog: { sql: string; params: unknown[] }[] = [];
  const closedRow = (over: Partial<CashierShift> = {}) =>
    ({
      id: 'sh-1',
      shift_number: 'SHF-20261113-0001',
      status: 'CLOSED',
      cashier_user_id: 'u-rina',
      cashier_name: 'Rina',
      opened_at: new Date('2026-11-13T01:00:00Z'),
      opening_cash: 200000,
      open_note: null,
      closed_at: null,
      closed_by: null,
      expected_cash: null,
      closing_cash_counted: null,
      cash_difference: null,
      close_note: null,
      ...over,
    }) as CashierShift;

  const manager = {
    queryRunner: { isTransactionActive: true },
    connection: {
      getMetadata: (e: unknown) => ({
        schema: 'billing',
        tableName: TABLES.get(e),
      }),
    },
    query: jest.fn((sql: string, params: unknown[]) => {
      const s = norm(sql);
      sqlLog.push({ sql: s, params });
      if (f.failOn && s.includes(f.failOn.match))
        return Promise.reject(
          f.failOn.error instanceof Error
            ? f.failOn.error
            : Object.assign(new Error('driver error'), f.failOn.error),
        );
      if (s.includes('FOR UPDATE NOWAIT'))
        return Promise.resolve((f.pendingIds ?? []).map((id) => ({ id })));
      if (s.includes('FOR UPDATE'))
        return Promise.resolve(
          f.lockedShift === null
            ? []
            : [f.lockedShift ?? { cashier_user_id: 'u-rina', status: 'OPEN' }],
        );
      if (s.startsWith('UPDATE')) return Promise.resolve([]);
      if (s.includes('"opening_cash"::text'))
        return Promise.resolve([
          { id: 'sh-1', opening_cash: f.openingCash ?? '200000.00' },
        ]);
      if (s.includes('COUNT(*)'))
        return Promise.resolve(
          Object.entries(f.counts ?? {}).map(([status, count]) => ({
            shift_id: 'sh-1',
            status,
            count,
          })),
        );
      if (s.includes('SUM(p."amount")'))
        return Promise.resolve(
          f.cashTotal === undefined
            ? []
            : [{ shift_id: 'sh-1', cash_total: f.cashTotal }],
        );
      return Promise.reject(new Error(`unexpected SQL: ${s}`));
    }),
    create: jest.fn((_e: unknown, data: object) => ({ ...data })),
    save: jest.fn((_e: unknown, data: object) =>
      Promise.resolve({ id: 'sh-1', ...data }),
    ),
    update: jest.fn<Promise<unknown>, [unknown, unknown, object]>(() =>
      Promise.resolve({ affected: 1 }),
    ),
    findOneOrFail: jest.fn<Promise<CashierShift>, []>(),
  };
  // Hasil findOneOrFail mengikuti update terakhir (meniru DB).
  manager.findOneOrFail.mockImplementation(() => {
    const patch = (manager.update.mock.calls[0]?.[2] ??
      {}) as Partial<CashierShift>;
    return Promise.resolve(closedRow(patch));
  });

  const repo = {
    findOne: jest.fn(),
    findAndCount: jest.fn<
      Promise<[CashierShift[], number]>,
      [FindManyOptions<CashierShift>]
    >(),
  };
  const dataSource = {
    manager,
    transaction: jest.fn((cb: (m: unknown) => unknown) =>
      Promise.resolve(cb(manager)),
    ),
    getRepository: jest.fn(() => repo),
  } as unknown as DataSource;
  const documentNumbers = {
    next: jest.fn().mockResolvedValue('SHF-20261113-0001'),
  };
  const logger = { info: jest.fn() } as unknown as Logger;
  const service = new ShiftService(
    dataSource,
    documentNumbers as unknown as DocumentNumberService,
    logger,
  );
  return { service, manager, repo, dataSource, documentNumbers, sqlLog };
}

const NOW = new Date('2026-11-13T08:00:00Z'); // 15:00 WIB

/** `where` dari panggilan ke-`i` findAndCount (objek, bukan array). */
function whereOf(
  repo: ReturnType<typeof makeEnv>['repo'],
  i: number,
): FindOptionsWhere<CashierShift> {
  return repo.findAndCount.mock.calls[i][0]
    .where as FindOptionsWhere<CashierShift>;
}

describe('ShiftService.open', () => {
  it('AC-SH-01: membuat shift OPEN dari JWT (sub, name), nomor SHF via DocumentNumberService, tanpa field cabang/kasir dari body', async () => {
    const { service, manager, documentNumbers } = makeEnv();
    const view = await service.open(
      ctx(),
      { opening_cash: 200000, open_note: '  pagi  ' },
      NOW,
    );

    expect(documentNumbers.next).toHaveBeenCalledWith(manager, {
      tenantId: 't-A',
      branchId: 'b-P',
      docType: 'SHIFT',
      now: NOW,
    });
    const created = manager.create.mock.calls[0][1] as Record<string, unknown>;
    expect(created).toMatchObject({
      tenant_id: 't-A',
      branch_id: 'b-P',
      shift_number: 'SHF-20261113-0001',
      cashier_user_id: 'u-rina',
      cashier_name: 'Rina',
      status: 'OPEN',
      opened_at: NOW,
      opening_cash: 200000,
      open_note: 'pagi',
      created_by: 'u-rina',
    });
    expect(view).toMatchObject({
      status: 'OPEN',
      shift_number: 'SHF-20261113-0001',
      cashier_name: 'Rina',
      opened_before_today: false,
      summary: {
        cash_sales_total: 0,
        expected_cash: 200000,
        sale_count: 0,
        pending_count: 0,
        failed_count: 0,
        reconciliation_count: 0,
      },
    });
  });

  it('claim name tidak ada -> cashier_name null (BR-SH-09)', async () => {
    const { service, manager } = makeEnv();
    await service.open(ctx({ userName: null }), { opening_cash: 0 }, NOW);
    expect(manager.create.mock.calls[0][1]).toMatchObject({
      cashier_name: null,
      open_note: null,
    });
  });

  it('AC-SH-02 / BR-SH-10: 23505 pada uq_cashier_shift_open -> BIL_002 (bukan 500)', async () => {
    const { service, manager } = makeEnv();
    manager.save.mockRejectedValueOnce({
      driverError: { code: '23505', constraint: 'uq_cashier_shift_open' },
    });
    const err = await service
      .open(ctx(), { opening_cash: 1 }, NOW)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BusinessException);
    expect((err as BusinessException).code).toBe('BIL_002');
  });

  it('23505 pada constraint lain (nomor shift) tidak disamarkan jadi BIL_002', async () => {
    const { service, manager } = makeEnv();
    const boom = {
      driverError: { code: '23505', constraint: 'uq_cashier_shift_number' },
    };
    manager.save.mockRejectedValueOnce(boom);
    await expect(service.open(ctx(), { opening_cash: 1 }, NOW)).rejects.toBe(
      boom,
    );
  });
});

describe('ShiftService ringkasan (BR-SH-03, BR-SH-14, AC-SH-12)', () => {
  it('AC-SH-12: expected = modal + kas tunai PAID; hitung per status; SQL menyaring is_cash, PAID, SUCCESS, tenant+branch', async () => {
    const { service, repo, sqlLog } = makeEnv({
      openingCash: '200000.00',
      cashTotal: '86000.00',
      counts: { PAID: 3, FAILED: 1, PENDING: 1 },
    });
    repo.findOne.mockResolvedValue({
      id: 'sh-1',
      shift_number: 'SHF-20261113-0001',
      status: 'OPEN',
      cashier_user_id: 'u-rina',
      cashier_name: 'Rina',
      opened_at: new Date('2026-11-13T01:00:00Z'),
      opening_cash: 200000,
    });
    const view = await service.current(ctx(), NOW);

    expect(view?.summary).toEqual({
      cash_sales_total: 86000,
      expected_cash: 286000,
      sale_count: 3,
      pending_count: 1,
      failed_count: 1,
      reconciliation_count: 0,
    });
    const cashSql = sqlLog.find((q) => q.sql.includes('SUM(p."amount")'))!;
    expect(cashSql.sql).toContain('FROM "billing"."payment" p');
    expect(cashSql.sql).toContain(
      'INNER JOIN "billing"."sale" s ON s."id" = p."sale_id"',
    );
    expect(cashSql.sql).toContain(
      'INNER JOIN "billing"."payment_method" m ON m."id" = p."payment_method_id"',
    );
    expect(cashSql.sql).toContain(`p."status" = 'SUCCESS'`);
    expect(cashSql.sql).toContain(`s."status" = 'PAID'`);
    expect(cashSql.sql).toContain('m."is_cash" = true');
    expect(cashSql.sql).toContain('p."tenant_id" = $1 AND p."branch_id" = $2');
    expect(cashSql.params).toEqual(['t-A', 'b-P', ['sh-1']]);
  });

  it('tanpa penjualan tunai: expected = modal', async () => {
    const { service, repo } = makeEnv({ openingCash: '150000.50' });
    repo.findOne.mockResolvedValue({
      id: 'sh-1',
      status: 'OPEN',
      opened_at: NOW,
    });
    const view = await service.current(ctx(), NOW);
    expect(view?.summary.expected_cash).toBe(150000.5);
  });
});

describe('ShiftService.current (BR-SH-13, BR-SH-11)', () => {
  it('AC-SH-12: tanpa shift OPEN milik user -> null, walau user pemegang read_all', async () => {
    const { service, repo } = makeEnv();
    repo.findOne.mockResolvedValue(null);
    const oki = ctx({
      userId: 'u-oki',
      permissions: ['billing.shift.read_all'],
    });
    await expect(service.current(oki, NOW)).resolves.toBeNull();
    expect(repo.findOne).toHaveBeenCalledWith({
      where: {
        tenant_id: 't-A',
        branch_id: 'b-P',
        cashier_user_id: 'u-oki',
        status: 'OPEN',
      },
    });
  });

  it('AC-SH-09: dibuka 13 Nov 21:00 WIB, dibaca 14 Nov 08:00 WIB -> openedBeforeToday true', async () => {
    const { service, repo } = makeEnv();
    repo.findOne.mockResolvedValue({
      id: 'sh-1',
      status: 'OPEN',
      opened_at: new Date('2026-11-13T14:00:00Z'), // 21:00 WIB
    });
    const view = await service.current(ctx(), new Date('2026-11-14T01:00:00Z')); // 08:00 WIB
    expect(view?.opened_before_today).toBe(true);
  });

  it('AC-SH-09 negatif: dibuka 14 Nov 00:30 WIB (13 Nov 17:30 UTC) dibaca 14 Nov 08:00 WIB -> false', async () => {
    const { service, repo } = makeEnv();
    repo.findOne.mockResolvedValue({
      id: 'sh-1',
      status: 'OPEN',
      opened_at: new Date('2026-11-13T17:30:00Z'),
    });
    const view = await service.current(ctx(), new Date('2026-11-14T01:00:00Z'));
    expect(view?.opened_before_today).toBe(false);
  });

  it('shift CLOSED tidak pernah bertanda lintas hari', async () => {
    const { service, repo } = makeEnv();
    repo.findOne.mockResolvedValue({
      id: 'sh-1',
      status: 'CLOSED',
      opened_at: new Date('2026-11-01T01:00:00Z'),
    });
    const view = await service.current(ctx(), NOW);
    expect(view?.opened_before_today).toBe(false);
  });
});

describe('ShiftService.findOne (BR-SH-13, AC-SH-11)', () => {
  it('pemegang read saja: where menyertakan cashier_user_id sendiri; tidak ketemu -> BIL_001', async () => {
    const { service, repo } = makeEnv();
    repo.findOne.mockResolvedValue(null);
    const err = await service
      .findOne(ctx(), 'sh-dewi', NOW)
      .catch((e: unknown) => e);
    expect((err as BusinessException).code).toBe('BIL_001');
    expect(repo.findOne).toHaveBeenCalledWith({
      where: {
        id: 'sh-dewi',
        tenant_id: 't-A',
        branch_id: 'b-P',
        cashier_user_id: 'u-rina',
      },
    });
  });

  it('read_all: where tanpa filter kasir tetapi tetap tenant+branch (tenant lain -> BIL_001)', async () => {
    const { service, repo } = makeEnv();
    repo.findOne.mockResolvedValue(null);
    const oki = ctx({
      userId: 'u-oki',
      permissions: ['billing.shift.read_all'],
    });
    await expect(service.findOne(oki, 'sh-x', NOW)).rejects.toMatchObject({
      code: 'BIL_001',
    });
    expect(repo.findOne).toHaveBeenCalledWith({
      where: { id: 'sh-x', tenant_id: 't-A', branch_id: 'b-P' },
    });
  });
});

describe('ShiftService.list (BR-SH-13, spec §7.5)', () => {
  const query = (over: Partial<ListShiftQueryDto> = {}): ListShiftQueryDto =>
    Object.assign(new ListShiftQueryDto(), over);

  it('AC-SH-11: pemegang read hanya melihat miliknya; urutan opened_at DESC; paginasi', async () => {
    const { service, repo } = makeEnv();
    repo.findAndCount.mockResolvedValue([[], 0]);
    await service.list(ctx(), query({ page: 2, limit: 10 }), NOW);
    expect(repo.findAndCount).toHaveBeenCalledWith({
      where: { tenant_id: 't-A', branch_id: 'b-P', cashier_user_id: 'u-rina' },
      order: { opened_at: 'DESC', id: 'DESC' },
      skip: 10,
      take: 10,
    });
  });

  it('shift soft-delete tidak ikut: find tanpa withDeleted (TypeORM menyaring deleted_at IS NULL)', async () => {
    const { service, repo } = makeEnv();
    repo.findAndCount.mockResolvedValue([[], 0]);
    await service.list(ctx(), query(), NOW);
    const opts = repo.findAndCount.mock.calls[0][0];
    expect(opts.withDeleted).toBeUndefined();
    expect(whereOf(repo, 0)).not.toHaveProperty('deleted_at');
  });

  it('pemegang read memfilter kasir lain -> kosong tanpa query', async () => {
    const { service, repo } = makeEnv();
    const page = await service.list(
      ctx(),
      query({ cashier_user_id: 'u-dewi' }),
      NOW,
    );
    expect(page.data).toEqual([]);
    expect(page.pagination.total).toBe(0);
    expect(repo.findAndCount).not.toHaveBeenCalled();
  });

  it('AC-SH-10: read_all melihat semua kasir cabang aktif; filter kasir & status diteruskan', async () => {
    const { service, repo } = makeEnv();
    repo.findAndCount.mockResolvedValue([[], 0]);
    const sari = ctx({
      userId: 'u-sari',
      permissions: ['billing.shift.read_all'],
    });
    await service.list(sari, query(), NOW);
    expect(whereOf(repo, 0)).toEqual({
      tenant_id: 't-A',
      branch_id: 'b-P',
    });
    await service.list(
      sari,
      query({ cashier_user_id: 'u-dewi', status: 'CLOSED' }),
      NOW,
    );
    expect(whereOf(repo, 1)).toEqual({
      tenant_id: 't-A',
      branch_id: 'b-P',
      cashier_user_id: 'u-dewi',
      status: 'CLOSED',
    });
  });

  it('date_from/date_to = tanggal WIB inklusif pada opened_at (00:00 WIB s/d 00:00 WIB hari berikutnya)', async () => {
    const { service, repo } = makeEnv();
    repo.findAndCount.mockResolvedValue([[], 0]);
    const sari = ctx({
      userId: 'u-sari',
      permissions: ['billing.shift.read_all'],
    });
    await service.list(
      sari,
      query({ date_from: '2026-11-13', date_to: '2026-11-14' }),
      NOW,
    );
    expect(whereOf(repo, 0).opened_at).toEqual(
      And(
        MoreThanOrEqual(new Date('2026-11-12T17:00:00.000Z')),
        LessThan(new Date('2026-11-14T17:00:00.000Z')),
      ),
    );
    await service.list(sari, query({ date_from: '2026-11-13' }), NOW);
    expect(whereOf(repo, 1).opened_at).toEqual(
      MoreThanOrEqual(new Date('2026-11-12T17:00:00.000Z')),
    );
    await service.list(sari, query({ date_to: '2026-11-13' }), NOW);
    expect(whereOf(repo, 2).opened_at).toEqual(
      LessThan(new Date('2026-11-13T17:00:00.000Z')),
    );
  });
});

describe('ShiftService.close', () => {
  const close = (
    f: Fixture,
    dto: { closing_cash_counted: number; close_note?: string | null },
    c: RequestContextData = ctx(),
  ) => {
    const env = makeEnv(f);
    return { env, run: () => env.service.close(c, 'sh-1', dto, NOW) };
  };
  const base: Fixture = {
    openingCash: '200000.00',
    cashTotal: '86000.00',
    counts: { PAID: 3, FAILED: 1 },
  };
  const codeOf = (e: unknown) => (e as BusinessException).code;

  it('AC-SH-03: kas fisik 286.000 tanpa catatan -> CLOSED, expected 286.000, selisih 0; sale FAILED & uang diterima tidak dihitung', async () => {
    const { env, run } = close(base, { closing_cash_counted: 286000 });
    const view = await run();
    expect(view).toMatchObject({
      status: 'CLOSED',
      expected_cash: 286000,
      closing_cash_counted: 286000,
      cash_difference: 0,
      close_note: null,
      closed_by: 'u-rina',
      pending_converted_count: 0,
    });
    expect(env.manager.update).toHaveBeenCalledWith(
      CashierShift,
      { id: 'sh-1', tenant_id: 't-A', branch_id: 'b-P' },
      {
        status: 'CLOSED',
        closed_at: NOW,
        closed_by: 'u-rina',
        expected_cash: 286000,
        closing_cash_counted: 286000,
        cash_difference: 0,
        close_note: null,
        updated_by: 'u-rina',
      },
    );
  });

  it('BR-SH-12 / BR-MD-05: urutan kunci shift FOR UPDATE -> sale PENDING FOR UPDATE NOWAIT (tidak menunggu), lengkap dengan scope', async () => {
    const { env, run } = close(base, { closing_cash_counted: 286000 });
    await run();
    const [first, second] = env.sqlLog;
    expect(first.sql).toBe(
      'SELECT "cashier_user_id", "status" FROM "billing"."cashier_shift" ' +
        'WHERE "id" = $1 AND "tenant_id" = $2 AND "branch_id" = $3 ' +
        'AND "deleted_at" IS NULL FOR UPDATE',
    );
    expect(first.params).toEqual(['sh-1', 't-A', 'b-P']);
    expect(second.sql).toBe(
      'SELECT "id" FROM "billing"."sale" ' +
        'WHERE "shift_id" = $1 AND "tenant_id" = $2 AND "branch_id" = $3 ' +
        `AND "status" = 'PENDING' AND "deleted_at" IS NULL FOR UPDATE NOWAIT`,
    );
    expect(second.params).toEqual(['sh-1', 't-A', 'b-P']);
  });

  it('AC-SH-04: selisih -6.000 tanpa catatan / catatan spasi -> BIL_011, tidak ada tulis; dengan catatan -> CLOSED selisih -6.000', async () => {
    for (const note of [undefined, null, '   ']) {
      const { env, run } = close(base, {
        closing_cash_counted: 280000,
        close_note: note,
      });
      expect(codeOf(await run().catch((e: unknown) => e))).toBe('BIL_011');
      expect(env.manager.update).not.toHaveBeenCalled();
      expect(env.sqlLog.some((q) => q.sql.startsWith('UPDATE'))).toBe(false);
    }
    const { run } = close(base, {
      closing_cash_counted: 280000,
      close_note: ' uang kembalian kurang ',
    });
    await expect(run()).resolves.toMatchObject({
      status: 'CLOSED',
      cash_difference: -6000,
      close_note: 'uang kembalian kurang',
    });
  });

  it('AC-SH-04: selisih +4.000 tanpa catatan -> BIL_011', async () => {
    const { run } = close(base, { closing_cash_counted: 290000 });
    expect(codeOf(await run().catch((e: unknown) => e))).toBe('BIL_011');
  });

  it('AC-SH-05 / BR-SH-06 / BR-MD-06: sale PENDING -> NEEDS_RECONCILIATION (hanya kolom T6), dihitung di pendingConvertedCount, tidak masuk expected', async () => {
    const { env, run } = close(
      { ...base, pendingIds: ['sale-1', 'sale-2'] },
      { closing_cash_counted: 286000 },
    );
    const view = await run();
    expect(view.pending_converted_count).toBe(2);
    expect(view.summary).toMatchObject({
      expected_cash: 286000,
      pending_count: 0,
      reconciliation_count: 2,
    });
    const t6 = env.sqlLog.find((q) => q.sql.startsWith('UPDATE'))!;
    expect(t6.sql).toBe(
      'UPDATE "billing"."sale" SET "status" = \'NEEDS_RECONCILIATION\', ' +
        '"failure_code" = $1, "failure_message" = $2, "updated_by" = $3, "updated_at" = now() ' +
        'WHERE "id" = ANY($4::uuid[]) AND "tenant_id" = $5 AND "branch_id" = $6 ' +
        `AND "status" = 'PENDING'`,
    );
    expect(t6.params).toEqual([
      'SHIFT_CLOSED_PENDING',
      expect.any(String),
      'u-rina',
      ['sale-1', 'sale-2'],
      't-A',
      'b-P',
    ]);
  });

  it('tanpa sale PENDING: tidak ada UPDATE sale', async () => {
    const { env, run } = close(base, { closing_cash_counted: 286000 });
    await run();
    expect(env.sqlLog.some((q) => q.sql.startsWith('UPDATE'))).toBe(false);
  });

  it('AC-SH-06 / BR-SH-12: sale sedang dikunci checkout (55P03) -> BIL_010, tidak ada tulis (shift tetap OPEN)', async () => {
    const { env, run } = close(
      {
        ...base,
        failOn: {
          match: 'FOR UPDATE NOWAIT',
          error: { driverError: { code: '55P03' } },
        },
      },
      { closing_cash_counted: 286000 },
    );
    expect(codeOf(await run().catch((e: unknown) => e))).toBe('BIL_010');
    expect(env.manager.update).not.toHaveBeenCalled();
  });

  it('error lain saat kunci tidak disamarkan jadi BIL_010', async () => {
    const boom = new Error('connection lost');
    const { run } = close(
      { ...base, failOn: { match: 'FOR UPDATE NOWAIT', error: boom } },
      { closing_cash_counted: 286000 },
    );
    await expect(run()).rejects.toBe(boom);
  });

  it('AC-SH-07: kasir lain tanpa read_all -> BIL_001; OWNER read_all bukan pemilik -> BIL_004; shift tidak diubah', async () => {
    const dewi = ctx({ userId: 'u-dewi' });
    const a = close(base, { closing_cash_counted: 1 }, dewi);
    expect(codeOf(await a.run().catch((e: unknown) => e))).toBe('BIL_001');
    expect(a.env.manager.update).not.toHaveBeenCalled();

    const oki = ctx({
      userId: 'u-oki',
      permissions: ['billing.shift.close', 'billing.shift.read_all'],
    });
    const b = close(base, { closing_cash_counted: 1 }, oki);
    expect(codeOf(await b.run().catch((e: unknown) => e))).toBe('BIL_004');
    expect(b.env.manager.update).not.toHaveBeenCalled();
    // sale tidak dikunci/diubah bila bukan pemilik
    expect(b.env.sqlLog.some((q) => q.sql.includes('NOWAIT'))).toBe(false);
  });

  it('AC-SH-08: shift sudah CLOSED (pemilik) -> BIL_004', async () => {
    const { run } = close(
      { ...base, lockedShift: { cashier_user_id: 'u-rina', status: 'CLOSED' } },
      { closing_cash_counted: 286000 },
    );
    expect(codeOf(await run().catch((e: unknown) => e))).toBe('BIL_004');
  });

  it('shift tidak ada / tenant atau cabang lain -> BIL_001 (query ber-scope tenant+branch)', async () => {
    const { env, run } = close(
      { ...base, lockedShift: null },
      { closing_cash_counted: 1 },
    );
    expect(codeOf(await run().catch((e: unknown) => e))).toBe('BIL_001');
    expect(env.sqlLog[0].params).toEqual(['sh-1', 't-A', 'b-P']);
  });

  it('pembulatan uang memakai sen: 0.1 + 0.2 tidak menimbulkan selisih semu', async () => {
    const { run } = close(
      { openingCash: '0.10', cashTotal: '0.20' },
      { closing_cash_counted: 0.3 },
    );
    await expect(run()).resolves.toMatchObject({
      expected_cash: 0.3,
      cash_difference: 0,
    });
  });
});
