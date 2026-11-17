# Billing: Request Context & Integrasi

Version: 1.0 (BL-23, 2026-11-17)
Status: Final (sesuai kode per 2026-11-17: Billing `72bca22`, Inventory `0c92537`, Gateway `13e6e8d`)
Audience: Developer Billing, Inventory, Gateway, Frontend

Sumber kebenaran: **kode**. Aturan bisnis: [`../../dokumentasi/billing/billing-mvp-spec.md`](../../dokumentasi/billing/billing-mvp-spec.md)
(katalog error §8.4, API §7.5, checkout §5.5, jalur komunikasi §5.11). Pola autentikasi sama dengan Inventory:
[`../../inventory-pharmacy-service/docs/request-context-and-gateway-auth.md`](../../inventory-pharmacy-service/docs/request-context-and-gateway-auth.md).
Kontrak panggilan ke Inventory: [`../../inventory-pharmacy-service/docs/internal-dispensing-and-pos-lookup.md`](../../inventory-pharmacy-service/docs/internal-dispensing-and-pos-lookup.md).
Indeks: [`../../dokumentasi/billing/kontrak-integrasi.md`](../../dokumentasi/billing/kontrak-integrasi.md).

---

## 1. Request masuk dari Gateway (route user)

```
Browser ─cookie─▶ Gateway ─X-User-Context: <JWT aud=billing-service>, X-Request-Id─▶ Billing  /billing/*
```

Gateway meneruskan `/api/v1/billing/*` sebagai `/billing/*` (hanya `/api/v1` yang dibuang). Billing memakai global prefix `billing`;
`GET /health` dan `GET /billing/health` tanpa token dan tanpa prefix tambahan.

`TenantContextMiddleware` (jalan pertama) memanggil `GatewayAuthService.verify` (library `jose` + `certs/public.pem`):

| Cek | Nilai |
|-----|-------|
| Signature | Ed25519, `alg = EdDSA` saja |
| `iss` | `gateway-identity-service` (env `JWT_ISSUER`) |
| `aud` | **`billing-service`** (env `JWT_AUDIENCE`). Token ber-`aud=inventory-service` ditolak 401 |
| `exp` | belum lewat |
| Claim wajib | `sub`, `tenantId`, `branchId` (UUID), `requestId` (string tak kosong) |

Gagal apa pun (header `X-User-Context` kosong, JWT salah) -> 401 `UNAUTHORIZED` tanpa detail penyebab.

Claim -> `RequestContext`: `sub` -> `userId`; `tenantId`; `branchId`; `roles` dan `permissions` (bukan array string -> `[]`);
`name` (opsional, hanya string) -> `userName` (hanya untuk snapshot `cashier_name`; **jangan di-log**, BR-BL-04);
`sessionId`; `requestId`. Gateway memfilter `permissions` per route key: JWT `aud=billing-service` hanya berisi kode `billing.*`.
Billing karenanya tidak pernah melihat `inventory.pos_item.read` (POS lookup dipanggil FE langsung ke Inventory lewat Gateway).

Permission default-deny dan **selalu aktif** (tanpa flag rollout, BR-BL-02). Tanpa permission -> 403 `FORBIDDEN`.
Tenant dan branch hanya dari JWT, tidak pernah dari body/query.

---

## 2. Route Billing via Gateway

Semua di bawah `/api/v1/billing/...` (cookie session). Daftar sesuai controller saat ini:

| Method & path | Permission (any-of) |
|---------------|---------------------|
| `GET /billing/health` | - |
| `GET /billing/shifts/current`, `GET /billing/shifts`, `GET /billing/shifts/:id` | `billing.shift.read` atau `billing.shift.read_all` |
| `POST /billing/shifts/open` | `billing.shift.open` |
| `POST /billing/shifts/:id/close` | `billing.shift.close` |
| `GET /billing/payment-methods` | `billing.sale.create` |
| `POST /billing/sales` | `billing.sale.create` (+ header `Idempotency-Key`) |
| `GET /billing/sales`, `GET /billing/sales/:id` | `billing.sale.read` atau `billing.sale.read_all` |

Bentuk request/response per endpoint: spec §7.5. Route internal `/billing/internal/*` ada di rancangan (`InternalTokenGuard`)
tetapi **belum ada endpoint internal**.

---

## 3. Envelope

Sukses (key `data` camelCase; body request snake_case):

```json
{ "success": true, "message": "...", "data": { }, "pagination": { }, "timestamp": "..." }
```

