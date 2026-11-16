import { Injectable, UnauthorizedException } from '@nestjs/common';
import {
  And,
  DataSource,
  FindOptionsWhere,
  ILike,
  LessThan,
  MoreThanOrEqual,
} from 'typeorm';
import { RequestContextData } from '../../common/context/request-context';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { BusinessException } from '../../common/exceptions/business.exception';
import { jakartaDayStart } from '../../common/utils/jakarta-date.util';
import { BillingSettingService } from '../setting/billing-setting.service';
import { ListSaleQueryDto } from './dto/sale.dto';
import { Payment } from './entities/payment.entity';
import { SaleItem } from './entities/sale-item.entity';
import { Sale } from './entities/sale.entity';
import {
  SaleSummaryView,
  SaleView,
  toSaleSummary,
  toSaleView,
} from './sale-view';

const READ_ALL_PERMISSION = 'billing.sale.read_all';
const DAY_MS = 24 * 60 * 60 * 1000;

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

/** Escape wildcard LIKE (`\`, `%`, `_`) supaya `q` dicari sebagai teks biasa. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&');
}

/**
 * Riwayat & detail penjualan (BR-SL-12, BR-SL-21, spec §7.5). Tenant + branch
 * dari JWT. Pemegang `read` (tanpa `read_all`) hanya melihat sale miliknya;
 * sale di luar scope -> 404 BIL_005.
 */
@Injectable()
export class SaleQueryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly settings: BillingSettingService,
  ) {}

  /** Daftar penjualan; `date_from/date_to` = tanggal WIB inklusif pada `created_at`. */
  async list(
    ctx: RequestContextData,
    query: ListSaleQueryDto,
  ): Promise<PaginatedResult<SaleSummaryView>> {
    const scope = scopeOf(ctx);
    let cashierUserId = query.cashier_user_id;
    if (!scope.readAll) {
      // Filter kasir milik orang lain -> list kosong (BR-SL-12).
      if (cashierUserId && cashierUserId !== scope.userId) {
        return new PaginatedResult<SaleSummaryView>(
          [],
          0,
          query.page,
          query.limit,
        );
      }
      cashierUserId = scope.userId;
    }

    const where: FindOptionsWhere<Sale> = {
      tenant_id: scope.tenantId,
      branch_id: scope.branchId,
    };
    if (cashierUserId) where.cashier_user_id = cashierUserId;
    if (query.status) where.status = query.status;
    const q = query.q?.trim();
    if (q) where.sale_number = ILike(`%${escapeLike(q)}%`);

    const ranges = [];
    if (query.date_from) {
      ranges.push(MoreThanOrEqual(jakartaDayStart(query.date_from)));
    }
    if (query.date_to) {
      ranges.push(
        LessThan(new Date(jakartaDayStart(query.date_to).getTime() + DAY_MS)),
      );
    }
    if (ranges.length === 1) where.created_at = ranges[0];
    if (ranges.length === 2) where.created_at = And(...ranges);

    const [rows, total] = await this.dataSource
      .getRepository(Sale)
      .findAndCount({
        where,
        relations: { shift: true },
        order: { created_at: 'DESC', id: 'DESC' },
        skip: query.skip,
        take: query.limit,
      });
    return new PaginatedResult(
      rows.map((r) => toSaleSummary(r)),
      total,
      query.page,
      query.limit,
    );
  }

  /** Detail penjualan (data struk) dengan scope baca user. */
  async findOne(ctx: RequestContextData, id: string): Promise<SaleView> {
    const scope = scopeOf(ctx);
    return this.load(
      scope.tenantId,
      scope.branchId,
      id,
      scope.readAll ? undefined : scope.userId,
    );
  }

  /**
   * Tampilan sale untuk response checkout. Caller sudah memverifikasi kepemilikan
   * (replay hanya untuk kasir pemilik, BR-SL-14), jadi tanpa filter kasir.
   */
  viewById(tenantId: string, branchId: string, id: string): Promise<SaleView> {
    return this.load(tenantId, branchId, id, undefined);
  }

  private async load(
    tenantId: string,
    branchId: string,
    id: string,
    onlyCashierUserId: string | undefined,
  ): Promise<SaleView> {
    const sale = await this.dataSource.getRepository(Sale).findOne({
      where: {
        id,
        tenant_id: tenantId,
        branch_id: branchId,
        ...(onlyCashierUserId ? { cashier_user_id: onlyCashierUserId } : {}),
      },
      relations: { shift: true },
    });
    if (!sale) throw new BusinessException('BIL_005');

    const [items, payments, setting] = await Promise.all([
      this.dataSource.getRepository(SaleItem).find({
        where: { sale_id: sale.id, tenant_id: tenantId, branch_id: branchId },
        order: { line_no: 'ASC' },
      }),
      this.dataSource.getRepository(Payment).find({
        where: { sale_id: sale.id, tenant_id: tenantId, branch_id: branchId },
        relations: { payment_method: true },
        order: { created_at: 'ASC', id: 'ASC' },
      }),
      this.settings.getOrCreate(tenantId, branchId),
    ]);
    return toSaleView(sale, items, payments, setting);
  }
}
