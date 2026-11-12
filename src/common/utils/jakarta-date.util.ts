/** Zona waktu bisnis untuk "hari ini" dan nomor dokumen: Asia/Jakarta untuk semua cabang. */
export const BUSINESS_TIME_ZONE = 'Asia/Jakarta';

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Tanggal kalender (YYYY-MM-DD) di Asia/Jakarta, bukan UTC.
 * `now` selalu bisa disuplai caller supaya test lintas tengah malam WIB
 * deterministik (tanpa fake timer global).
 */
export function toJakartaDate(now: Date = new Date()): string {
  return dateFormatter.format(now);
}

/** Kunci tanggal untuk nomor dokumen (YYYYMMDD), mis. `SAL-20261113-0001`. */
export function toJakartaDateKey(now: Date = new Date()): string {
  return toJakartaDate(now).replace(/-/g, '');
}
