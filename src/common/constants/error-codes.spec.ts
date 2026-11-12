import { ERROR_CODES } from './error-codes';

/** Katalog BIL_xxx harus sama dengan spec billing-mvp-spec §8.4. */
const SPEC: Record<string, number> = {
  BIL_001: 404,
  BIL_002: 409,
  BIL_003: 422,
  BIL_004: 409,
  BIL_005: 404,
  BIL_006: 422,
  BIL_007: 422,
  BIL_008: 400,
  BIL_009: 422,
  BIL_010: 409,
  BIL_011: 422,
  BIL_012: 409,
  BIL_013: 422,
  BIL_014: 422,
  BIL_015: 503,
  BIL_016: 409,
  BIL_017: 500,
};

describe('ERROR_CODES catalog', () => {
  it('matches the BIL_xxx HTTP statuses of spec §8.4', () => {
    const actual = Object.fromEntries(
      Object.values(ERROR_CODES)
        .filter((d) => d.code.startsWith('BIL_'))
        .map((d) => [d.code, d.status as number]),
    );
    expect(actual).toEqual(SPEC);
  });

  it('every key equals its code', () => {
    for (const [key, def] of Object.entries(ERROR_CODES)) {
      expect(def.code).toBe(key);
    }
  });
});
