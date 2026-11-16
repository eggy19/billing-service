import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { toJakartaDateKey } from '../utils/jakarta-date.util';
import { DocumentNumberSequence } from './document-number-sequence.entity';

export type DocumentType = 'SHIFT' | 'SALE';

const PREFIX: Record<DocumentType, string> = {
  SHIFT: 'SHF',
  SALE: 'SAL',
};

export interface NextDocumentNumberParams {
  tenantId: string;
  branchId: string;
  docType: DocumentType;
  /** Waktu acuan untuk `date_key`; default sekarang. Disuplai test lintas tengah malam WIB (C3). */
  now?: Date;
}

/**
 * Nomor dokumen `SHF-`/`SAL-YYYYMMDD-NNNN` per tenant/cabang/hari (BR-MD-01 butir 4).
 * Upsert atomik pada `document_number_sequence`; wajib dipanggil dengan `manager`
 * transaksi milik caller supaya rollback tidak meninggalkan nomor yatim.
 * Nomor yang terlewat saat rollback dapat diterima (gap-tolerant).
 */
@Injectable()
export class DocumentNumberService {
  async next(
    manager: EntityManager,
    params: NextDocumentNumberParams,
  ): Promise<string> {
    if (manager.queryRunner?.isTransactionActive !== true) {
      // Error pemrograman (500), bukan BusinessException: sama seperti port ShiftGuard.
      throw new Error(
        'DocumentNumberService.next requires an active transaction',
      );
    }
    const prefix = PREFIX[params.docType];
    if (!prefix) {
      throw new Error(`Unsupported document type: ${String(params.docType)}`);
    }

    const dateKey = toJakartaDateKey(params.now);
    const table = this.qualifiedTable(manager);
    const rows: { last_number: number }[] = await manager.query(
      `INSERT INTO ${table}
         ("tenant_id","branch_id","doc_type","date_key","last_number")
       VALUES ($1,$2,$3,$4,1)
       ON CONFLICT ON CONSTRAINT "uq_doc_number_seq"
       DO UPDATE SET "last_number" = ${table}."last_number" + 1, "updated_at" = now()
       RETURNING "last_number"`,
      [params.tenantId, params.branchId, params.docType, dateKey],
    );
    return `${prefix}-${dateKey}-${String(rows[0].last_number).padStart(4, '0')}`;
  }

  /** Nama tabel berkualifikasi schema dari metadata TypeORM (schema = DB_SCHEMA), bukan hardcode. */
  private qualifiedTable(manager: EntityManager): string {
    const meta = manager.connection.getMetadata(DocumentNumberSequence);
    return meta.schema
      ? `"${meta.schema}"."${meta.tableName}"`
      : `"${meta.tableName}"`;
  }
}