`pagination` hanya untuk list. Error:

```json
{ "success": false, "code": "BIL_012", "message": "...", "errors": [ { "field": "items[0]", "message": "..." } ], "details": { }, "timestamp": "..." }
```

| Field | Kapan |
|-------|-------|
| `code` | Selalu. `BIL_xxx` atau generik `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `INTERNAL_SERVER_ERROR`; error HTTP lain `HTTP_<status>` |
| `errors[]` | Per baris/field: error validasi DTO (400), baris ganda (400), dan `BIL_012`/`BIL_013`/`BIL_014` (`field: "items[i]"`, pesan asli Inventory, indeks = urutan baris request). Replay sale `FAILED` mengembalikan `errors[]` yang sama |
| `details` | Aditif, hanya `BIL_016` dan `BIL_017`: `{ saleId, saleNumber }`. `saleNumber` boleh `null` (nomor SAL baru dibuat saat `PAID`). `BIL_017` akibat penolakan Inventory tidak membawa `errors[]` (nama field internal tidak bocor ke kasir) |

Header `Idempotency-Key` (`POST /billing/sales`): UUID wajib; tidak ada/bukan UUID -> 400 `BIL_008`. Billing menormalkan ke huruf kecil dan
menyimpannya unik per tenant. Perilaku key yang sudah ada: spec §5.5 BR-SL-04.

Catatan: error dari **Gateway sendiri** memakai envelope Gateway yang berbeda (lihat §6), tanpa `code`.

### Katalog error ringkas

Daftar resmi, pesan, dan HTTP: spec [§8.4](../../dokumentasi/billing/billing-mvp-spec.md) dan `src/common/constants/error-codes.ts`.
`BIL_001`..`BIL_017`; yang terkait integrasi Inventory: `BIL_012` (409, harga berubah), `BIL_013` (422, stok kurang),
`BIL_014` (422, item tak dapat dijual), `BIL_015` (503, Inventory tak terjangkau), `BIL_016` (409, `NEEDS_RECONCILIATION`),
`BIL_017` (500, bug integrasi/konfigurasi atau perlu rekonsiliasi). `BIL_010` juga dipakai saat tutup shift bentrok dengan checkout berjalan.

---

## 4. Panggilan Billing -> Inventory

Hanya satu: `POST {INVENTORY_INTERNAL_URL}/inventory/internal/dispensing` (class `InventoryHttpClient`), **langsung**, bukan lewat Gateway.

| Aspek | Perilaku kode |
|-------|---------------|
| Auth | `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` |
| Header konteks | `X-Tenant-Id` = `tenantId`, `X-Branch-Id` = `branchId`, `X-User-Id` = `sub`, `X-Request-Id` = request id asal (dari JWT user). `X-User-Context` **tidak** diteruskan |
| Idempotency | Field body `idempotency_key = "billing.sale:<sale.id>"`, `reference_type = "billing.sale"`, `reference_id = sale.id` (bukan header) |
| Body | snake_case (`items[].item_id`, `unit_id`, `quantity`, `expected_unit_price`); response dibaca camelCase |
| Timeout | 10 detik per percobaan (`AbortSignal.timeout`) |
| Retry | Maks 2 kali tambahan (jeda 1 dtk lalu 3 dtk) **hanya** untuk timeout, error jaringan, atau 5xx; 4xx tidak di-retry. Terburuk 3 x 10 + 1 + 3 = 34 dtk |
| Redirect | `redirect: 'manual'`: 3xx tidak diikuti (token tidak boleh ikut ke host lain) -> `NEEDS_RECONCILIATION` |
| Log | `inventory_retry` (warn) memuat `requestId`, ids, `attempt`, `reason`. Token, header, body, `customer_name`, `name` tidak pernah di-log |

Pemetaan hasil ke status sale dan error FE: spec §5.5 BR-SL-06 dan tabel di
[`internal-dispensing-and-pos-lookup.md`](../../inventory-pharmacy-service/docs/internal-dispensing-and-pos-lookup.md) §1.5.

---

## 5. Env pasangan Billing <-> Inventory

Nama variabel persis menurut `src/config/configuration.ts`, `src/config/env.validation.ts`, dan `.env.example`:

| Env (Billing) | Default | Keterangan |
|---------------|---------|------------|
| `INVENTORY_INTERNAL_URL` | `http://localhost:3001` | Origin Inventory (tanpa path; garis miring akhir dibuang). Di environment selain `development`/`test` **wajib** diisi (`validateEnv`) |
| `INTERNAL_SERVICE_TOKEN` | kosong | Di Billing dikirim sebagai Bearer; **harus sama persis** dengan `INTERNAL_SERVICE_TOKEN` Inventory. Di environment selain `development`/`test`, kosong atau `change-me` ditolak saat startup. Kosong di Billing -> Bearer kosong -> Inventory 401 |
| `JWT_PUBLIC_KEY_PATH`, `JWT_ISSUER`, `JWT_AUDIENCE` | `certs/public.pem`, `gateway-identity-service`, `billing-service` | Verifikasi Internal JWT |
| `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME`, `DB_SCHEMA` | `DB_SCHEMA` default `billing` | Koneksi PostgreSQL; `DB_PASSWORD` wajib di non-dev |
| `CORS_ORIGINS` | kosong | Kosong = izinkan semua origin (khusus dev); wajib diisi di non-dev |

