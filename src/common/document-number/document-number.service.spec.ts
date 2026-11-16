import type { EntityManager } from 'typeorm';
import { DocumentNumberService } from './document-number.service';

function makeManager(opts: {
  tx?: boolean;
  lastNumber?: number;
  schema?: string | undefined;
}) {
  const query = jest
    .fn()
    .mockResolvedValue([{ last_number: opts.lastNumber ?? 1 }]);
  const manager = {
    queryRunner: { isTransactionActive: opts.tx ?? true },
    connection: {
      getMetadata: () => ({
        schema: 'schema' in opts ? opts.schema : 'billing_x',
        tableName: 'document_number_sequence',
      }),
    },
    query,
  } as unknown as EntityManager;
  return { manager, query };
}

const base = { tenantId: 't-1', branchId: 'b-1' };

describe('DocumentNumberService', () => {
  const service = new DocumentNumberService();

  it('SALE -> SAL-YYYYMMDD-NNNN with upsert SQL and params', async () => {
    const { manager, query } = makeManager({ lastNumber: 7 });
    const out = await service.next(manager, {
      ...base,
      docType: 'SALE',
      now: new Date('2026-11-13T05:00:00Z'),
    });
    expect(out).toBe('SAL-20261113-0007');

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO "billing_x"."document_number_sequence"');
    expect(sql).toContain('ON CONFLICT ON CONSTRAINT "uq_doc_number_seq"');
    expect(sql).toContain(
      '"last_number" = "billing_x"."document_number_sequence"."last_number" + 1',
    );
    expect(sql).toContain('RETURNING "last_number"');
    expect(params).toEqual(['t-1', 'b-1', 'SALE', '20261113']);
  });

  it('SHIFT -> SHF- prefix', async () => {
    const { manager } = makeManager({ lastNumber: 12 });
    await expect(
      service.next(manager, {
        ...base,
        docType: 'SHIFT',
        now: new Date('2026-11-13T05:00:00Z'),
      }),
    ).resolves.toBe('SHF-20261113-0012');
  });

  it('date_key follows Asia/Jakarta, not UTC (C3: lintas tengah malam WIB)', async () => {
    const before = makeManager({});
    await service.next(before.manager, {
      ...base,
      docType: 'SALE',
      now: new Date('2026-11-13T16:59:59Z'), // 23:59:59 WIB tgl 13
    });
    expect((before.query.mock.calls[0] as [string, unknown[]])[1][3]).toBe(
      '20261113',
    );

    const after = makeManager({});
    await service.next(after.manager, {
      ...base,
      docType: 'SALE',
      now: new Date('2026-11-13T17:00:00Z'), // 00:00:00 WIB tgl 14
    });
    expect((after.query.mock.calls[0] as [string, unknown[]])[1][3]).toBe(
      '20261114',
    );
  });

  it('number wider than 4 digits is not truncated', async () => {
    const { manager } = makeManager({ lastNumber: 12345 });
    await expect(
      service.next(manager, { ...base, docType: 'SALE', now: new Date() }),
    ).resolves.toMatch(/^SAL-\d{8}-12345$/);
  });

  it('without a schema in metadata the table is unqualified (no hardcoded name)', async () => {
    const { manager, query } = makeManager({ schema: undefined });
    await service.next(manager, { ...base, docType: 'SALE' });
    expect((query.mock.calls[0] as [string])[0]).toContain(
      'INSERT INTO "document_number_sequence"',
    );
  });

  it('throws a programming error (not a query) outside an active transaction', async () => {
    const { manager, query } = makeManager({ tx: false });
    await expect(
      service.next(manager, { ...base, docType: 'SALE' }),
    ).rejects.toThrow('active transaction');
    expect(query).not.toHaveBeenCalled();
  });
});
