import { createHash } from 'node:crypto';
import { toCents } from '../../common/utils/money.util';

/**
 * Perhitungan & hash checkout (BR-SL-13, BR-SL-15, BR-TX-03). Murni (tanpa I/O)
 * supaya mudah diuji. Uang dihitung dalam sen; perkalian memakai BigInt agar
 * qty x harga tidak melewati batas integer aman.
 */

/** Batas kolom numeric(14,2) dalam sen. */
export const MAX_AMOUNT_CENTS = 99_999_999_999_999n;

/** qty (bilangan bulat, KB-10) x harga satuan (sen) -> total baris (sen). */
export function lineTotalCents(
  quantity: number,
  unitPriceCents: number,
): bigint {
  return BigInt(quantity) * BigInt(unitPriceCents);
}

/**
 * PPN tax-inclusive per baris (BR-TX-03): round2(line x rate / (100 + rate)),
 * half-up. `ratePct100` = persen x 100 (11% -> 1100) supaya tetap integer.
 */
export function taxInclusiveCents(
  lineCents: number,
  ratePct100: number,
): number {
  if (ratePct100 <= 0 || lineCents <= 0) return 0;
  const line = BigInt(lineCents);
  const rate = BigInt(ratePct100);
  const divisor = 10000n + rate;
  return Number((2n * line * rate + divisor) / (2n * divisor));
}

/**
 * Total preview Σ round2(qty x expected_unit_price) dan pajak preview (BR-SL-03,
 * BR-TX-03). null bila total melebihi batas numeric(14,2).
 */
export function previewTotals(
  items: { quantity: number; expected_unit_price: number }[],
  ratePct100: number,
): { totalCents: number; taxCents: number } | null {
  const lines = items.map((i) =>
    lineTotalCents(i.quantity, toCents(i.expected_unit_price)),
  );
  const total = lines.reduce((sum, l) => sum + l, 0n);
  if (total > MAX_AMOUNT_CENTS) return null;
  const taxCents = lines.reduce(
    (sum, l) => sum + taxInclusiveCents(Number(l), ratePct100),
    0,
  );
  return { totalCents: Number(total), taxCents };
}

/** Sen (integer) -> string 2 desimal tanpa galat floating point, mis. 550010 -> "5500.10". */
export function centsToFixed2(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}${whole}.${frac}`;
}

export interface HashItem {
  item_id: string;
  unit_id: string;
  quantity: number;
  expected_unit_price: number;
}

export interface HashPayment {
  method_code: string;
  tendered_amount: number;
}

/**
 * Request hash Billing (BR-SL-13): SHA-256 hex dari JSON kanonik. Urutan key
 * tetap (dibangun literal), urutan `items`/`payments` mengikuti request.
 */
export function computeRequestHash(input: {
  branchId: string;
  customerName: string | null;
  items: HashItem[];
  payments: HashPayment[];
}): string {
  const canonical = {
    branch_id: input.branchId,
    customer_name: input.customerName,
    items: input.items.map((i) => ({
      item_id: i.item_id,
      unit_id: i.unit_id,
      quantity: String(i.quantity),
      expected_unit_price: centsToFixed2(toCents(i.expected_unit_price)),
    })),
    payments: input.payments.map((p) => ({
      method_code: p.method_code,
      tendered_amount: centsToFixed2(toCents(p.tendered_amount)),
    })),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
