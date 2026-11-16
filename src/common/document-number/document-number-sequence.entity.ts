import { Column, Entity, Unique } from 'typeorm';
import { BaseEntity } from '../../database/base.entity';

/**
 * Penopang nomor dokumen (`SHF-YYYYMMDD-0001`, `SAL-YYYYMMDD-0001`). Satu baris per
 * (tenant, branch, doc_type, date_key); `last_number` dinaikkan atomik oleh
 * DocumentNumberService. `date_key` = tanggal Asia/Jakarta.
 */
@Entity({ name: 'document_number_sequence' })
@Unique('uq_doc_number_seq', ['tenant_id', 'branch_id', 'doc_type', 'date_key'])
export class DocumentNumberSequence extends BaseEntity {
  @Column({ type: 'varchar', length: 20 })
  doc_type: string;

  @Column({ type: 'varchar', length: 8 })
  date_key: string;

  @Column({ type: 'integer', default: 0 })
  last_number: number;
}
