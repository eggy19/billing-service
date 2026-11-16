import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { DataSource, EntityManager } from 'typeorm';
import { Logger } from 'winston';
import { ERROR_CODES, ErrorCodeKey } from '../../common/constants/error-codes';
import { RequestContextData } from '../../common/context/request-context';
import { DocumentNumberService } from '../../common/document-number/document-number.service';
import {
  BusinessException,
  ErrorFieldDetail,
} from '../../common/exceptions/business.exception';
import { fromCents, toCents } from '../../common/utils/money.util';
import {
  CASH_METHOD_CODE,
  PaymentMethod,
} from '../payment-method/entities/payment-method.entity';
import { PaymentMethodService } from '../payment-method/payment-method.service';
import { BillingSettingService } from '../setting/billing-setting.service';
import {
  SHIFT_GUARD,
  type ShiftActor,
  type ShiftGuard,
} from '../shift/shift-guard.port';
import {
  assertActiveTransaction,
  qualifiedTable,
} from '../shift/shift-table.util';
import {
  parseDispensingResponse,
  peekDispensingId,
} from './dispensing-response';
import { CreateSaleDto } from './dto/sale.dto';
import { Payment } from './entities/payment.entity';
import { SaleItem } from './entities/sale-item.entity';
import { Sale, SaleRequestItem } from './entities/sale.entity';
import {
  INVENTORY_DISPENSING_CLIENT,
  type DispensingRequest,
  type InventoryDispensingClient,
} from './inventory/inventory-dispensing.port';
import {
  computeRequestHash,
  previewTotals,
  taxInclusiveCents,
} from './sale-calc.util';
import { SaleQueryService } from './sale-query.service';
import { SaleView } from './sale-view';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PG_UNIQUE_VIOLATION = '23505';
const PG_LOCK_NOT_AVAILABLE = '55P03';
const IDEMPOTENCY_UNIQUE = 'uq_sale_idempotency';
const REFERENCE_TYPE = 'billing.sale';
const SAVEPOINT = 'sale_finalize';
const MAX_FAILURE_CODE_LENGTH = 40;

/** Kode Inventory yang berarti "item tidak dapat dijual" (BR-SL-06 -> BIL_014). */
const NOT_SELLABLE_CODES = new Set([
  'INV_060',
  'INV_061',
  'INV_018',
  'INV_054',
  'INV_001',
  'INV_021',
]);

type RejectionKey = 'BIL_012' | 'BIL_013' | 'BIL_014' | 'BIL_017';

/** Pemetaan penolakan 4xx Inventory (BR-SL-06). Dipakai juga saat replay sale FAILED. */
export function mapRejection(code: string | null): {
  key: RejectionKey;
  saleStatus: 'FAILED' | 'NEEDS_RECONCILIATION';
} {
  if (code === 'INV_062') return { key: 'BIL_012', saleStatus: 'FAILED' };
  if (code === 'INV_003') return { key: 'BIL_013', saleStatus: 'FAILED' };
  if (code && NOT_SELLABLE_CODES.has(code)) {
    return { key: 'BIL_014', saleStatus: 'FAILED' };
  }
  // INV_063: referensi sudah punya dispensing lain, stok mungkin terpotong.
  if (code === 'INV_063') {
    return { key: 'BIL_017', saleStatus: 'NEEDS_RECONCILIATION' };
  }
  // 400/401/403/404 route dan 4xx tak dikenal: bug integrasi, stok pasti tidak terpotong.
  return { key: 'BIL_017', saleStatus: 'FAILED' };
}

/** `failure_code` + pesan untuk transisi ke NEEDS_RECONCILIATION (BR-SL-17, BR-SL-19). */
const RECON = {
  INV_063:
    'Referensi penjualan sudah memiliki dispensing lain di Inventory; stok mungkin terpotong',
  INVENTORY_UNEXPECTED_STATUS:
    'Status respons Inventory tidak dikenal; stok mungkin sudah terpotong',
  INVENTORY_RESPONSE_INVALID:
    'Respons Inventory tidak valid; stok mungkin sudah terpotong',
  TOTAL_MISMATCH:
    'Total dari Inventory berbeda dari total transaksi; stok sudah terpotong',
  SHIFT_CLOSED_DURING_CHECKOUT:
    'Shift ditutup saat transaksi diproses; stok sudah terpotong',
  FINALIZE_FAILED:
    'Penyimpanan transaksi gagal setelah stok terpotong; perlu diperiksa supervisor',
  UNEXPECTED_AFTER_DISPENSING:
    'Terjadi kesalahan setelah stok terpotong; perlu diperiksa supervisor',
} as const;
type ReconCode = keyof typeof RECON;

