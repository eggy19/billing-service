import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { numericTransformer } from '../../../database/numeric.transformer';

/** Pengaturan Billing per cabang (spec §7.4). Tepat 1 baris aktif per (tenant, branch). */
@Entity({ name: 'billing_setting' })
@Index('uq_billing_setting_branch', ['tenant_id', 'branch_id'], {
  unique: true,
  where: '"deleted_at" IS NULL',
})
export class BillingSetting extends BaseEntity {
  /** Persen PPN; default 0 (KB-07). */
  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  tax_rate: number;

  @Column({ type: 'text', nullable: true })
  receipt_header: string | null;

  @Column({ type: 'text', nullable: true })
  receipt_footer: string | null;
}
