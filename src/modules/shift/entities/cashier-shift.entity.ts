import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { numericTransformer } from '../../../database/numeric.transformer';

export type CashierShiftStatus = 'OPEN' | 'CLOSED';

/** Shift kasir (spec §7.4, §6.1). */
@Entity({ name: 'cashier_shift' })
// Satu shift OPEN per kasir per cabang; pelanggaran -> SQLSTATE 23505.
@Index('uq_cashier_shift_open', ['tenant_id', 'branch_id', 'cashier_user_id'], {
  unique: true,
  where: `"status" = 'OPEN' AND "deleted_at" IS NULL`,
})
@Index('uq_cashier_shift_number', ['tenant_id', 'branch_id', 'shift_number'], {
  unique: true,
  where: '"deleted_at" IS NULL',
})
@Index('idx_cashier_shift_opened_at', ['tenant_id', 'branch_id', 'opened_at'])
export class CashierShift extends BaseEntity {
  /** `SHF-YYYYMMDD-NNNN`. */
  @Column({ type: 'varchar', length: 30 })
  shift_number: string;

  /** `sub` JWT. */
  @Column({ type: 'uuid' })
  cashier_user_id: string;

  /** Snapshot nama kasir (KB-13); jangan di-log. */
  @Column({ type: 'varchar', length: 150, nullable: true })
  cashier_name: string | null;

  @Column({ type: 'varchar', length: 20 })
  status: CashierShiftStatus;

  @Column({ type: 'timestamptz' })
  opened_at: Date;

  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    transformer: numericTransformer,
  })
  opening_cash: number;

  @Column({ type: 'text', nullable: true })
  open_note: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  closed_at: Date | null;

  @Column({ type: 'uuid', nullable: true })
  closed_by: string | null;

  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  expected_cash: number | null;

  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  closing_cash_counted: number | null;

  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  cash_difference: number | null;

  @Column({ type: 'text', nullable: true })
  close_note: string | null;
}
