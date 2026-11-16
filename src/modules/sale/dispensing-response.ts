import { toCents } from '../../common/utils/money.util';
import type { SaleRequestItem } from './entities/sale.entity';

/** Satu baris response Inventory yang sudah divalidasi, urut sesuai baris request. */
export interface ParsedDispensingLine {
  itemId: string;
  unitId: string;
  itemCode: string;
  itemName: string;
  unitCode: string | null;
  unitName: string | null;
  drugGroupCode: string | null;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface ParsedDispensing {
  dispensingId: string;
  dispensingNumber: string;
  grandTotalCents: number;
  lines: ParsedDispensingLine[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0;
const finiteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);
const optionalString = (v: unknown): string | null =>
  typeof v === 'string' ? v : null;

/** `dispensingId` bila ada di body (untuk log), walau body lain tidak valid. */
export function peekDispensingId(body: unknown): string | null {
  const data = isRecord(body) && isRecord(body.data) ? body.data : null;
  return data && nonEmptyString(data.dispensingId) ? data.dispensingId : null;
}

/**
 * Validasi response 2xx Inventory (BR-IN-03, BR-SL-06): field wajib ada, jumlah
 * dan identitas baris sama dengan request, serta Σ lineTotal = grandTotal (sen).
 * null = tidak valid -> sale NEEDS_RECONCILIATION (stok mungkin sudah terpotong).
 * Billing tidak mengandalkan `lineNo`: baris dicocokkan lewat (itemId, unitId)
 * dan dinomori ulang mengikuti urutan request.
 */
export function parseDispensingResponse(
  body: unknown,
  requestItems: SaleRequestItem[],
): ParsedDispensing | null {
  try {
    const data = isRecord(body) && isRecord(body.data) ? body.data : null;
    if (!data) return null;
    if (!nonEmptyString(data.dispensingId)) return null;
    if (!nonEmptyString(data.dispensingNumber)) return null;
    if (!finiteNumber(data.grandTotal)) return null;
    if (!Array.isArray(data.items)) return null;
    if (data.items.length !== requestItems.length) return null;

    const byKey = new Map<string, Record<string, unknown>>();
    for (const raw of data.items as unknown[]) {
      if (!isRecord(raw)) return null;
      if (!Number.isInteger(raw.lineNo)) return null;
      if (!nonEmptyString(raw.itemId) || !nonEmptyString(raw.unitId)) {
        return null;
      }
      if (!nonEmptyString(raw.itemCode) || !nonEmptyString(raw.itemName)) {
        return null;
      }
      if (
        !finiteNumber(raw.quantity) ||
        !finiteNumber(raw.unitPrice) ||
        !finiteNumber(raw.lineTotal)
      ) {
        return null;
      }
      const key = `${raw.itemId}|${raw.unitId}`;
      if (byKey.has(key)) return null;
      byKey.set(key, raw);
    }

    let sumCents = 0;
    const lines: ParsedDispensingLine[] = [];
    for (const req of requestItems) {
      const raw = byKey.get(`${req.item_id}|${req.unit_id}`);
      if (!raw) return null;
      if (Number(raw.quantity) !== Number(req.quantity)) return null;
      const lineTotalCents = toCents(raw.lineTotal as number);
      sumCents += lineTotalCents;
      lines.push({
        itemId: req.item_id,
        unitId: req.unit_id,
        itemCode: raw.itemCode as string,
        itemName: raw.itemName as string,
        unitCode: optionalString(raw.unitCode),
        unitName: optionalString(raw.unitName),
        drugGroupCode: optionalString(raw.drugGroupCode),
        quantity: raw.quantity as number,
        unitPriceCents: toCents(raw.unitPrice as number),
        lineTotalCents,
      });
    }
    const grandTotalCents = toCents(data.grandTotal);
    if (sumCents !== grandTotalCents) return null;

    return {
      dispensingId: data.dispensingId,
      dispensingNumber: data.dispensingNumber,
      grandTotalCents,
      lines,
    };
  } catch {
    // toCents melempar RangeError untuk angka di luar jangkauan.
    return null;
  }
}
