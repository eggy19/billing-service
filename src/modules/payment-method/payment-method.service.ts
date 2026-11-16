import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  CASH_METHOD_CODE,
  PaymentMethod,
} from './entities/payment-method.entity';

@Injectable()
export class PaymentMethodService {
  constructor(
    @InjectRepository(PaymentMethod)
    private readonly repo: Repository<PaymentMethod>,
  ) {}

  /**
   * Metode aktif menurut kode, atau null bila tidak ada / nonaktif (caller
   * melempar BIL_007). Untuk `CASH` yang belum pernah ada di cabang ini, metode
   * Tunai dibuat otomatis (BR-BL-05). CASH yang dinonaktifkan (`is_active=false`)
   * tidak dibuat ulang, tetapi CASH yang di-soft-delete dianggap belum ada
   * (repository menyaring `deleted_at`, unique parsial juga) sehingga dibuat ulang. Request paralel yang bentrok unique index: ON CONFLICT DO
   * NOTHING lalu baca ulang (bukan 500).
   */
  async findActiveByCode(
    tenantId: string,
    branchId: string,
    code: string,
  ): Promise<PaymentMethod | null> {
    let row = await this.findAny(tenantId, branchId, code);
    if (!row && code === CASH_METHOD_CODE) {
      await this.repo
        .createQueryBuilder()
        .insert()
        .values({
          tenant_id: tenantId,
          branch_id: branchId,
          code: CASH_METHOD_CODE,
          name: 'Tunai',
          is_cash: true,
          requires_reference: false,
          is_active: true,
        })
        .orIgnore()
        .execute();
      row = await this.findAny(tenantId, branchId, code);
    }
    return row?.is_active ? row : null;
  }

  /**
   * Metode aktif cabang untuk `GET /billing/payment-methods` (AC-SL-20). CASH
   * di-lazy-create lewat `findActiveByCode` (BR-BL-05); CASH yang dinonaktifkan
   * tidak ikut daftar.
   */
  async listActive(
    tenantId: string,
    branchId: string,
  ): Promise<PaymentMethod[]> {
    await this.findActiveByCode(tenantId, branchId, CASH_METHOD_CODE);
    return this.repo.find({
      where: { tenant_id: tenantId, branch_id: branchId, is_active: true },
      order: { code: 'ASC' },
    });
  }

  private findAny(
    tenantId: string,
    branchId: string,
    code: string,
  ): Promise<PaymentMethod | null> {
    return this.repo.findOne({
      where: { tenant_id: tenantId, branch_id: branchId, code },
    });
  }
}
