import { fromCents, roundHalfUp2, toCents } from './money.util';

describe('money util (BR-SL-15)', () => {
  it.each([
    [5500, 550000],
    [43000.5, 4300050],
    ['11000.00', 1100000],
    [0, 0],
    [0.1 + 0.2, 30],
    [4261.26, 426126],
  ])('toCents(%p) = %p', (input, expected) => {
    expect(toCents(input)).toBe(expected);
  });

  it('half-up pada digit ke-3, termasuk kasus yang salah bila memakai float', () => {
    expect(toCents('1.005')).toBe(101);
    expect(toCents(1.005)).toBe(101);
    expect(toCents('250.375')).toBe(25038);
    expect(toCents('250.374')).toBe(25037);
    expect(toCents('0.004')).toBe(0);
    expect(toCents('0.005')).toBe(1);
  });

  it('notasi eksponen dan negatif', () => {
    expect(toCents(1e-7)).toBe(0);
    expect(toCents(-6000)).toBe(-600000);
    expect(toCents('-0.001')).toBe(0);
  });

  it('input tidak valid dilempar', () => {
    expect(() => toCents(NaN)).toThrow(RangeError);
    expect(() => toCents('abc')).toThrow(RangeError);
    expect(() => toCents('')).toThrow(RangeError);
  });

  it('di luar rentang integer aman dilempar', () => {
    expect(() => toCents('90071992547409.93')).toThrow(RangeError);
    expect(() => toCents('99999999999999999999')).toThrow(RangeError);
    expect(toCents('90071992547409.91')).toBe(9007199254740991);
  });

  it('fromCents dan roundHalfUp2', () => {
    expect(fromCents(4261026)).toBe(42610.26);
    expect(() => fromCents(1.5)).toThrow(RangeError);
    expect(roundHalfUp2('100.15')).toBe(100.15);
    expect(roundHalfUp2(5505.505)).toBe(5505.51);
  });
});
