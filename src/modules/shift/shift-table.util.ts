import type { EntityManager, EntityTarget } from 'typeorm';

/** Nama tabel berkualifikasi schema dari metadata TypeORM (schema = DB_SCHEMA), bukan hardcode. */
export function qualifiedTable(
  manager: EntityManager,
  entity: EntityTarget<object>,
): string {
  const meta = manager.connection.getMetadata(entity);
  return meta.schema
    ? `"${meta.schema}"."${meta.tableName}"`
    : `"${meta.tableName}"`;
}

/**
 * Kunci row (FOR SHARE/UPDATE) hanya bermakna di dalam transaksi milik caller.
 * Tanpa transaksi, kunci hilang diam-diam karena autocommit -> error pemrograman (500),
 * bukan BusinessException (BR-MD-03).
 */
export function assertActiveTransaction(
  manager: EntityManager,
  caller: string,
): void {
  if (manager.queryRunner?.isTransactionActive !== true) {
    throw new Error(`${caller} requires an active transaction`);
  }
}
