# Billing Service

Kamu adalah senior software engineer. Baca dan ikuti dokumen di bawah sebelum mengerjakan
task apa pun di service ini. Aturan lintas service (komunikasi, schema database, aturan umum)
ada di root [`../CLAUDE.md`](../CLAUDE.md).

## Wajib dibaca

1. [`../dokumentasi/billing/billing-mvp-spec.md`](../dokumentasi/billing/billing-mvp-spec.md) —
   spesifikasi Billing Kasir MVP (aturan bisnis, schema §7.4, API §7.5, katalog error §8.4,
   kontrak antar modul §5.13).
2. [`../inventory-pharmacy-service/docs/request-context-and-gateway-auth.md`](../inventory-pharmacy-service/docs/request-context-and-gateway-auth.md) —
   pola verifikasi Internal JWT (Billing memakai pola yang sama, `aud=billing-service`).
3. Handbook backend platform: `../inventory-pharmacy-service/docs/Hanbook Backend Saas 3.md`.
4. [`../dokumentasi/project/timeline-2026-11-10.md`](../dokumentasi/project/timeline-2026-11-10.md) —
   rencana aktif, termasuk Pagar Desain Klinik (§3).

## Ringkasan Teknis

- NestJS 11, TypeScript, TypeORM, PostgreSQL schema `billing`, Winston, Swagger (`/api/docs`).
- Port **3002**. Global prefix `billing` (Gateway meneruskan `/api/v1/billing/*` sebagai `/billing/*`).
  `/health` dan `/billing/health` tanpa prefix tambahan dan tanpa token.
- **Tanpa Redis/BullMQ.** Jangan menambahkannya tanpa persetujuan user.
- Building block bersama ada di `src/common/` — pakai yang ada, jangan buat duplikat
  (BR-MD-01). Entity semua tabel hanya dibuat sekali (satu sumber entity).

## Aturan Kunci

- **Auth**: service ini tidak mengautentikasi user. Identitas dari Internal JWT di header
  `X-User-Context`, diverifikasi `GatewayAuthService`: `alg=EdDSA`, `iss=gateway-identity-service`,
  **`aud=billing-service`**, `exp`, public key `certs/public.pem` (path via `JWT_PUBLIC_KEY_PATH`).
  Claim: `sub`, `tenantId`, `branchId`, `roles`, `permissions`, `name` -> `RequestContext`
  (`userId`, `userName`, dst.). `jose` hanya ESM: mock verifier di Jest.
- **Route internal** `/billing/internal/*`: `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`
  (constant-time, `InternalTokenGuard`), konteks dari header `X-Tenant-Id`, `X-Branch-Id`,
  `X-User-Id`. Ini satu-satunya tempat tenant/branch boleh datang dari request. Belum ada
  endpoint internal.
- **Tenant/branch isolation**: semua query wajib di-scope `tenant_id` + `branch_id` dari
  `RequestContext`. Jangan pernah menerima keduanya dari body/query.
- **Permission**: default-deny, **selalu aktif** (tanpa flag rollout, BR-BL-02). Setiap handler
  publik wajib `@RequirePermission('billing.<resource>.<action>')` dari katalog
  `src/common/constants/permissions.ts`; endpoint baca berdata-milik menerima `read` atau
  `read_all` (any-of), scope data diterapkan di service. `@PermissionExempt()` hanya untuk
  `/health` dan `/billing/internal/*`. Handler baru wajib didaftarkan di `EXPECTED` pada
  `permission-coverage.spec.ts`.
- **Base columns** setiap tabel: `id`, `tenant_id`, `branch_id`, `created_at/by`,
  `updated_at/by`, `deleted_at/by` (`src/database/base.entity.ts`). Soft delete saja.
  Uang `numeric(14,2)`, kuantitas `numeric(18,4)`.
- **Uang**: hitung dalam sen (integer) atau desimal, bukan float; half-up 2 desimal
  (`src/common/utils/money.util.ts`, BR-SL-15). **Tanggal bisnis** Asia/Jakarta
  (`jakarta-date.util.ts`); helper menerima `now` supaya test deterministik.
- **Transaksi**: operasi multi-tabel dalam satu transaksi; port `ShiftGuard`
  (`src/modules/shift/shift-guard.port.ts`) bekerja dalam transaksi milik caller (BR-MD-03).
- **Error**: katalog `BIL_xxx` di `src/common/constants/error-codes.ts`; tambah kode baru di
  sana, jangan hardcode pesan di service. Envelope error `{ success: false, code, message,
  errors?, timestamp }`; sukses `{ success, message, data, pagination?, timestamp }` dengan key
  **camelCase**; body request snake_case.
- **Log**: terstruktur dengan `requestId`, `userId`, `tenantId`, `branchId`, `saleId`. Jangan
  log body request/response, `customer_name`, atau claim `name` (BR-BL-04).
- **Schema berubah -> migration**; `synchronize` selalu `false`. Migration yang sudah di-commit
  tidak boleh diedit.

## Pagar Desain Klinik (timeline §3 butir 3)

Fokus sekarang apotek, tetapi dari awal:

- `sale.source_type` (`OTC` sekarang; `PRESCRIPTION` dan `CLINIC_SERVICE` kelak) + `source_id`.
- `patient_id` nullable.
- `sale_item` menyimpan snapshot nama/kode/satuan.
- `payment` terpisah dari `sale`.
- `payment_method` per tenant.
- Permission mengikuti pola `billing.<resource>.<action>`.
- Panggilan ke Inventory memakai `reference_type`/`reference_id` generik (`billing.sale` sekarang).

## Perintah

```bash
npm run start:dev          # port 3002
npm test
npx tsc --noEmit -p tsconfig.build.json
npm run migration:generate -- src/database/migrations/<Name>
npm run migration:run
```
