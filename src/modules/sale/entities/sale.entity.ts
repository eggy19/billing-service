import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { numericTransformer } from '../../../database/numeric.transformer';
import { CashierShift } from '../../shift/entities/cashier-shift.entity';

export type SaleStatus =
  'PENDING' | 'PAID' | 'FAILED' | 'NEEDS_RECONCILIATION' | 'VOIDED'; // VOIDED dicadangkan, tidak dipakai MVP

/** Pagar desain klinik: `OTC` sekarang; `PRESCRIPTION`/`CLINIC_SERVICE` kelak. */
export type SaleSourceType = 'OTC' | 'PRESCRIPTION' | 'CLINIC_SERVICE';

/** Baris checkout dari request, disimpan untuk melanjutkan sale PENDING (spec §7.4). */
export interface SaleRequestItem {
  item_id: string;
  unit_id: string;
  quantity: number | string;
  expected_unit_price: number | string;
}

const money = {
  type: 'numeric',
  precision: 14,
  scale: 2,
  transformer: numericTransformer,
} as const;

/** Penjualan (spec §7.4, §6.2). `sale_item` dan `payment` dibuat saat PAID. */
@Entity({ name: 'sale' })
@Index('idx_sale_created', ['tenant_id', 'branch_id', 'created_at'])
@Index('idx_sale_cashier_created', [
  'tenant_id',
  'branch_id',
  'cashier_user_id',
  'created_at',
])
@Index('idx_sale_shift_status', ['shift_id', 'status'])
@Index('uq_sale_idempotency', ['tenant_id', 'idempotency_key'], {
  unique: true,
  where: '"deleted_at" IS NULL',
})
@Index('uq_sale_number', ['tenant_id', 'branch_id', 'sale_number'], {
  unique: true,
  where: '"sale_number" IS NOT NULL AND "deleted_at" IS NULL',
})
export class Sale extends BaseEntity {
  /** `SAL-YYYYMMDD-NNNN`; diisi saat PAID. */
  @Column({ type: 'varchar', length: 30, nullable: true })
  sale_number: string | null;

  @Column({ type: 'uuid' })
  shift_id: string;

  @ManyToOne(() => CashierShift, { nullable: false })
  @JoinColumn({ name: 'shift_id', foreignKeyConstraintName: 'fk_sale_shift' })
  shift?: CashierShift;

  @Column({ type: 'uuid' })
  cashier_user_id: string;

  /** Snapshot nama kasir (KB-13); jangan di-log. */
  @Column({ type: 'varchar', length: 150, nullable: true })
  cashier_name: string | null;

  @Column({ type: 'varchar', length: 30 })
  source_type: SaleSourceType;

  @Column({ type: 'uuid', nullable: true })
  source_id: string | null;

  @Column({ type: 'uuid', nullable: true })
  patient_id: string | null;

  /** Jangan di-log (BR-BL-04). */
  @Column({ type: 'varchar', length: 100, nullable: true })
  customer_name: string | null;

  @Column({ type: 'varchar', length: 30 })
  status: SaleStatus;

  @Column({ type: 'uuid' })
  idempotency_key: string;

  /** Hash request (BR-SL-13). */
  @Column({ type: 'char', length: 64 })
  request_hash: string;

  @Column({ ...money })
  subtotal: number;

  @Column({ ...money, default: 0 })
  discount_total: number;

  /** Snapshot persen PPN. */
  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    transformer: numericTransformer,
  })
  tax_rate: number;

  @Column({ ...money })
  tax_total: number;

  @Column({ ...money })
  grand_total: number;

  @Column({ ...money, default: 0 })
  paid_total: number;

  /** Uang diterima dari request (replay & preview); disalin ke `payment` saat PAID. */
  @Column({ ...money })
  tendered_amount: number;

  @Column({ type: 'jsonb' })
  request_items: SaleRequestItem[];

  @Column({ ...money, default: 0 })
  change_amount: number;

  @Column({ type: 'uuid', nullable: true })
  dispensing_id: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  dispensing_number: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  paid_at: Date | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  failure_code: string | null;

  @Column({ type: 'text', nullable: true })
  failure_message: string | null;

  /** `errors[]` dari Inventory (BR-SL-20). */
  @Column({ type: 'jsonb', nullable: true })
  failure_errors: unknown[] | null;

  /** Dicadangkan, tidak dipakai MVP. */
  @Column({ type: 'timestamptz', nullable: true })
  voided_at: Date | null;

  @Column({ type: 'uuid', nullable: true })
  voided_by: string | null;

  @Column({ type: 'text', nullable: true })
  void_reason: string | null;
}