export interface CheckoutResult {
  sale: SaleView;
  /** true = replay sale PAID (HTTP 200); false = baru selesai (HTTP 201). */
  replayed: boolean;
}

type Scope = ShiftActor;

type TxbOutcome =
  | { kind: 'PAID' }
  | { kind: 'ERROR'; error: BusinessException }
  | { kind: 'EXISTING'; sale: Sale };

/** Jejak per eksekusi TX-B untuk log/penanganan error tak terduga setelah stok terpotong. */
interface Trace {
  dispensingId: string | null;
  dispensingNumber: string | null;
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

function normalizeName(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  return trimmed ? trimmed : null;
}

function errorsOf(value: unknown): ErrorFieldDetail[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = (value as unknown[]).filter(
    (e): e is ErrorFieldDetail =>
      typeof e === 'object' &&
      e !== null &&
      typeof (e as ErrorFieldDetail).field === 'string' &&
      typeof (e as ErrorFieldDetail).message === 'string',
  );
  return out.length > 0 ? out : undefined;
}

/**
 * Checkout penjualan OTC tunai (BL-16; spec §4.3, §5.5, §6.2).
 *
 * TX-A: kunci shift (ShiftGuard) + insert sale PENDING, commit.
 * TX-B: `sale FOR UPDATE NOWAIT` dipegang selama panggilan Inventory sampai
 * finalisasi (KB-17, supaya tutup shift yang NOWAIT mendapat BIL_010 dan tidak
 * ada checkout ganda). Nomor SAL diminta paling akhir (sedekat mungkin dengan
 * commit) agar kunci baris sequence hanya ditahan sebentar. Hasil akhir sale
 * (FAILED / NEEDS_RECONCILIATION) di-commit dulu, baru error dilempar.
 */
@Injectable()
export class SaleService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly documentNumbers: DocumentNumberService,
    private readonly settings: BillingSettingService,
    private readonly paymentMethods: PaymentMethodService,
    private readonly queries: SaleQueryService,
    @Inject(SHIFT_GUARD) private readonly shiftGuard: ShiftGuard,
    @Inject(INVENTORY_DISPENSING_CLIENT)
    private readonly inventory: InventoryDispensingClient,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  /** `now` hanya untuk test; default = waktu finalisasi (paid_at & tanggal nomor SAL). */
  async checkout(
    ctx: RequestContextData,
    idempotencyKey: string | undefined,
    dto: CreateSaleDto,
    now?: Date,
  ): Promise<CheckoutResult> {
    const scope = scopeOf(ctx);
    if (!idempotencyKey || !UUID_RE.test(idempotencyKey)) {
      throw new BusinessException('BIL_008');
    }
    const key = idempotencyKey.toLowerCase();

    const customerName = normalizeName(dto.customer_name);
    const requestHash = computeRequestHash({
      branchId: scope.branchId,
      customerName,
      items: dto.items,
      payments: dto.payments,
    });

    // BR-SL-04: key yang sudah ada dicek SEBELUM validasi BR-SL-03.
    const existing = await this.findByKey(scope.tenantId, key);
    if (existing) {
      return this.handleExisting(ctx, scope, existing, requestHash, now);
    }

    // Baris ganda dicek setelah replay: key lama + isi berbeda harus BIL_009.
    this.assertNoDuplicateLines(dto);

    // BR-SL-03: metode bayar, uang diterima, lalu shift (di TX-A).
    if (
      dto.payments.length !== 1 ||
      dto.payments[0].method_code !== CASH_METHOD_CODE
    ) {
      throw new BusinessException('BIL_007');
    }
    const method = await this.paymentMethods.findActiveByCode(
      scope.tenantId,
      scope.branchId,
      CASH_METHOD_CODE,
    );
    if (!method) throw new BusinessException('BIL_007');

    const setting = await this.settings.getOrCreate(
      scope.tenantId,
      scope.branchId,
    );
    const ratePct100 = toCents(setting.tax_rate);
    const preview = previewTotals(dto.items, ratePct100);
    if (!preview) {
      throw new BusinessException(
        'VALIDATION_ERROR',
        'Total transaksi melebihi batas yang diizinkan',
      );
    }
    const tenderedCents = toCents(dto.payments[0].tendered_amount);
    if (tenderedCents < preview.totalCents) {
      throw new BusinessException('BIL_006');
    }

    let sale: Sale;
    try {
      sale = await this.createPending(ctx, scope, {
        key,
        requestHash,
        customerName,
        taxRate: setting.tax_rate,
        totalCents: preview.totalCents,
        taxCents: preview.taxCents,
        tenderedCents,
        items: dto.items.map((i) => ({
          item_id: i.item_id,
          unit_id: i.unit_id,
          quantity: i.quantity,
          expected_unit_price: i.expected_unit_price,
        })),
      });
    } catch (err) {
      // Dua request pertama dengan key sama bersamaan: yang kalah membaca ulang
      // sale pemenang dan memakai perilaku replay (PENDING terkunci -> BIL_010).
      const { code, constraint } = pgError(err);
      if (code === PG_UNIQUE_VIOLATION && constraint === IDEMPOTENCY_UNIQUE) {
        const winner = await this.findByKey(scope.tenantId, key);
        if (winner) {
          return this.handleExisting(ctx, scope, winner, requestHash, now);
        }
      }
      throw err;
    }
    this.logger.info('sale_pending_created', this.logMeta(ctx, sale.id));
    return this.process(ctx, scope, sale, method, now);
  }

