import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import {
  And,
  DataSource,
  EntityManager,
  FindOptionsWhere,
  LessThan,
  MoreThanOrEqual,
} from 'typeorm';
import { Logger } from 'winston';
import { RequestContextData } from '../../common/context/request-context';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { BusinessException } from '../../common/exceptions/business.exception';
import { fromCents, toCents } from '../../common/utils/money.util';
import {
  jakartaDayStart,
  toJakartaDate,
} from '../../common/utils/jakarta-date.util';
import { DocumentNumberService } from '../../common/document-number/document-number.service';
import { PaymentMethod } from '../payment-method/entities/payment-method.entity';
import { Payment } from '../sale/entities/payment.entity';
import { Sale } from '../sale/entities/sale.entity';
import {
  CloseShiftDto,
  ListShiftQueryDto,
  OpenShiftDto,
} from './dto/shift.dto';
import { CashierShift } from './entities/cashier-shift.entity';
import { assertActiveTransaction, qualifiedTable } from './shift-table.util';

const READ_ALL_PERMISSION = 'billing.shift.read_all';
const OPEN_SHIFT_UNIQUE = 'uq_cashier_shift_open';
const PG_UNIQUE_VIOLATION = '23505';
const PG_LOCK_NOT_AVAILABLE = '55P03';
const SHIFT_CLOSED_PENDING = 'SHIFT_CLOSED_PENDING';
const SHIFT_CLOSED_PENDING_MESSAGE =
  'Shift ditutup saat transaksi masih PENDING; perlu diperiksa supervisor';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Ringkasan shift (BR-SH-14); `opening_cash` ada di level atas response. */
export interface ShiftSummary {
  cash_sales_total: number;
  expected_cash: number;
  sale_count: number;
  pending_count: number;
  failed_count: number;
  reconciliation_count: number;
}

/** Bentuk `Shift` (spec §7.5); key camelCase dibuat ResponseInterceptor. */
export interface ShiftView {
  id: string;
  shift_number: string;
  status: string;
  cashier_user_id: string;
  cashier_name: string | null;
  opened_at: Date;
  opened_before_today: boolean;
  opening_cash: number;
  open_note: string | null;
  closed_at: Date | null;
  closed_by: string | null;
  expected_cash: number | null;
  closing_cash_counted: number | null;
  cash_difference: number | null;
  close_note: string | null;
  summary: ShiftSummary;
}

interface Scope {
  tenantId: string;
  branchId: string;
  userId: string;
  readAll: boolean;
}

function scopeOf(ctx: RequestContextData): Scope {
  if (!ctx.userId) {
    // Route user selalu membawa `sub`; null hanya mungkin di route internal.
    throw new UnauthorizedException('Missing user identity');
  }
  return {
    tenantId: ctx.tenantId,
    branchId: ctx.branchId,
    userId: ctx.userId,
    readAll: ctx.permissions.includes(READ_ALL_PERMISSION),
  };
}

function pgError(err: unknown): { code?: string; constraint?: string } {
  const e = err as {
    code?: string;
    constraint?: string;
    driverError?: { code?: string; constraint?: string };
  };
  return {
    code: e?.driverError?.code ?? e?.code,
    constraint: e?.driverError?.constraint ?? e?.constraint,
  };
}

function cleanNote(note: string | null | undefined): string | null {
  const trimmed = note?.trim();
  return trimmed ? trimmed : null;
}

