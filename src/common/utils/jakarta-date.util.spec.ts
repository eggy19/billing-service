import {
  jakartaDayStart,
  toJakartaDate,
  toJakartaDateKey,
} from './jakarta-date.util';

describe('jakartaDayStart', () => {
  it('00:00 WIB = 17:00Z hari sebelumnya, konsisten dengan toJakartaDate', () => {
    const start = jakartaDayStart('2026-11-14');
    expect(start.toISOString()).toBe('2026-11-13T17:00:00.000Z');
    expect(toJakartaDate(start)).toBe('2026-11-14');
    expect(toJakartaDate(new Date(start.getTime() - 1))).toBe('2026-11-13');
  });
});

describe('toJakartaDate', () => {
  it('lintas tengah malam WIB: 16:59Z masih hari yang sama, 17:00Z hari berikutnya', () => {
    expect(toJakartaDate(new Date('2026-11-13T16:59:59.999Z'))).toBe(
      '2026-11-13',
    );
    expect(toJakartaDate(new Date('2026-11-13T17:00:00.000Z'))).toBe(
      '2026-11-14',
    );
  });

  it('akhir tahun', () => {
    expect(toJakartaDate(new Date('2026-12-31T17:00:00Z'))).toBe('2027-01-01');
  });

  it('toJakartaDateKey tanpa tanda hubung', () => {
    expect(toJakartaDateKey(new Date('2026-11-13T17:00:00Z'))).toBe('20261114');
  });

  it('tanpa argumen memakai jam sistem', () => {
    expect(toJakartaDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