  /** BR-SL-04: perilaku bila key sudah ada. */
  private async handleExisting(
    ctx: RequestContextData,
    scope: Scope,
    existing: Sale,
    requestHash: string,
    now: Date | undefined,
  ): Promise<CheckoutResult> {
    // BR-SL-14: kasir/cabang lain atau isi berbeda -> BIL_009 tanpa data sale.
    if (
      existing.cashier_user_id !== scope.userId ||
      existing.branch_id !== scope.branchId ||
      existing.request_hash !== requestHash
    ) {
      throw new BusinessException('BIL_009');
    }
    switch (existing.status) {
      case 'PAID':
        return {
          sale: await this.queries.viewById(
            scope.tenantId,
            scope.branchId,
            existing.id,
          ),
          replayed: true,
        };
      case 'FAILED':
        throw this.failedError(existing);
      case 'PENDING': {
        const method = await this.paymentMethods.findActiveByCode(
          scope.tenantId,
          scope.branchId,
          CASH_METHOD_CODE,
        );
        if (!method) throw new BusinessException('BIL_007');
        return this.process(ctx, scope, existing, method, now);
      }
      default:
        // NEEDS_RECONCILIATION (dan VOIDED yang dicadangkan).
        throw this.reconciliationError(existing);
    }
  }

  /** TX-A (BR-SL-16): kunci shift OPEN milik user lalu insert sale PENDING. */
  private createPending(
    ctx: RequestContextData,
    scope: Scope,
    p: {
      key: string;
      requestHash: string;
      customerName: string | null;
      taxRate: number;
      totalCents: number;
      taxCents: number;
      tenderedCents: number;
      items: SaleRequestItem[];
    },
  ): Promise<Sale> {
    return this.dataSource.transaction(async (manager) => {
      const shift = await this.shiftGuard.lockOpenShiftForSale(manager, scope);
      return manager.save(
        Sale,
        manager.create(Sale, {
          tenant_id: scope.tenantId,
          branch_id: scope.branchId,
          sale_number: null,
          shift_id: shift.id,
          cashier_user_id: scope.userId,
          cashier_name: shift.cashierName ?? ctx.userName,
          source_type: 'OTC',
          source_id: null,
          patient_id: null,
          customer_name: p.customerName,
          status: 'PENDING',
          idempotency_key: p.key,
          request_hash: p.requestHash,
          subtotal: fromCents(p.totalCents),
          discount_total: 0,
          tax_rate: p.taxRate,
          tax_total: fromCents(p.taxCents),
          grand_total: fromCents(p.totalCents),
          paid_total: 0,
          tendered_amount: fromCents(p.tenderedCents),
          request_items: p.items,
          change_amount: 0,
          dispensing_id: null,
          dispensing_number: null,
          paid_at: null,
          failure_code: null,
          failure_message: null,
          failure_errors: null,
          created_by: scope.userId,
          updated_by: scope.userId,
        }),
      );
    });
  }

