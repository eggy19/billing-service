import type { ErrorFieldDetail } from '../../../common/exceptions/business.exception';

/**
 * Port client Inventory untuk checkout (spec §7.2, BR-SL-05, C2). SaleService
 * hanya bergantung pada token ini sehingga unit test memakai fake; implementasi
 * HTTP ada di `inventory-http.client.ts`. Port tidak melempar error: semua hasil
 * dikembalikan sebagai `DispensingOutcome` dan dipetakan SaleService (BR-SL-06).
 */
export const INVENTORY_DISPENSING_CLIENT = Symbol(
  'INVENTORY_DISPENSING_CLIENT',
);

/** Body request ke Inventory, snake_case (BR-IN-03). */
export interface DispensingRequest {
  idempotency_key: string;
  reference_type: 'billing.sale';
  reference_id: string;
  items: {
    item_id: string;
    unit_id: string;
    quantity: number;
    expected_unit_price: number;
  }[];
}

/** Konteks yang diteruskan sebagai header `X-*` (dari JWT user, bukan dari body). */
export interface InventoryCallContext {
  tenantId: string;
  branchId: string;
  userId: string;
  requestId: string;
  /** Hanya untuk log (korelasi retry dengan sale); tidak dikirim sebagai header. */
  saleId: string;
}

export type DispensingOutcome =
  /** 2xx. `body` = JSON hasil parse (envelope camelCase) atau undefined bila tidak bisa di-parse. */
  | { kind: 'SUCCESS'; httpStatus: number; body: unknown }
  /** 4xx. `code` = kode error Inventory (mis. `INV_062`) bila ada di body. */
  | {
      kind: 'REJECTED';
      httpStatus: number;
      code: string | null;
      errors: ErrorFieldDetail[] | null;
    }
  /** Timeout / jaringan / 5xx setelah retry habis (BR-SL-05). */
  | { kind: 'UNAVAILABLE'; attempts: number; reason: string }
  /** Status di luar 2xx/4xx/5xx (mis. 3xx): hasil tidak bisa dipercaya. */
  | { kind: 'UNEXPECTED'; httpStatus: number };

export interface InventoryDispensingClient {
  createDispensing(
    request: DispensingRequest,
    context: InventoryCallContext,
  ): Promise<DispensingOutcome>;
}
