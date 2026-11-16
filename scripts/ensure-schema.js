/**
 * Membuat schema DB_SCHEMA bila belum ada. Dipanggil otomatis oleh hook npm
 * `premigration:run` / `premigration:revert`: TypeORM membuat tabel riwayat
 * `migrations` di schema tersebut SEBELUM migration pertama jalan, sehingga
 * `CREATE SCHEMA` di dalam migration saja tidak cukup (AC-BL-01).
 */
const { config } = require('dotenv');
const { Client } = require('pg');

config();

async function main() {
  const schema = process.env.DB_SCHEMA ?? 'billing';
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error('DB_SCHEMA harus berupa identifier huruf kecil sederhana');
  }
  const client = new Client({
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    user: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD ?? 'postgres',
    database: process.env.DB_NAME ?? 'klinik',
  });
  await client.connect();
  try {
    // Cek dulu: user DB berhak terbatas (tanpa CREATE) tidak boleh gagal bila schema sudah ada.
    const { rowCount } = await client.query(
      'SELECT 1 FROM information_schema.schemata WHERE schema_name = $1',
      [schema],
    );
    if (!rowCount) {
      await client.query(`CREATE SCHEMA "${schema}"`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
