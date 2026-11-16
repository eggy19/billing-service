import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateSaleDto, ListSaleQueryDto } from './sale.dto';

const UUID_A = '5b1d7c2e-8a7f-4f3e-9c55-2f1f0c9a0e11';
const UUID_B = '6c2e8d3f-9b80-4a4f-8d66-3a2a1d0b1f22';

const line = (over: Record<string, unknown> = {}) => ({
  item_id: UUID_A,
  unit_id: UUID_B,
  quantity: 2,
  expected_unit_price: 5500,
  ...over,
});
const valid = (over: Record<string, unknown> = {}) => ({
  customer_name: null,
  items: [line()],
  payments: [{ method_code: 'CASH', tendered_amount: 20000 }],
  ...over,
});

async function errorsOf(cls: new () => object, plain: object) {
  const errors = await validate(plainToInstance(cls, plain), {
    whitelist: true,
  });
  return errors.length;
}

describe('CreateSaleDto (BR-SL-03, AC-SL-16)', () => {
  it('body valid lolos', async () => {
    expect(await errorsOf(CreateSaleDto, valid())).toBe(0);
    expect(
      await errorsOf(CreateSaleDto, valid({ customer_name: 'Bpk. Andi' })),
    ).toBe(0);
  });

  it.each([
    ['quantity 1,5 (KB-10)', { items: [line({ quantity: 1.5 })] }],
    ['quantity 0', { items: [line({ quantity: 0 })] }],
    ['quantity negatif', { items: [line({ quantity: -1 })] }],
    ['quantity string', { items: [line({ quantity: '2' })] }],
    ['items kosong', { items: [] }],
    ['items 101 baris', { items: Array.from({ length: 101 }, () => line()) }],
    ['item_id bukan UUID', { items: [line({ item_id: 'x' })] }],
    ['unit_id hilang', { items: [line({ unit_id: undefined })] }],
    ['harga negatif', { items: [line({ expected_unit_price: -1 })] }],
    ['harga 3 desimal', { items: [line({ expected_unit_price: 5500.005 })] }],
    ['harga NaN', { items: [line({ expected_unit_price: NaN })] }],
    ['items bukan array', { items: 'x' }],
    ['payments hilang', { payments: undefined }],
    [
      'tendered negatif',
      { payments: [{ method_code: 'CASH', tendered_amount: -1 }] },
    ],
    [
      'tendered 3 desimal',
      { payments: [{ method_code: 'CASH', tendered_amount: 100.001 }] },
    ],
    [
      'method_code kosong',
      { payments: [{ method_code: '', tendered_amount: 1 }] },
    ],
    ['customer_name > 100 karakter', { customer_name: 'a'.repeat(101) }],
  ])('menolak: %s', async (_label, over) => {
    expect(await errorsOf(CreateSaleDto, valid(over))).toBeGreaterThan(0);
  });

  it('100 baris masih diterima', async () => {
    expect(
      await errorsOf(
        CreateSaleDto,
        valid({
          items: Array.from({ length: 100 }, (_v, i) =>
            line({
              unit_id: `6c2e8d3f-9b80-4a4f-8d66-3a2a1d0b${(0x1000 + i).toString(16)}`,
            }),
          ),
        }),
      ),
    ).toBe(0);
  });

  it('DTO tidak mendeklarasikan shift/cabang/kasir; whitelist ValidationPipe membuangnya (BR-SH-09)', async () => {
    const dto = plainToInstance(
      CreateSaleDto,
      valid({ shift_id: 'x', branch_id: 'y', cashier_user_id: 'z' }),
    );
    await validate(dto, { whitelist: true });
    expect(dto).not.toHaveProperty('shift_id');
    expect(dto).not.toHaveProperty('branch_id');
    expect(dto).not.toHaveProperty('cashier_user_id');
  });
});

describe('ListSaleQueryDto (§7.5, AC-RW-03)', () => {
  it('default page 1, limit 20', () => {
    const q = plainToInstance(ListSaleQueryDto, {});
    expect(q.page).toBe(1);
    expect(q.limit).toBe(20);
  });

  it.each([
    ['limit 101', { limit: '101' }],
    ['limit 0', { limit: '0' }],
    ['page 0', { page: '0' }],
    ['date_from salah format', { date_from: '13-11-2026' }],
    ['date_to tanggal tidak ada', { date_to: '2026-02-31' }],
    ['status tidak dikenal', { status: 'DONE' }],
    ['cashier_user_id bukan UUID', { cashier_user_id: 'x' }],
    ['q terlalu panjang', { q: 'a'.repeat(31) }],
  ])('menolak: %s', async (_label, plain) => {
    expect(await errorsOf(ListSaleQueryDto, plain)).toBeGreaterThan(0);
  });

  it('filter valid lolos', async () => {
    expect(
      await errorsOf(ListSaleQueryDto, {
        limit: '100',
        page: '3',
        date_from: '2026-11-13',
        date_to: '2026-11-14',
        status: 'NEEDS_RECONCILIATION',
        cashier_user_id: UUID_A,
        q: 'SAL-2026',
      }),
    ).toBe(0);
  });
});
