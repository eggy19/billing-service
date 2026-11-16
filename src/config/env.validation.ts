/**
 * Validasi env saat startup (fail-fast). Dipakai `ConfigModule.forRoot({ validate })`.
 * Nilai default tetap diterapkan di `configuration.ts`; di sini hanya nilai yang
 * salah bentuk atau tidak aman untuk environment non-development yang ditolak.
 * Tidak ada `REDIS_*` (BR-IN-05). Nilai secret tidak pernah ikut di pesan error.
 */
export function validateEnv(
  env: Record<string, unknown>,
): Record<string, unknown> {
  const errors: string[] = [];
  const str = (key: string): string | undefined => {
    const v = env[key];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  };

  const nodeEnv = str('NODE_ENV') ?? 'development';

  for (const key of ['APP_PORT', 'PORT', 'DB_PORT']) {
    const v = str(key);
    if (v !== undefined && !/^\d+$/.test(v)) {
      errors.push(`${key} must be an integer`);
    } else if (v !== undefined && (Number(v) < 1 || Number(v) > 65535)) {
      errors.push(`${key} must be between 1 and 65535`);
    }
  }

  const schema = str('DB_SCHEMA');
  if (schema !== undefined && !/^[a-z_][a-z0-9_]*$/.test(schema)) {
    errors.push('DB_SCHEMA must be a simple lowercase identifier');
  }

  // Ketat untuk semua nilai kecuali development/test/kosong (persis), supaya salah ketik
  // seperti `prod` atau `Production` tidak menurunkan keamanan.
  if (nodeEnv !== 'development' && nodeEnv !== 'test') {
    const token = str('INTERNAL_SERVICE_TOKEN');
    if (!token || token === 'change-me') {
      errors.push('INTERNAL_SERVICE_TOKEN must be set to a real secret');
    }
    if (!str('DB_PASSWORD')) errors.push('DB_PASSWORD is required');
    // Kosong = main.ts memantulkan semua origin + credentials: hanya boleh di dev.
    if (!str('CORS_ORIGINS')) {
      errors.push('CORS_ORIGINS is required (explicit origins)');
    }
    // Checkout memanggil Inventory langsung (BR-SL-05): jangan diam-diam ke localhost.
    if (!str('INVENTORY_INTERNAL_URL')) {
      errors.push('INVENTORY_INTERNAL_URL is required');
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration: ${errors.join('; ')}`);
  }
  return env;
}
