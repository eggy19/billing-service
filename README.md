# Billing Service

Shift kasir, penjualan, dan pembayaran untuk platform Healthcare SaaS (apotek lebih dulu,
dirancang agar bisa dikembangkan ke klinik/RS). NestJS 11 + TypeORM + PostgreSQL schema `billing`.

Aturan service ada di [`CLAUDE.md`](CLAUDE.md); aturan lintas service di `../CLAUDE.md`;
spesifikasi di `../dokumentasi/billing/billing-mvp-spec.md`.

## Menjalankan

```bash
npm install
cp .env.example .env        # sesuaikan DB; jangan commit .env
npm run migration:run       # belum ada migration pada tahap scaffold
npm run start:dev           # port 3002
curl http://localhost:3002/health
npm test
```

- Semua route dilayani di bawah prefix `/billing` (Gateway: `/api/v1/billing/*` -> `/billing/*`).
  Health: `/health` dan `/billing/health`. Swagger: `/api/docs`.
- Identitas dari Internal JWT `X-User-Context` (EdDSA, `iss=gateway-identity-service`,
  `aud=billing-service`), diverifikasi dengan `certs/public.pem` (public key saja).
- `/billing/internal/*` memakai `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`.
- Redis/BullMQ tidak dipakai.
