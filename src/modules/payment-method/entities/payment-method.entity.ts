import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';

/** Kode metode bawaan (BR-BL-05). */
export const CASH_METHOD_CODE = 'CASH';

/** Metode pembayaran per cabang (spec §7.4). */
@Entity({ name: 'payment_method' })
@Index('uq_payment_method_code', ['tenant_id', 'branch_id', 'code'], {
  unique: true,
  where: '"deleted_at" IS NULL',
})
export class PaymentMethod extends BaseEntity {
  @Column({ type: 'varchar', length: 30 })
  code: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  /** Masuk perhitungan kas shift. */
  @Column({ type: 'boolean' })
  is_cash: boolean;

  @Column({ type: 'boolean' })
  requires_reference: boolean;

  @Column({ type: 'boolean', default: true })
  is_active: boolean;
}