  /** Langkah 5-7 (TX-B) lalu respons; error terjadi setelah transaksi di-commit. */
  private async process(
    ctx: RequestContextData,
    scope: Scope,
    sale: Sale,
    method: PaymentMethod,
    now: Date | undefined,
  ): Promise<CheckoutResult> {
    const trace: Trace = { dispensingId: null, dispensingNumber: null };
    let outcome: TxbOutcome;
    try {
      outcome = await this.dataSource.transaction((manager) =>
        this.runTxB(manager, ctx, scope, sale, method, now, trace),
      );
    } catch (err) {
      // Sale sedang dikunci request lain (atau tutup shift): BR-SL-04 / KB-17.
      if (pgError(err).code === PG_LOCK_NOT_AVAILABLE) {
        throw new BusinessException('BIL_010');
      }
      if (trace.dispensingId) {
        // Stok sudah terpotong tetapi transaksi gagal dengan error tak terduga.
        this.logReconciliation(
          ctx,
          sale.id,
          trace,
          'UNEXPECTED_AFTER_DISPENSING',
        );
        await this.markReconciliationBestEffort(
          scope,
          sale.id,
          'UNEXPECTED_AFTER_DISPENSING',
        );
        throw this.integrationError(sale.id, null);
      }
      throw err;
    }

    if (outcome.kind === 'ERROR') throw outcome.error;
    if (outcome.kind === 'EXISTING') {
      // BR-SL-18: status berubah selagi menunggu kunci; Inventory tidak dipanggil.
      return this.handleExistingStatus(scope, outcome.sale);
    }
    this.logger.info('checkout_completed', this.logMeta(ctx, sale.id));
    return {
      sale: await this.queries.viewById(
        scope.tenantId,
        scope.branchId,
        sale.id,
      ),
      replayed: false,
    };
  }

  /** Perilaku BR-SL-04 untuk sale yang sudah bukan PENDING (hash & pemilik sudah cocok). */
  private async handleExistingStatus(
    scope: Scope,
    sale: Sale,
  ): Promise<CheckoutResult> {
    if (sale.status === 'PAID') {
      return {
        sale: await this.queries.viewById(
          scope.tenantId,
          scope.branchId,
          sale.id,
        ),
        replayed: true,
      };
    }
    if (sale.status === 'FAILED') throw this.failedError(sale);
    throw this.reconciliationError(sale);
  }

