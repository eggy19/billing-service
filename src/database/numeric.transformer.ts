import { ValueTransformer } from 'typeorm';

/**
 * TypeORM returns `numeric`/`decimal` columns as strings (node-postgres keeps
 * full precision). This transformer parses them back to `number` on read so
 * arithmetic (e.g. the FEFO `sum + b.quantity`) works as expected. Writes pass
 * the value straight through — Postgres accepts a JS number for numeric.
 */
export const numericTransformer: ValueTransformer = {
  to: (value?: number | null): number | null | undefined => value,
  from: (value?: string | null): number | null => {
    if (value === null || value === undefined) {
      return null;
    }
    return Number(value);
  },
};
