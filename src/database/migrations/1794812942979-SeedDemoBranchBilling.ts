import { MigrationInterface, QueryRunner } from 'typeorm';
import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

/**
 * Seed cabang demo (BR-BL-05, KB-07; ID tetap sama dengan seed Gateway):
 * `billing_setting.tax_rate` 11 dan `payment_method` CASH aktif. Cabang lain
 * dibuat lazy oleh BillingSettingService / PaymentMethodService.
 */
export class SeedDemoBranchBilling1794812942979 implements MigrationInterface {
  name = 'SeedDemoBranchBilling1794812942979';

  private readonly TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';
  private readonly BRANCH = 'bbbbbbbb-0000-0000-0000-000000000001';

  /** Penanda baris seed: created_by = user seed Gateway (lazy-create memakai NULL). */
  private readonly SEED_USER = 'cccccccc-0000-0000-0000-000000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const s = schemaOf(queryRunner);
    await queryRunner.query(
      `INSERT INTO "${s}"."billing_setting" ("tenant_id","branch_id","tax_rate","created_by")
       VALUES ($1,$2,11,$3) ON CONFLICT DO NOTHING`,
      [this.TENANT, this.BRANCH, this.SEED_USER],
    );
    await queryRunner.query(
      `INSERT INTO "${s}"."payment_method"
         ("tenant_id","branch_id","code","name","is_cash","requires_reference","is_active","created_by")
       VALUES ($1,$2,'CASH','Tunai',true,false,true,$3) ON CONFLICT DO NOTHING`,
      [this.TENANT, this.BRANCH, this.SEED_USER],
    );
  }

  /**
   * Hanya untuk revert di dev: menghapus (hard) baris seed saja, dikenali dari
   * created_by = SEED_USER. Baris lazy-create/edit user tidak ikut terhapus.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const s = schemaOf(queryRunner);
    await queryRunner.query(
      `DELETE FROM "${s}"."payment_method"
       WHERE "tenant_id" = $1 AND "branch_id" = $2 AND "code" = 'CASH' AND "created_by" = $3`,
      [this.TENANT, this.BRANCH, this.SEED_USER],
    );
    await queryRunner.query(
      `DELETE FROM "${s}"."billing_setting"
       WHERE "tenant_id" = $1 AND "branch_id" = $2 AND "created_by" = $3`,
      [this.TENANT, this.BRANCH, this.SEED_USER],
    );
  }
}

function schemaOf(queryRunner: QueryRunner): string {
  const schema = (queryRunner.connection.options as PostgresConnectionOptions)
    .schema;
  if (!schema) throw new Error('DataSource schema (DB_SCHEMA) is not set');
  return schema;
}
