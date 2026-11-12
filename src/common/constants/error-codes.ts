import { HttpStatus } from '@nestjs/common';

/**
 * Centralised error-code catalog (spec billing-mvp-spec §8.4). Business errors
 * reference these codes so responses stay consistent and clients can branch on
 * a stable identifier. Tambah kode baru di sini, jangan hardcode pesan di service.
 */
export interface ErrorCodeDef {
  code: string;
  message: string;
  status: HttpStatus;
}

export const ERROR_CODES = {
  // Generic
  VALIDATION_ERROR: {
    code: 'VALIDATION_ERROR',
    message: 'Invalid request',
    status: HttpStatus.BAD_REQUEST,
  },
  INTERNAL_SERVER_ERROR: {
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Unexpected error occurred',
    status: HttpStatus.INTERNAL_SERVER_ERROR,
  },
  UNAUTHORIZED: {
    code: 'UNAUTHORIZED',
    message: 'Unauthorized',
    status: HttpStatus.UNAUTHORIZED,
  },
  FORBIDDEN: {
    code: 'FORBIDDEN',
    message: 'Anda tidak memiliki izin untuk aksi ini',
    status: HttpStatus.FORBIDDEN,
  },

  // Billing domain
  BIL_001: {
    code: 'BIL_001',
    message: 'Shift tidak ditemukan',
    status: HttpStatus.NOT_FOUND,
  },
  BIL_002: {
    code: 'BIL_002',
    message: 'Anda masih memiliki shift yang terbuka',
    status: HttpStatus.CONFLICT,
  },
  BIL_003: {
    code: 'BIL_003',
    message: 'Buka shift terlebih dahulu',
    status: HttpStatus.UNPROCESSABLE_ENTITY,
  },
  BIL_004: {
    code: 'BIL_004',
    message: 'Shift sudah ditutup atau bukan milik Anda',
    status: HttpStatus.CONFLICT,
  },
  BIL_005: {
    code: 'BIL_005',
    message: 'Penjualan tidak ditemukan',
    status: HttpStatus.NOT_FOUND,
  },
  BIL_006: {
    code: 'BIL_006',
    message: 'Uang yang diterima kurang dari total',
    status: HttpStatus.UNPROCESSABLE_ENTITY,
  },
  BIL_007: {
    code: 'BIL_007',
    message: 'Metode pembayaran tidak valid atau tidak aktif',
    status: HttpStatus.UNPROCESSABLE_ENTITY,
  },
  BIL_008: {
    code: 'BIL_008',
    message: 'Header Idempotency-Key wajib diisi (UUID)',
    status: HttpStatus.BAD_REQUEST,
  },
  BIL_009: {
    code: 'BIL_009',
    message: 'Idempotency-Key sudah dipakai untuk transaksi berbeda',
    status: HttpStatus.UNPROCESSABLE_ENTITY,
  },
  BIL_010: {
    code: 'BIL_010',
    message: 'Transaksi sedang diproses, coba lagi sebentar',
    status: HttpStatus.CONFLICT,
  },
  BIL_011: {
    code: 'BIL_011',
    message: 'Catatan wajib diisi bila ada selisih kas',
    status: HttpStatus.UNPROCESSABLE_ENTITY,
  },
  BIL_012: {
    code: 'BIL_012',
    message: 'Harga berubah, periksa kembali keranjang',
    status: HttpStatus.CONFLICT,
  },
  BIL_013: {
    code: 'BIL_013',
    message: 'Stok tidak mencukupi',
    status: HttpStatus.UNPROCESSABLE_ENTITY,
  },
  BIL_014: {
    code: 'BIL_014',
    message: 'Ada item yang tidak dapat dijual',
    status: HttpStatus.UNPROCESSABLE_ENTITY,
  },
  BIL_015: {
    code: 'BIL_015',
    message: 'Layanan stok tidak dapat dihubungi, ulangi transaksi',
    status: HttpStatus.SERVICE_UNAVAILABLE,
  },
  BIL_016: {
    code: 'BIL_016',
    message: 'Transaksi perlu diperiksa supervisor (rekonsiliasi)',
    status: HttpStatus.CONFLICT,
  },
  BIL_017: {
    code: 'BIL_017',
    message: 'Transaksi gagal disimpan, hubungi supervisor',
    status: HttpStatus.INTERNAL_SERVER_ERROR,
  },
} as const satisfies Record<string, ErrorCodeDef>;

export type ErrorCodeKey = keyof typeof ERROR_CODES;
