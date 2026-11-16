import type { ConfigService } from '@nestjs/config';
import type { Logger } from 'winston';
import type {
  DispensingRequest,
  InventoryCallContext,
} from './inventory-dispensing.port';
import {
  INVENTORY_ATTEMPT_TIMEOUT_MS,
  INVENTORY_RETRY_DELAYS_MS,
  InventoryHttpClient,
} from './inventory-http.client';

const TOKEN = 'super-secret-internal-token';

const REQUEST: DispensingRequest = {
  idempotency_key: 'billing.sale:s-1',
  reference_type: 'billing.sale',
  reference_id: 's-1',
  items: [
    { item_id: 'i1', unit_id: 'u1', quantity: 2, expected_unit_price: 5500 },
  ],
};
const CONTEXT: InventoryCallContext = {
  tenantId: 't-A',
  branchId: 'b-P',
  userId: 'u-rina',
  requestId: 'req-1',
  saleId: 's-1',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function make(responses: Array<Response | Error>) {
  const config = {
    get: (key: string) =>
      key === 'inventory.internalUrl'
        ? 'http://inventory.local:3001/'
        : key === 'security.internalServiceToken'
          ? TOKEN
          : undefined,
  } as unknown as ConfigService;
  const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
  const client = new InventoryHttpClient(config, logger as unknown as Logger);
  const queue = [...responses];
  const fetchFn = jest.fn((_url: unknown, _init?: RequestInit) => {
    const next = queue.shift();
    if (!next) throw new Error('no more fake responses');
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  const sleeps: number[] = [];
  client.fetchFn = fetchFn;
  client.sleepFn = (ms) => {
    sleeps.push(ms);
    return Promise.resolve();
  };
  return { client, fetchFn, sleeps, logger };
}

const timeoutError = () =>
  Object.assign(new Error('timeout'), { name: 'TimeoutError' });

describe('InventoryHttpClient (BR-SL-05, §4.10)', () => {
  it('konstanta anggaran waktu = 10 dtk per percobaan, jeda 1 dan 3 dtk', () => {
    expect(INVENTORY_ATTEMPT_TIMEOUT_MS).toBe(10_000);
    expect(INVENTORY_RETRY_DELAYS_MS).toEqual([1000, 3000]);
  });

  it('mengirim POST langsung ke Inventory dengan header konteks + Bearer, body snake_case', async () => {
    const { client, fetchFn } = make([
      jsonResponse(201, { success: true, data: { dispensingId: 'd-1' } }),
    ]);
    const out = await client.createDispensing(REQUEST, CONTEXT);

    expect(out).toEqual({
      kind: 'SUCCESS',
      httpStatus: 201,
      body: { success: true, data: { dispensingId: 'd-1' } },
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(
      'http://inventory.local:3001/inventory/internal/dispensing',
    );
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      'X-Tenant-Id': 't-A',
      'X-Branch-Id': 'b-P',
      'X-User-Id': 'u-rina',
      'X-Request-Id': 'req-1',
    });
    expect(JSON.parse(init?.body as string)).toEqual(REQUEST);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('200 replay Inventory diperlakukan sebagai SUCCESS', async () => {
    const { client } = make([jsonResponse(200, { data: { replayed: true } })]);
    await expect(
      client.createDispensing(REQUEST, CONTEXT),
    ).resolves.toMatchObject({
      kind: 'SUCCESS',
      httpStatus: 200,
    });
  });

  it('2xx dengan body bukan JSON -> SUCCESS dengan body undefined (SaleService menilainya cacat)', async () => {
    const { client } = make([jsonResponse(201, 'bukan json')]);
    await expect(client.createDispensing(REQUEST, CONTEXT)).resolves.toEqual({
      kind: 'SUCCESS',
      httpStatus: 201,
      body: undefined,
    });
  });

  it('4xx tidak di-retry (AC-SL-06 negatif: tepat 1 panggilan) dan membawa code + errors[]', async () => {
    const { client, fetchFn, sleeps } = make([
      jsonResponse(422, {
        success: false,
        code: 'INV_003',
        message: 'Stok tidak cukup',
        errors: [
          { field: 'items[0]', message: 'Tersedia 12 Strip' },
          { bukan: 'valid' },
        ],
      }),
    ]);
    const out = await client.createDispensing(REQUEST, CONTEXT);
    expect(out).toEqual({
      kind: 'REJECTED',
      httpStatus: 422,
      code: 'INV_003',
      errors: [{ field: 'items[0]', message: 'Tersedia 12 Strip' }],
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('4xx tanpa envelope JSON -> REJECTED dengan code null', async () => {
    const { client } = make([jsonResponse(404, '<html>Not Found</html>')]);
    await expect(client.createDispensing(REQUEST, CONTEXT)).resolves.toEqual({
      kind: 'REJECTED',
      httpStatus: 404,
      code: null,
      errors: null,
    });
  });

  it('timeout dua kali lalu sukses: 3 percobaan, jeda 1 dtk dan 3 dtk, body & key sama', async () => {
    const { client, fetchFn, sleeps } = make([
      timeoutError(),
      new TypeError('fetch failed'),
      jsonResponse(201, { data: { dispensingId: 'd-1' } }),
    ]);
    const out = await client.createDispensing(REQUEST, CONTEXT);
    expect(out.kind).toBe('SUCCESS');
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 3000]);
    const bodies = fetchFn.mock.calls.map((c) => c[1]?.body);
    expect(new Set(bodies).size).toBe(1);
  });

  it('Inventory mati (AC-SL-06): 3 percobaan gagal -> UNAVAILABLE, tanpa percobaan ke-4', async () => {
    const { client, fetchFn, sleeps, logger } = make([
      new TypeError('fetch failed'),
      new TypeError('fetch failed'),
      new TypeError('fetch failed'),
    ]);
    const out = await client.createDispensing(REQUEST, CONTEXT);
    expect(out).toEqual({
      kind: 'UNAVAILABLE',
      attempts: 3,
      reason: 'network_error',
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 3000]);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      'inventory_retry',
      expect.objectContaining({
        saleId: 's-1',
        requestId: 'req-1',
        attempt: 1,
      }),
    );
  });

  it('5xx di-retry dan, bila habis, UNAVAILABLE dengan alasan http_5xx', async () => {
    const { client, fetchFn } = make([
      jsonResponse(502, 'bad gateway'),
      jsonResponse(503, 'unavailable'),
      jsonResponse(500, 'boom'),
    ]);
    await expect(client.createDispensing(REQUEST, CONTEXT)).resolves.toEqual({
      kind: 'UNAVAILABLE',
      attempts: 3,
      reason: 'http_500',
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('timeout terakhir dilaporkan sebagai reason timeout', async () => {
    const { client } = make([timeoutError(), timeoutError(), timeoutError()]);
    await expect(
      client.createDispensing(REQUEST, CONTEXT),
    ).resolves.toMatchObject({ kind: 'UNAVAILABLE', reason: 'timeout' });
  });

  it('status di luar 2xx/4xx/5xx (3xx) -> UNEXPECTED tanpa retry', async () => {
    const { client, fetchFn } = make([jsonResponse(302, '')]);
    await expect(client.createDispensing(REQUEST, CONTEXT)).resolves.toEqual({
      kind: 'UNEXPECTED',
      httpStatus: 302,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // redirect tidak diikuti, jadi Bearer token tidak ikut ke host lain
    expect(fetchFn.mock.calls[0][1]?.redirect).toBe('manual');
  });

  it('token internal dan body tidak pernah muncul di log (BR-IN-04, BR-BL-04)', async () => {
    const { client, logger } = make([
      timeoutError(),
      timeoutError(),
      timeoutError(),
    ]);
    await client.createDispensing(REQUEST, CONTEXT);
    const logged = JSON.stringify([
      logger.warn.mock.calls,
      logger.info.mock.calls,
      logger.error.mock.calls,
    ]);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain('expected_unit_price');
    expect(logged).not.toContain('billing.sale:s-1');
  });
});
