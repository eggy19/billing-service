import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BillingSetting } from './entities/billing-setting.entity';

@Injectable()
export class BillingSettingService {
  constructor(
    @InjectRepository(BillingSetting)
    private readonly repo: Repository<BillingSetting>,
  ) {}

  /**
   * Setting cabang; dibuat otomatis (tax_rate 0, KB-07) bila belum ada (BR-BL-05).
   * Request paralel yang bentrok unique index tidak error: INSERT ... ON CONFLICT
   * DO NOTHING lalu baca ulang baris pemenang.
   */
  async getOrCreate(
    tenantId: string,
    branchId: string,
  ): Promise<BillingSetting> {
    const existing = await this.find(tenantId, branchId);
    if (existing) return existing;

    await this.repo
      .createQueryBuilder()
      .insert()
      .values({ tenant_id: tenantId, branch_id: branchId, tax_rate: 0 })
      .orIgnore()
      .execute();

    const created = await this.find(tenantId, branchId);
    if (!created) {
      throw new Error('billing_setting lazy-create failed to produce a row');
    }
    return created;
  }

  private find(
    tenantId: string,
    branchId: string,
  ): Promise<BillingSetting | null> {
    return this.repo.findOne({
      where: { tenant_id: tenantId, branch_id: branchId },
    });
  }
}