Tanpa `REDIS_*` (BR-IN-05). Env di sisi Inventory: `INTERNAL_SERVICE_TOKEN` (pasangan), `SERVICE_NAME=inventory-service`,
dan `PERMISSION_GUARD_ENABLED=true` (default kode `false`; wajib `true` agar permission `inventory.pos_item.read` ditegakkan).

### Membuktikan pasangan token tanpa membaca nilai (retro H4 aturan 1-2)

Jangan `cat`/`grep`/`head` file `.env`. Pilih salah satu:

1. **Probe tanpa efek** (disarankan, sebelum test live). Dari folder `billing-service`, skrip membaca env sendiri dan hanya mencetak status HTTP:

   ```bash
   node -r dotenv/config -e "fetch(process.env.INVENTORY_INTERNAL_URL.replace(/\/+$/,'')+'/inventory/internal/dispensing',{method:'POST',headers:{Authorization:'Bearer '+process.env.INTERNAL_SERVICE_TOKEN,'Content-Type':'application/json'},body:'{}'}).then(r=>console.log(r.status))"
   ```

   Inventory memeriksa token **sebelum** membaca header konteks, sehingga: `400` = token cocok (gagal di header `X-Tenant-Id`, tidak ada yang tersimpan);
   `401` = token **berbeda** (perbaiki dulu); error koneksi = Inventory tidak jalan.
   Batasan probe: `401` juga muncul bila token di Inventory kosong/belum diset; bila `INVENTORY_INTERNAL_URL` tidak ada, skrip melempar `TypeError` (bukan status HTTP);
   bila `INTERNAL_SERVICE_TOKEN` Billing tidak ada, header menjadi `Bearer undefined` sehingga `401` menyesatkan. Pastikan kedua env terisi di kedua service sebelum menyimpulkan.
2. **Satu checkout uji** lewat FE/E2E: `401` dari Inventory membuat sale `FAILED` (`failure_code` `UNAUTHORIZED`),
   respons FE 500 `BIL_017`, log Billing `inventory_rejected_integration_error` (`httpStatus: 401`), dan **stok utuh**
   (perilaku terbukti di insiden R1). Checkout yang sukses (201) membuktikan pasangan benar.

Setelah mengganti token di salah satu service, restart service itu. Nilai token tidak pernah ditulis di dokumen, log, atau laporan.

---

## 6. Timeout dan envelope Gateway (konteks Billing)

- FE `POST /billing/sales` memakai timeout **45 detik** (`CHECKOUT_TIMEOUT_MS`; default `apiClient` 15 dtk). Proxy Gateway memakai axios **tanpa timeout**
  (tidak diubah, KB-16). Billing terburuk 34 dtk Inventory + operasi DB lokal (perkiraan < 2 dtk) = perkiraan sekitar 36 dtk < 45 dtk,
  sehingga FE normalnya menerima jawaban pasti (termasuk 503 `BIL_015`) sebelum timeout.
- Billing/Inventory mati -> **Gateway** menjawab 503 dengan envelope Gateway `{ success:false, message, error, timestamp, path }` (tanpa `code`).
  FE wajib mengenali dua bentuk 503 (`BIL_015` dari Billing, dan 503 Gateway) dan memakai ulang `Idempotency-Key` yang sama (BR-SL-02).
- Gateway meneruskan `Idempotency-Key` (tidak ada di denylist header). Status dan body Billing selain itu diteruskan apa adanya.
