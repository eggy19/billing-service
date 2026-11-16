import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { numericTransformer } from '../../../database/numeric.transformer';
import { PaymentMethod } from '../../payment-method/entities/payment-method.entity';
import { CashierShift } from '../../shift/entities/cashier-shift.entity';
import { Sale } from './sale.entity';

export type PaymentStatus = 'SUCCESS';

const money = {
  type: 'numeric',
  precision: 14,
  scale: 2,
  transformer: numericTransformer,
} as const;

/** Pembayaran, terpisah dari `sale` (pagar desain klinik). Dibuat saat PAID. */
@Entity({ name: 'payment' })
@Index('idx_payment_sale', ['sale_id'])
@Index('idx_payment_shift_status', ['shift_id', 'status'])
@Index('idx_payment_method', ['payment_method_id'])
export class Payment extends BaseEntity {
  @Column({ type: 'uuid' })
  sale_id: string;

  @ManyToOne(() => Sale, { nullable: false })
  @JoinColumn({ name: 'sale_id', foreignKeyConstraintName: 'fk_payment_sale' })
  sale?: Sale;

  @Column({ type: 'uuid' })
  shift_id: string;

  @ManyToOne(() => CashierShift, { nullable: false })
  @JoinColumn({
    name: 'shift_id',
    foreignKeyConstraintName: 'fk_payment_shift',
  })
  shift?: CashierShift;

  @Column({ type: 'uuid' })
  payment_method_id: string;

  @ManyToOne(() => PaymentMethod, { nullable: false })
  @JoinColumn({
    name: 'payment_method_id',
    foreignKeyConstraintName: 'fk_payment_method',
  })
  payment_method?: PaymentMethod;

  /** Snapshot kode metode, mis. `CASH`. */
  @Column({ type: 'varchar', length: 30 })
  method_code: string;

  /** Nilai yang diterapkan ke tagihan (= grand_total di MVP). */
  @Column({ ...money })
  amount: number;

  @Column({ ...money, nullable: true })
  tendered_amount: number | null;

  @Column({ ...money, nullable: true })
  change_amount: number | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  reference_no: string | null;

  @Column({ type: 'varchar', length: 20 })
  status: PaymentStatus;
}