@Injectable()
export class ShiftService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly documentNumbers: DocumentNumberService,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  /** Buka shift (BR-SH-01, 02, 09, 10). `now` bisa disuplai test. */
  async open(
    ctx: RequestContextData,
    dto: OpenShiftDto,
    now: Date = new Date(),
  ): Promise<ShiftView> {
    const scope = scopeOf(ctx);
    try {
      const view = await this.dataSource.transaction(async (manager) => {
        const shiftNumber = await this.documentNumbers.next(manager, {
          tenantId: scope.tenantId,
          branchId: scope.branchId,
          docType: 'SHIFT',
          now,
        });
        const shift = await manager.save(
          CashierShift,
          manager.create(CashierShift, {
            tenant_id: scope.tenantId,
            branch_id: scope.branchId,
            shift_number: shiftNumber,
            cashier_user_id: scope.userId,
            cashier_name: ctx.userName,
            status: 'OPEN',
            opened_at: now,
            opening_cash: dto.opening_cash,
            open_note: cleanNote(dto.open_note),
            closed_at: null,
            closed_by: null,
            expected_cash: null,
            closing_cash_counted: null,
            cash_difference: null,
            close_note: null,
            created_by: scope.userId,
            updated_by: scope.userId,
          }),
        );
        const summaries = await this.summaries(manager, scope, [shift.id]);
        return this.toView(shift, summaries.get(shift.id)!, now);
      });
      this.logger.info('shift_opened', this.logMeta(ctx, view.id));
      return view;
    } catch (err) {
      // Race buka shift: kalah di unique parsial -> BIL_002, bukan 500 (BR-SH-10).
      const { code, constraint } = pgError(err);
      if (code === PG_UNIQUE_VIOLATION && constraint === OPEN_SHIFT_UNIQUE) {
        throw new BusinessException('BIL_002');
      }
      throw err;
    }
  }

  /** Shift OPEN milik user (atau null), tanpa memandang `read_all` (BR-SH-13). */
  async current(
    ctx: RequestContextData,
    now: Date = new Date(),
  ): Promise<ShiftView | null> {
    const scope = scopeOf(ctx);
    const shift = await this.dataSource.getRepository(CashierShift).findOne({
      where: {
        tenant_id: scope.tenantId,
        branch_id: scope.branchId,
        cashier_user_id: scope.userId,
        status: 'OPEN',
      },
    });
    if (!shift) return null;
    const summaries = await this.summaries(this.dataSource.manager, scope, [
      shift.id,
    ]);
    return this.toView(shift, summaries.get(shift.id)!, now);
  }

  /** Detail shift; di luar scope baca -> BIL_001 (BR-SH-13). */
  async findOne(
    ctx: RequestContextData,
    id: string,
    now: Date = new Date(),
  ): Promise<ShiftView> {
    const scope = scopeOf(ctx);
    const shift = await this.dataSource.getRepository(CashierShift).findOne({
      where: {
        id,
        tenant_id: scope.tenantId,
        branch_id: scope.branchId,
        ...(scope.readAll ? {} : { cashier_user_id: scope.userId }),
      },
    });
    if (!shift) throw new BusinessException('BIL_001');
    const summaries = await this.summaries(this.dataSource.manager, scope, [
      shift.id,
    ]);
    return this.toView(shift, summaries.get(shift.id)!, now);
  }

  /** Daftar shift cabang aktif; tanpa `read_all` hanya milik sendiri (BR-SH-13). */
  async list(
    ctx: RequestContextData,
    query: ListShiftQueryDto,
    now: Date = new Date(),
  ): Promise<PaginatedResult<ShiftView>> {
    const scope = scopeOf(ctx);
    const empty = new PaginatedResult<ShiftView>(
      [],
      0,
      query.page,
      query.limit,
    );

    let cashierUserId = query.cashier_user_id;
    if (!scope.readAll) {
      if (cashierUserId && cashierUserId !== scope.userId) return empty;
      cashierUserId = scope.userId;
    }

    const where: FindOptionsWhere<CashierShift> = {
      tenant_id: scope.tenantId,
      branch_id: scope.branchId,
    };
    if (cashierUserId) where.cashier_user_id = cashierUserId;
    if (query.status) where.status = query.status;

    // date_from/date_to = tanggal WIB inklusif, dicocokkan ke opened_at (index idx_cashier_shift_opened_at).
    const ranges = [];
    if (query.date_from)
      ranges.push(MoreThanOrEqual(jakartaDayStart(query.date_from)));
    if (query.date_to) {
      ranges.push(
        LessThan(new Date(jakartaDayStart(query.date_to).getTime() + DAY_MS)),
      );
    }
    if (ranges.length === 1) where.opened_at = ranges[0];
    if (ranges.length === 2) where.opened_at = And(...ranges);

    const [rows, total] = await this.dataSource
      .getRepository(CashierShift)
      .findAndCount({
        where,
        order: { opened_at: 'DESC', id: 'DESC' },
        skip: query.skip,
        take: query.limit,
      });
    const summaries = await this.summaries(
      this.dataSource.manager,
      scope,
      rows.map((r) => r.id),
    );
    return new PaginatedResult(
      rows.map((r) => this.toView(r, summaries.get(r.id)!, now)),
      total,
      query.page,
      query.limit,
    );
  }

  /**
   * Tutup shift (BR-SH-04..06, BR-SH-12, BR-MD-05, BR-MD-06). Satu transaksi:
   * (1) shift FOR UPDATE; (2) sale PENDING FOR UPDATE NOWAIT; (3) hitung kas;
   * (4) PENDING -> NEEDS_RECONCILIATION (T6); (5) tutup shift. NOWAIT sengaja
   * tidak boleh diganti menunggu: konflik -> 409 BIL_010 + rollback (bebas deadlock).
   */
  async close(
    ctx: RequestContextData,
    id: string,
    dto: CloseShiftDto,
    now: Date = new Date(),
  ): Promise<ShiftView & { pending_converted_count: number }> {
    const scope = scopeOf(ctx);
    try {
      const result = await this.dataSource.transaction(async (manager) => {
        assertActiveTransaction(manager, 'ShiftService.close');
        const shiftTable = qualifiedTable(manager, CashierShift);
        const saleTable = qualifiedTable(manager, Sale);

        // (1) Kunci shift.
        const locked: { cashier_user_id: string; status: string }[] =
          await manager.query(
            `SELECT "cashier_user_id", "status"
               FROM ${shiftTable}
              WHERE "id" = $1 AND "tenant_id" = $2 AND "branch_id" = $3
                AND "deleted_at" IS NULL
                FOR UPDATE`,
            [id, scope.tenantId, scope.branchId],
          );
        const row = locked[0];
        const isOwner = row?.cashier_user_id === scope.userId;
        // Di luar scope baca -> 404 (jangan bocorkan keberadaan); terlihat tapi
        // bukan milik user / sudah CLOSED -> 409 (BR-SH-04).
        if (!row || !(scope.readAll || isOwner)) {
          throw new BusinessException('BIL_001');
        }
        if (!isOwner || row.status !== 'OPEN') {
          throw new BusinessException('BIL_004');
        }

        // (2) Kunci sale PENDING tanpa menunggu (BR-SH-12).
        const pending: { id: string }[] = await manager.query(
          `SELECT "id"
             FROM ${saleTable}
            WHERE "shift_id" = $1 AND "tenant_id" = $2 AND "branch_id" = $3
              AND "status" = 'PENDING' AND "deleted_at" IS NULL
              FOR UPDATE NOWAIT`,
          [id, scope.tenantId, scope.branchId],
        );

        // (3) Kas seharusnya dari data terkunci.
        const summary = (await this.summaries(manager, scope, [id])).get(id)!;
        const expectedCents = toCents(summary.expected_cash);
        const countedCents = toCents(dto.closing_cash_counted);
        const diffCents = countedCents - expectedCents;
        const closeNote = cleanNote(dto.close_note);
        if (diffCents !== 0 && closeNote === null) {
          throw new BusinessException('BIL_011');
        }

        // (4) T6: hanya status, failure_code, failure_message, updated_* (BR-MD-06).
        if (pending.length > 0) {
          await manager.query(
            `UPDATE ${saleTable}
                SET "status" = 'NEEDS_RECONCILIATION',
                    "failure_code" = $1,
                    "failure_message" = $2,
                    "updated_by" = $3,
                    "updated_at" = now()
              WHERE "id" = ANY($4::uuid[]) AND "tenant_id" = $5
                AND "branch_id" = $6 AND "status" = 'PENDING'`,
            [
              SHIFT_CLOSED_PENDING,
              SHIFT_CLOSED_PENDING_MESSAGE,
              scope.userId,
              pending.map((p) => p.id),
              scope.tenantId,
              scope.branchId,
            ],
          );
        }

        // (5) Tutup shift.
        await manager.update(
          CashierShift,
          { id, tenant_id: scope.tenantId, branch_id: scope.branchId },
          {
            status: 'CLOSED',
            closed_at: now,
            closed_by: scope.userId,
            expected_cash: fromCents(expectedCents),
            closing_cash_counted: fromCents(countedCents),
            cash_difference: fromCents(diffCents),
            close_note: closeNote,
            updated_by: scope.userId,
          },
        );
        const shift = await manager.findOneOrFail(CashierShift, {
          where: { id, tenant_id: scope.tenantId, branch_id: scope.branchId },
        });
        const converted = pending.length;
        const view = this.toView(
          shift,
          {
            ...summary,
            pending_count: 0,
            reconciliation_count: summary.reconciliation_count + converted,
          },
          now,
        );
        return { ...view, pending_converted_count: converted };
      });
      this.logger.info('shift_closed', {
        ...this.logMeta(ctx, id),
        pendingConvertedCount: result.pending_converted_count,
      });
      return result;
    } catch (err) {
      // Ada sale yang sedang dikunci checkout -> rollback, shift tetap OPEN.
      if (pgError(err).code === PG_LOCK_NOT_AVAILABLE) {
        throw new BusinessException('BIL_010');
      }
      throw err;
    }
  }

  /**
   * Ringkasan per shift (BR-SH-03, BR-SH-14): kas seharusnya = modal + Σ payment
   * metode tunai dari sale PAID. Dua query agregat untuk semua shift sekaligus.
   */
  private async summaries(
    manager: EntityManager,
    scope: Scope,
    shiftIds: string[],
  ): Promise<Map<string, ShiftSummary>> {
    const result = new Map<string, ShiftSummary>();
    if (shiftIds.length === 0) return result;

    const shiftTable = qualifiedTable(manager, CashierShift);
    const saleTable = qualifiedTable(manager, Sale);
    const paymentTable = qualifiedTable(manager, Payment);
    const methodTable = qualifiedTable(manager, PaymentMethod);
    const params = [scope.tenantId, scope.branchId, shiftIds];

    const openings: { id: string; opening_cash: string }[] =
      await manager.query(
        `SELECT "id", "opening_cash"::text AS "opening_cash"
           FROM ${shiftTable}
          WHERE "tenant_id" = $1 AND "branch_id" = $2
            AND "id" = ANY($3::uuid[]) AND "deleted_at" IS NULL`,
        params,
      );
    const counts: { shift_id: string; status: string; count: number }[] =
      await manager.query(
        `SELECT "shift_id", "status", COUNT(*)::int AS "count"
           FROM ${saleTable}
          WHERE "tenant_id" = $1 AND "branch_id" = $2
            AND "shift_id" = ANY($3::uuid[]) AND "deleted_at" IS NULL
          GROUP BY "shift_id", "status"`,
        params,
      );
    const cash: { shift_id: string; cash_total: string }[] =
      await manager.query(
        `SELECT p."shift_id", COALESCE(SUM(p."amount"), 0)::text AS "cash_total"
           FROM ${paymentTable} p
          INNER JOIN ${saleTable} s ON s."id" = p."sale_id"
          INNER JOIN ${methodTable} m ON m."id" = p."payment_method_id"
          WHERE p."tenant_id" = $1 AND p."branch_id" = $2
            AND p."shift_id" = ANY($3::uuid[])
            AND p."status" = 'SUCCESS' AND p."deleted_at" IS NULL
            AND s."status" = 'PAID' AND s."deleted_at" IS NULL
            AND m."is_cash" = true
          GROUP BY p."shift_id"`,
        params,
      );

    for (const o of openings) {
      const cashTotal = toCents(
        cash.find((c) => c.shift_id === o.id)?.cash_total ?? '0',
      );
      const countOf = (status: string): number =>
        counts.find((c) => c.shift_id === o.id && c.status === status)?.count ??
        0;
      result.set(o.id, {
        cash_sales_total: fromCents(cashTotal),
        expected_cash: fromCents(toCents(o.opening_cash) + cashTotal),
        sale_count: countOf('PAID'),
        pending_count: countOf('PENDING'),
        failed_count: countOf('FAILED'),
        reconciliation_count: countOf('NEEDS_RECONCILIATION'),
      });
    }
    return result;
  }

  private toView(
    shift: CashierShift,
    summary: ShiftSummary,
    now: Date,
  ): ShiftView {
    const isOpen = shift.status === 'OPEN';
    return {
      id: shift.id,
      shift_number: shift.shift_number,
      status: shift.status,
      cashier_user_id: shift.cashier_user_id,
      cashier_name: shift.cashier_name,
      opened_at: shift.opened_at,
      // BR-SH-11: dihitung server (WIB); hanya bermakna untuk shift yang masih OPEN.
      opened_before_today:
        isOpen && toJakartaDate(shift.opened_at) < toJakartaDate(now),
      opening_cash: shift.opening_cash,
      open_note: shift.open_note,
      closed_at: shift.closed_at,
      closed_by: shift.closed_by,
      expected_cash: shift.expected_cash,
      closing_cash_counted: shift.closing_cash_counted,
      cash_difference: shift.cash_difference,
      close_note: shift.close_note,
      summary: summary,
    };
  }

  private logMeta(ctx: RequestContextData, shiftId: string) {
    return {
      action: 'shift',
      requestId: ctx.requestId,
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      shiftId,
    };
  }
}
