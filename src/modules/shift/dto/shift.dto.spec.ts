import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CloseShiftDto, ListShiftQueryDto, OpenShiftDto } from './shift.dto';

async function errorsOf<T extends object>(
  cls: new () => T,
  plain: Record<string, unknown>,
): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, plain), {
    whitelist: true,
  });
  return errors.map((e) => e.property).sort();
}

describe('OpenShiftDto (AC-SH-01, AC-SH-12)', () => {
  it.each([
    [{ opening_cash: 200000, open_note: null }],
    [{ opening_cash: 0 }],
    [{ opening_cash: 100000.5, open_note: 'a'.repeat(500) }],
  ])('valid: %j', async (body) => {
    expect(await errorsOf(OpenShiftDto, body)).toEqual([]);
  });

  it.each([
    [{ opening_cash: -1 }],
    [{ opening_cash: 100.005 }],
    [{ opening_cash: '1000' }],
    [{}],
    [{ opening_cash: 1e15 }],
    [{ opening_cash: 1, open_note: 'a'.repeat(501) }],
  ])('tidak valid -> VALIDATION_ERROR: %j', async (body) => {
    expect((await errorsOf(OpenShiftDto, body)).length).toBeGreaterThan(0);
  });
});

describe('CloseShiftDto (BR-SH-04, BR-SH-14)', () => {
  it('valid / tidak valid', async () => {
    expect(
      await errorsOf(CloseShiftDto, { closing_cash_counted: 543000 }),
    ).toEqual([]);
    expect(
      await errorsOf(CloseShiftDto, { closing_cash_counted: -0.01 }),
    ).toEqual(['closing_cash_counted']);
    expect(
      await errorsOf(CloseShiftDto, { closing_cash_counted: 1.005 }),
    ).toEqual(['closing_cash_counted']);
    expect(
      await errorsOf(CloseShiftDto, {
        closing_cash_counted: 1,
        close_note: 'x'.repeat(501),
      }),
    ).toEqual(['close_note']);
  });
});

describe('ListShiftQueryDto (spec §7.5)', () => {
  it('valid dengan default page 1 / limit 20', async () => {
    const dto = plainToInstance(ListShiftQueryDto, {
      date_from: '2026-11-13',
      status: 'OPEN',
    });
    expect(await validate(dto)).toEqual([]);
    expect([dto.page, dto.limit]).toEqual([1, 20]);
  });

  it.each([
    [{ limit: '101' }],
    [{ page: '0' }],
    [{ date_from: '13-11-2026' }],
    [{ date_to: '2026-13-45' }],
    [{ date_from: '2026-11-13T00:00:00Z' }],
    [{ status: 'PENDING' }],
    [{ cashier_user_id: 'bukan-uuid' }],
  ])('tidak valid: %j', async (q) => {
    expect((await errorsOf(ListShiftQueryDto, q)).length).toBeGreaterThan(0);
  });
});
