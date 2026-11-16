import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { numericTransformer } from '../../../database/numeric.transformer';
import { Sale } from './sale.entity';

export type SaleLineType = 'STOCK_ITEM' | 'SERVICE'; // SERVICE kelak

const money = {
  type: 'numeric',
  precision: 14,
  scale: 2,
  transformer: numericTransformer,
} as const;

/** Baris penjualan dengan snapshot kode/nama/satuan (spec §7.4). Dibuat saat PAID. */
@Entity({ name: 'sale_item' })
@Index('uq_sale_item_line', ['sale_id', 'line_no'], {
  unique: true,
  where: '"deleted_at" IS NULL',
})
export class SaleItem extends BaseEntity {
  @Column({ type: 'uuid' })
  sale_id: string;

  @ManyToOne(() => Sale, { nullable: false })
  @JoinColumn({
    name: 'sale_id',
    foreignKeyConstraintName: 'fk_sale_item_sale',
  })
  sale?: Sale;

  @Column({ type: 'int' })
  line_no: number;

  @Column({ type: 'varchar', length: 20 })
  line_type: SaleLineType;

  /** Wajib untuk `STOCK_ITEM`. */
  @Column({ type: 'uuid', nullable: true })
  item_id: string | null;

  @Column({ type: 'varchar', length: 50 })
  item_code: string;

  @Column({ type: 'varchar', length: 255 })
  item_name: string;

  @Column({ type: 'uuid', nullable: true })
  unit_id: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  unit_code: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  unit_name: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  drug_group_code: string | null;

  @Column({
    type: 'numeric',
    precision: 18,
    scale: 4,
    transformer: numericTransformer,
  })
  quantity: number;

  @Column({ ...money })
  unit_price: number;

  @Column({ ...money, default: 0 })
  discount_amount: number;

  @Column({ ...money })
  tax_amount: number;

  @Column({ ...money })
  line_total: number;
}
