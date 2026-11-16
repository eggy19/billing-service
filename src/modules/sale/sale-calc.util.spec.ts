import {
  centsToFixed2,
  computeRequestHash,
  MAX_AMOUNT_CENTS,
  previewTotals,
  taxInclusiveCents,
} from './sale-calc.util';

describe('taxInclusiveCents (BR-TX-03, AC-SL-12)', () => {
  it('11.000 pada PPN 11% -> 1.090,09 (half-up)', () => {
    expect(taxInclusiveCents(1_100_000, 1100)).toBe(109_009);
  });

  it('tax_rate 0 -> 0', () => {
    expect(taxInclusiveCents(1_100_000, 0)).toBe(0);
  });

  it('half-up: 5 sen x 11/111 = 0,495 -> 0; 51 sen = 5,05 -> 5; tepat .5 dibulatkan naik', () => {
    expect(taxInclusiveCents(5, 1100)).toBe(0);
    expect(taxInclusiveCents(51, 1100)).toBe(5);
    // Tarif 100%: pajak = line / 2, sehingga 1 sen -> 0,5 -> 1 dan 3 sen -> 1,5 -> 2.
    expect(taxInclusiveCents(1, 10000)).toBe(1);
    expect(taxInclusiveCents(3, 10000)).toBe(2);
  });

  it('nilai besar tidak kehilangan presisi (BigInt)', () => {
    // 99.999.999.999.999 sen x 99,99% -> tetap integer yang benar
    const line = 99_999_999_999_999;
    const expected = Number(
      (2n * BigInt(line) * 9999n + 19999n) / (2n * 19999n),
    );
    expect(taxInclusiveCents(line, 9999)).toBe(expected);
  });
});

describe('previewTotals (BR-SL-03, BR-SL-15)', () => {
  it('Σ qty x harga dan Σ pajak per baris', () => {
    const r = previewTotals(
      [
        { quantity: 2, expected_unit_price: 5500 },
        { quantity: 1, expected_unit_price: 32000 },
      ],
      1100,
    );
    expect(r).toEqual({
      totalCents: 4_300_000,
      // 11.000 -> 1090,09 ; 32.000 -> 3171,17 (3171,171...) = 4261,26 (AC-RC-01)
      taxCents: 109_009 + 317_117,
    });
  });

  it('harga desimal tidak memakai floating point (19,99 x 3)', () => {
    expect(
      previewTotals([{ quantity: 3, expected_unit_price: 19.99 }], 0)
        ?.totalCents,
    ).toBe(5997);
  });

  it('melebihi numeric(14,2) -> null', () => {
    expect(
      previewTotals(
        [{ quantity: 1_000_000, expected_unit_price: 999_999_999_999.99 }],
        0,
      ),
    ).toBeNull();
    expect(MAX_AMOUNT_CENTS).toBe(99_999_999_999_999n);
  });
});

describe('centsToFixed2', () => {
  it.each([
    [0, '0.00'],
    [5, '0.05'],
    [550010, '5500.10'],
    [1_100_000, '11000.00'],
  ])('%d -> %s', (cents, text) => {
    expect(centsToFixed2(cents)).toBe(text);
  });
});

describe('computeRequestHash (BR-SL-13)', () => {
  const base = {
    branchId: 'b-P',
    customerName: null,
    items: [
      { item_id: 'i1', unit_id: 'u1', quantity: 2, expected_unit_price: 5500 },
    ],
    payments: [{ method_code: 'CASH', tendered_amount: 20000 }],
  };

  it('SHA-256 hex 64 karakter dan deterministik', () => {
    const h = computeRequestHash(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(computeRequestHash({ ...base })).toBe(h);
  });

  it('5500 dan 5500.00 menghasilkan hash sama (string 2 desimal)', () => {
    const h = computeRequestHash(base);
    const same = computeRequestHash({
      ...base,
      items: [{ ...base.items[0], expected_unit_price: 5500.0 }],
    });
    expect(same).toBe(h);
  });

  it.each([
    ['qty berbeda', { items: [{ ...base.items[0], quantity: 3 }] }],
    [
      'harga berbeda',
      { items: [{ ...base.items[0], expected_unit_price: 5500.01 }] },
    ],
    [
      'tendered berbeda',
      { payments: [{ method_code: 'CASH', tendered_amount: 20000.5 }] },
    ],
    ['customer berbeda', { customerName: 'Bpk. Andi' }],
    ['cabang berbeda', { branchId: 'b-Q' }],
    [
      'urutan baris berbeda',
      {
        items: [
          { item_id: 'i2', unit_id: 'u1', quantity: 1, expected_unit_price: 1 },
          base.items[0],
        ],
      },
    ],
  ])('%s -> hash berbeda', (_label, over) => {
    expect(computeRequestHash({ ...base, ...over })).not.toBe(
      computeRequestHash(base),
    );
  });
});
