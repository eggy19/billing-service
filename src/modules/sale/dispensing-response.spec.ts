import {
  parseDispensingResponse,
  peekDispensingId,
} from './dispensing-response';
import type { SaleRequestItem } from './entities/sale.entity';

const REQ: SaleRequestItem[] = [
  { item_id: 'i1', unit_id: 'u1', quantity: 2, expected_unit_price: 5500 },
  { item_id: 'i2', unit_id: 'u2', quantity: 1, expected_unit_price: 32000 },
];

function body(over: Record<string, unknown> = {}): unknown {
  return {
    success: true,
    data: {
      dispensingId: 'd-1',
      dispensingNumber: 'DSP-20261113-0007',
      replayed: false,
      grandTotal: 43000,
      items: [
        // urutan sengaja dibalik: pencocokan lewat (itemId, unitId), bukan lineNo
        {
          lineNo: 2,
          itemId: 'i2',
          unitId: 'u2',
          itemCode: 'OBT-0002',
          itemName: 'Vitamin C 500 mg',
          unitCode: 'BTL',
          unitName: 'Botol',
          quantity: 1,
          unitPrice: 32000,
          lineTotal: 32000,
          drugGroupCode: null,
        },
        {
          lineNo: 1,
          itemId: 'i1',
          unitId: 'u1',
          itemCode: 'OBT-0001',
          itemName: 'Paracetamol 500 mg',
          unitCode: 'STRIP',
          unitName: 'Strip',
          quantity: 2,
          unitPrice: 5500,
          lineTotal: 11000,
          drugGroupCode: 'OBT_BEBAS',
        },
      ],
      ...over,
    },
  };
}

describe('parseDispensingResponse (BR-IN-03, BR-SL-06)', () => {
  it('response valid -> baris mengikuti urutan request, uang dalam sen', () => {
    const r = parseDispensingResponse(body(), REQ);
    expect(r).not.toBeNull();
    expect(r!.dispensingId).toBe('d-1');
    expect(r!.dispensingNumber).toBe('DSP-20261113-0007');
    expect(r!.grandTotalCents).toBe(4_300_000);
    expect(r!.lines.map((l) => l.itemCode)).toEqual(['OBT-0001', 'OBT-0002']);
    expect(r!.lines[0]).toMatchObject({
      unitName: 'Strip',
      drugGroupCode: 'OBT_BEBAS',
      quantity: 2,
      unitPriceCents: 550_000,
      lineTotalCents: 1_100_000,
    });
    expect(r!.lines[1].drugGroupCode).toBeNull();
  });

  it.each<[string, unknown]>([
    ['body bukan objek', 'oops'],
    ['body undefined (JSON tidak bisa di-parse)', undefined],
    ['tanpa data', { success: true }],
    ['tanpa dispensingId (AC-SL-18)', body({ dispensingId: undefined })],
    ['dispensingId kosong', body({ dispensingId: '' })],
    ['tanpa dispensingNumber', body({ dispensingNumber: null })],
    ['grandTotal bukan angka', body({ grandTotal: '43000' })],
    ['jumlah baris beda', body({ items: [] })],
    ['grandTotal != Σ lineTotal', body({ grandTotal: 43000.01 })],
  ])('tidak valid: %s', (_label, input) => {
    expect(parseDispensingResponse(input, REQ)).toBeNull();
  });

  it('baris dengan field wajib hilang / identitas atau qty beda -> null', () => {
    const good = (body() as { data: { items: Record<string, unknown>[] } }).data
      .items;
    const mutate = (i: number, patch: Record<string, unknown>) =>
      body({
        items: good.map((row, idx) => (idx === i ? { ...row, ...patch } : row)),
      });
    expect(
      parseDispensingResponse(mutate(0, { lineNo: undefined }), REQ),
    ).toBeNull();
    expect(
      parseDispensingResponse(mutate(0, { itemName: undefined }), REQ),
    ).toBeNull();
    expect(
      parseDispensingResponse(mutate(0, { unitPrice: 'x' }), REQ),
    ).toBeNull();
    expect(
      parseDispensingResponse(mutate(0, { itemId: 'i-lain' }), REQ),
    ).toBeNull();
    expect(parseDispensingResponse(mutate(1, { quantity: 5 }), REQ)).toBeNull();
  });

  it('angka di luar jangkauan (RangeError di toCents) -> null, bukan melempar', () => {
    expect(
      parseDispensingResponse(body({ grandTotal: Number.MAX_VALUE }), REQ),
    ).toBeNull();
  });
});

describe('peekDispensingId', () => {
  it('mengambil id bila ada, selain itu null', () => {
    expect(peekDispensingId(body())).toBe('d-1');
    expect(peekDispensingId(body({ dispensingId: 5 }))).toBeNull();
    expect(peekDispensingId(undefined)).toBeNull();
  });
});