  private async runTxB(
    manager: EntityManager,
    ctx: RequestContextData,
    scope: Scope,
    sale: Sale,
    method: PaymentMethod,
    now: Date | undefined,
    trace: Trace,
  ): Promise<TxbOutcome> {
    assertActiveTransaction(manager, 'SaleService.checkout');
    const saleTable = qualifiedTable(manager, Sale);

    // Langkah 5: kunci sale tanpa menunggu (55P03 -> BIL_010 di process()).
    const locked: { status: string }[] = await manager.query(
      `SELECT "status"
         FROM ${saleTable}
        WHERE "id" = $1 AND "tenant_id" = $2 AND "branch_id" = $3
          AND "deleted_at" IS NULL
          FOR UPDATE NOWAIT`,
      [sale.id, scope.tenantId, scope.branchId],
    );
    if (!locked[0]) throw new Error('sale row vanished before checkout');
    if (locked[0].status !== 'PENDING') {
      const fresh = await manager.findOneOrFail(Sale, {
        where: {
          id: sale.id,
          tenant_id: scope.tenantId,
          branch_id: scope.branchId,
        },
      });
      return { kind: 'EXISTING', sale: fresh };
    }

    const request: DispensingRequest = {
      idempotency_key: `${REFERENCE_TYPE}:${sale.id}`,
      reference_type: REFERENCE_TYPE,
      reference_id: sale.id,
      items: sale.request_items.map((i) => ({
        item_id: i.item_id,
        unit_id: i.unit_id,
        quantity: Number(i.quantity),
        expected_unit_price: Number(i.expected_unit_price),
      })),
    };
    const result = await this.inventory.createDispensing(request, {
      tenantId: scope.tenantId,
      branchId: scope.branchId,
      userId: scope.userId,
      requestId: ctx.requestId,
      saleId: sale.id,
    });

    // BR-SL-06: pemetaan hasil Inventory.
    if (result.kind === 'UNAVAILABLE') {
      // T4: sale tetap PENDING, retry FE dengan key sama.
      this.logger.warn('inventory_unavailable', {
        ...this.logMeta(ctx, sale.id),
        attempts: result.attempts,
        reason: result.reason,
      });
      return { kind: 'ERROR', error: new BusinessException('BIL_015') };
    }
    if (result.kind === 'REJECTED') {
      const mapped = mapRejection(result.code);
      const failureCode = (result.code ?? `HTTP_${result.httpStatus}`).slice(
        0,
        MAX_FAILURE_CODE_LENGTH,
      );
      if (mapped.saleStatus === 'NEEDS_RECONCILIATION') {
        await this.markReconciliation(manager, scope, sale.id, 'INV_063');
        this.logReconciliation(ctx, sale.id, trace, 'INV_063');
      } else {
        await manager.update(Sale, this.whereOf(scope, sale.id), {
          status: 'FAILED',
          failure_code: failureCode,
          failure_message: ERROR_CODES[mapped.key].message,
          // errors[] hanya untuk BIL_012/013/014 (§8.4); nama field internal
          // dari bug integrasi (BIL_017) tidak disimpan maupun dikirim ke kasir.
          failure_errors: mapped.key === 'BIL_017' ? null : result.errors,
          updated_by: scope.userId,
        });
        if (mapped.key === 'BIL_017') {
          this.logger.error('inventory_rejected_integration_error', {
            ...this.logMeta(ctx, sale.id),
            httpStatus: result.httpStatus,
            inventoryCode: result.code,
          });
        } else {
          this.logger.info('sale_failed', {
            ...this.logMeta(ctx, sale.id),
            inventoryCode: result.code,
          });
        }
      }
      return {
        kind: 'ERROR',
        error: new BusinessException(mapped.key, undefined, {
          ...(mapped.key !== 'BIL_017' &&
          result.errors &&
          result.errors.length > 0
            ? { errors: result.errors }
            : {}),
          ...(mapped.key === 'BIL_017'
            ? { details: { saleId: sale.id, saleNumber: null } }
            : {}),
        }),
      };
    }
    if (result.kind === 'UNEXPECTED') {
      await this.markReconciliation(
        manager,
        scope,
        sale.id,
        'INVENTORY_UNEXPECTED_STATUS',
      );
      this.logReconciliation(
        ctx,
        sale.id,
        trace,
        'INVENTORY_UNEXPECTED_STATUS',
      );
      return { kind: 'ERROR', error: this.integrationError(sale.id, null) };
    }

    // 2xx: validasi bentuk response (BR-IN-03), lalu total (BR-SL-07).
    trace.dispensingId = peekDispensingId(result.body);
    const parsed = parseDispensingResponse(result.body, sale.request_items);
    if (!parsed) {
      await this.markReconciliation(
        manager,
        scope,
        sale.id,
        'INVENTORY_RESPONSE_INVALID',
      );
      this.logReconciliation(ctx, sale.id, trace, 'INVENTORY_RESPONSE_INVALID');
      return { kind: 'ERROR', error: this.integrationError(sale.id, null) };
    }
    trace.dispensingId = parsed.dispensingId;
    trace.dispensingNumber = parsed.dispensingNumber;

    if (parsed.grandTotalCents !== toCents(sale.grand_total)) {
      await this.markReconciliation(manager, scope, sale.id, 'TOTAL_MISMATCH');
      this.logReconciliation(ctx, sale.id, trace, 'TOTAL_MISMATCH');
      return { kind: 'ERROR', error: this.integrationError(sale.id, null) };
    }

    // Langkah 7 (BR-SL-17): shift masih OPEN?
    const shiftOpen = await this.shiftGuard.isShiftOpenForFinalize(
      manager,
      sale.shift_id,
      scope,
    );
    if (!shiftOpen) {
      await this.markReconciliation(
        manager,
        scope,
        sale.id,
        'SHIFT_CLOSED_DURING_CHECKOUT',
      );
      this.logReconciliation(
        ctx,
        sale.id,
        trace,
        'SHIFT_CLOSED_DURING_CHECKOUT',
      );
      return { kind: 'ERROR', error: this.integrationError(sale.id, null) };
    }

    // Finalisasi di dalam savepoint: bila gagal, rollback parsial lalu tandai
    // NEEDS_RECONCILIATION di transaksi yang sama (kunci sale tetap dipegang).
    await manager.query(`SAVEPOINT ${SAVEPOINT}`);
    try {
      const paidAt = now ?? new Date();
      const ratePct100 = toCents(sale.tax_rate);
      const tenderedCents = toCents(sale.tendered_amount);
      let taxTotalCents = 0;
      const itemRows = parsed.lines.map((line, index) => {
        const taxCents = taxInclusiveCents(line.lineTotalCents, ratePct100);
        taxTotalCents += taxCents;
        return {
          tenant_id: scope.tenantId,
          branch_id: scope.branchId,
          sale_id: sale.id,
          line_no: index + 1,
          line_type: 'STOCK_ITEM' as const,
          item_id: line.itemId,
          item_code: line.itemCode,
          item_name: line.itemName,
          unit_id: line.unitId,
          unit_code: line.unitCode,
          unit_name: line.unitName,
          drug_group_code: line.drugGroupCode,
          quantity: line.quantity,
          unit_price: fromCents(line.unitPriceCents),
          discount_amount: 0,
          tax_amount: fromCents(taxCents),
          line_total: fromCents(line.lineTotalCents),
          created_by: scope.userId,
          updated_by: scope.userId,
        };
      });
      await manager.insert(SaleItem, itemRows);
      await manager.insert(Payment, {
        tenant_id: scope.tenantId,
        branch_id: scope.branchId,
        sale_id: sale.id,
        shift_id: sale.shift_id,
        payment_method_id: method.id,
        method_code: method.code,
        amount: fromCents(parsed.grandTotalCents),
        tendered_amount: fromCents(tenderedCents),
        change_amount: fromCents(tenderedCents - parsed.grandTotalCents),
        reference_no: null,
        status: 'SUCCESS',
        created_by: scope.userId,
        updated_by: scope.userId,
      });
      // Nomor SAL paling akhir: kunci baris sequence ditahan sesingkat mungkin.
      const saleNumber = await this.documentNumbers.next(manager, {
        tenantId: scope.tenantId,
        branchId: scope.branchId,
        docType: 'SALE',
        now: paidAt,
      });
      await manager.update(Sale, this.whereOf(scope, sale.id), {
        status: 'PAID',
        sale_number: saleNumber,
        subtotal: fromCents(parsed.grandTotalCents),
        discount_total: 0,
        tax_total: fromCents(taxTotalCents),
        grand_total: fromCents(parsed.grandTotalCents),
        paid_total: fromCents(parsed.grandTotalCents),
        change_amount: fromCents(tenderedCents - parsed.grandTotalCents),
        dispensing_id: parsed.dispensingId,
        dispensing_number: parsed.dispensingNumber,
        paid_at: paidAt,
        updated_by: scope.userId,
      });
      await manager.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
      return { kind: 'PAID' };
    } catch (err) {
      await manager.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
      this.logger.error('sale_finalize_failed', {
        ...this.logMeta(ctx, sale.id),
        dispensingId: trace.dispensingId,
        dispensingNumber: trace.dispensingNumber,
        errorName: err instanceof Error ? err.name : 'unknown',
        pgCode: pgError(err).code ?? null,
      });
      await this.markReconciliation(manager, scope, sale.id, 'FINALIZE_FAILED');
      return { kind: 'ERROR', error: this.integrationError(sale.id, null) };
    }
  }

