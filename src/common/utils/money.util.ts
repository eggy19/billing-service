/**
 * Helper uang (BR-SL-15): hitung dalam sen (integer), bukan floating point.
 * Pembulatan 2 desimal = half-up (setengah dibulatkan menjauhi nol; nominal
 * uang di Billing tidak negatif, sehingga sama dengan half-up biasa).
 */

const DECIMAL_RE = /^(-?)(\d+)(?:\.(\d+))?$/;

/** Mengubah angka/string desimal ke sen (integer) dengan half-up pada digit ke-3. */
export function toCents(amount: number | string): number {
  if (typeof amount === 'number' && !Number.isFinite(amount)) {
    throw new RangeError('amount must be finite');
  }
  // Number -> string tanpa notasi eksponen; parsing berbasis teks menghindari galat biner.
  const text =
    typeof amount === 'number'
      ? /e/i.test(String(amount))
        ? amount.toFixed(20).replace(/0+$/, '')
        : String(amount)
      : amount.trim();
  const m = DECIMAL_RE.exec(text.endsWith('.') ? text.slice(0, -1) : text);
  if (!m) throw new RangeError(`invalid decimal amount: ${text}`);

  const [, sign, whole, frac = ''] = m;
  const padded = frac.padEnd(3, '0');
  let cents = Number(whole) * 100 + Number(padded.slice(0, 2));
  if (Number(padded[2]) >= 5) cents += 1;
  if (!Number.isSafeInteger(cents)) {
    throw new RangeError(`amount out of safe range: ${text}`);
  }
  return sign === '-' && cents !== 0 ? -cents : cents;
}

/** Sen (integer) -> angka rupiah dengan paling banyak 2 desimal. */
export function fromCents(cents: number): number {
  if (!Number.isInteger(cents))
    throw new RangeError('cents must be an integer');
  return cents / 100;
}

/** Pembulatan half-up ke 2 desimal, tanpa galat floating point. */
export function roundHalfUp2(amount: number | string): number {
  return fromCents(toCents(amount));
}