  private whereOf(
    scope: Scope,
    saleId: string,
  ): { id: string; tenant_id: string; branch_id: string } {
    return { id: saleId, tenant_id: scope.tenantId, branch_id: scope.branchId };
  }

  /** PENDING -> NEEDS_RECONCILIATION di transaksi caller (T5). */
  private async markReconciliation(
    manager: EntityManager,
    scope: Scope,
    saleId: string,
    code: ReconCode,
  ): Promise<void> {
    await manager.update(Sale, this.whereOf(scope, saleId), {
      status: 'NEEDS_RECONCILIATION',
      failure_code: code,
      failure_message: RECON[code],
      updated_by: scope.userId,
    });
  }

  /** Setelah transaksi TX-B gagal total: coba tandai di luar transaksi, jangan melempar. */
  private async markReconciliationBestEffort(
    scope: Scope,
    saleId: string,
    code: ReconCode,
  ): Promise<void> {
    try {
      await this.dataSource.getRepository(Sale).update(
        { ...this.whereOf(scope, saleId), status: 'PENDING' },
        {
          status: 'NEEDS_RECONCILIATION',
          failure_code: code,
          failure_message: RECON[code],
          updated_by: scope.userId,
        },
      );
    } catch {
      // Sale tetap PENDING; menjadi NEEDS_RECONCILIATION saat shift ditutup (T6).
    }
  }

  /** Log `error` tanpa body request/response (BR-SL-19). */
  private logReconciliation(
    ctx: RequestContextData,
    saleId: string,
    trace: Trace,
    failureCode: ReconCode,
  ): void {
    this.logger.error('sale_needs_reconciliation', {
      ...this.logMeta(ctx, saleId),
      dispensingId: trace.dispensingId,
      dispensingNumber: trace.dispensingNumber,
      failureCode,
    });
  }

  private logMeta(ctx: RequestContextData, saleId: string) {
    return {
      requestId: ctx.requestId,
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      saleId,
    };
  }

  /** 500 BIL_017 dengan `details` untuk supervisor (BR-PS-08). */
  private integrationError(
    saleId: string,
    saleNumber: string | null,
  ): BusinessException {
    return new BusinessException('BIL_017', undefined, {
      details: { saleId, saleNumber },
    });
  }

  private reconciliationError(sale: Sale): BusinessException {
    return new BusinessException('BIL_016', undefined, {
      details: { saleId: sale.id, saleNumber: sale.sale_number },
    });
  }

  /** Replay sale FAILED: kode HTTP + `errors[]` yang sama (BR-SL-04, BR-SL-20). */
  private failedError(sale: Sale): BusinessException {
    const mapped = mapRejection(sale.failure_code);
    const key: ErrorCodeKey = mapped.key;
    // Data lama pun tidak boleh membocorkan errors[] untuk BIL_017.
    const errors =
      key === 'BIL_017' ? undefined : errorsOf(sale.failure_errors);
    return new BusinessException(key, undefined, {
      ...(errors ? { errors } : {}),
      ...(key === 'BIL_017'
        ? { details: { saleId: sale.id, saleNumber: sale.sale_number } }
        : {}),
    });
  }

  private findByKey(tenantId: string, key: string): Promise<Sale | null> {
    return this.dataSource.getRepository(Sale).findOne({
      where: { tenant_id: tenantId, idempotency_key: key },
    });
  }

  /** `(item_id, unit_id)` unik (BR-SL-03) -> 400 VALIDATION_ERROR. */
  private assertNoDuplicateLines(dto: CreateSaleDto): void {
    const seen = new Set<string>();
    const errors: ErrorFieldDetail[] = [];
    dto.items.forEach((item, index) => {
      const k = `${item.item_id}|${item.unit_id}`.toLowerCase();
      if (seen.has(k)) {
        errors.push({
          field: `items[${index}]`,
          message: 'item_id dan unit_id tidak boleh berulang',
        });
      }
      seen.add(k);
    });
    if (errors.length > 0) {
      throw new BusinessException('VALIDATION_ERROR', undefined, { errors });
    }
  }
}
