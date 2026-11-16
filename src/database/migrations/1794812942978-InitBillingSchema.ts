import { MigrationInterface, QueryRunner } from 'typeorm';
import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

/**
 * Schema awal Billing (spec billing-mvp-spec §7.4): 7 tabel di schema `billing`
 * beserta base column, index, unique parsial, dan FK. Nama schema dibaca dari
 * konfigurasi DataSource (DB_SCHEMA), tidak di-hardcode.
 *
 * Down tidak men-drop schema: tabel `migrations` TypeORM bisa berada di dalamnya.
 */
export class InitBillingSchema1794812942978 implements MigrationInterface {
  name = 'InitBillingSchema1794812942978';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const s = schemaOf(queryRunner);
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "${s}"`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    const base = `
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "tenant_id" uuid NOT NULL,
      "branch_id" uuid NOT NULL,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "created_by" uuid,
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_by" uuid,
      "deleted_at" TIMESTAMP WITH TIME ZONE,
      "deleted_by" uuid`;

    // Nama index tenant_id / branch_id mengikuti penamaan otomatis TypeORM (@Index di BaseEntity).
    const baseIndexes: Array<[string, string, string]> = [
      [
        'document_number_sequence',
        'IDX_b21583f1a9652ae8df0b641609',
        'IDX_bf4d3445690202d1ed441e4dd1',
      ],
      [
        'cashier_shift',
        'IDX_9015a1764ca8a7b9e1c4283307',
        'IDX_bd866776d58443d78569bbb59d',
      ],
      [
        'sale',
        'IDX_02025369b98836c107ddada471',
        'IDX_f168ad2e2c51de8ea45f751f4b',
      ],
      [
        'billing_setting',
        'IDX_b5da5b4f2eca967c69bf781c3c',
        'IDX_16d8febd6cb7bce330d48bc5c0',
      ],
      [
        'sale_item',
        'IDX_519f72c3482ba7309bec97a6ab',
        'IDX_a3cd560d808c4ee534aa538572',
      ],
      [
        'payment_method',
        'IDX_309b0d0d1a2b9644cf5a4dfd8e',
        'IDX_8290c229371b06092f07ccffcb',
      ],
      [
        'payment',
        'IDX_46e36847de83d3c01e7f66b40f',
        'IDX_2c462ff83e2ae67f603719ddb1',
      ],
    ];

    await queryRunner.query(`
      CREATE TABLE "${s}"."document_number_sequence" (
        ${base},
        "doc_type" character varying(20) NOT NULL,
        "date_key" character varying(8) NOT NULL,
        "last_number" integer NOT NULL DEFAULT '0',
        CONSTRAINT "uq_doc_number_seq" UNIQUE ("tenant_id", "branch_id", "doc_type", "date_key"),
        CONSTRAINT "PK_a5c44d13599100a3313bc355225" PRIMARY KEY ("id"))`);

    await queryRunner.query(`
      CREATE TABLE "${s}"."billing_setting" (
        ${base},
        "tax_rate" numeric(5,2) NOT NULL DEFAULT '0',
        "receipt_header" text,
        "receipt_footer" text,
        CONSTRAINT "PK_1b9ddcae36419d64fa774eb05cc" PRIMARY KEY ("id"))`);

    await queryRunner.query(`
      CREATE TABLE "${s}"."payment_method" (
        ${base},
        "code" character varying(30) NOT NULL,
        "name" character varying(100) NOT NULL,
        "is_cash" boolean NOT NULL,
        "requires_reference" boolean NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        CONSTRAINT "PK_7744c2b2dd932c9cf42f2b9bc3a" PRIMARY KEY ("id"))`);

    await queryRunner.query(`
      CREATE TABLE "${s}"."cashier_shift" (
        ${base},
        "shift_number" character varying(30) NOT NULL,
        "cashier_user_id" uuid NOT NULL,
        "cashier_name" character varying(150),
        "status" character varying(20) NOT NULL,
        "opened_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "opening_cash" numeric(14,2) NOT NULL,
        "open_note" text,
        "closed_at" TIMESTAMP WITH TIME ZONE,
        "closed_by" uuid,
        "expected_cash" numeric(14,2),
        "closing_cash_counted" numeric(14,2),
        "cash_difference" numeric(14,2),
        "close_note" text,
        CONSTRAINT "PK_ea2f97ed178ab2690edfe81684e" PRIMARY KEY ("id"))`);

    await queryRunner.query(`
      CREATE TABLE "${s}"."sale" (
        ${base},
        "sale_number" character varying(30),
        "shift_id" uuid NOT NULL,
        "cashier_user_id" uuid NOT NULL,
        "cashier_name" character varying(150),
        "source_type" character varying(30) NOT NULL,
        "source_id" uuid,
        "patient_id" uuid,
        "customer_name" character varying(100),
        "status" character varying(30) NOT NULL,
        "idempotency_key" uuid NOT NULL,
        "request_hash" character(64) NOT NULL,
        "subtotal" numeric(14,2) NOT NULL,
        "discount_total" numeric(14,2) NOT NULL DEFAULT '0',
        "tax_rate" numeric(5,2) NOT NULL,
        "tax_total" numeric(14,2) NOT NULL,
        "grand_total" numeric(14,2) NOT NULL,
        "paid_total" numeric(14,2) NOT NULL DEFAULT '0',
        "tendered_amount" numeric(14,2) NOT NULL,
        "request_items" jsonb NOT NULL,
        "change_amount" numeric(14,2) NOT NULL DEFAULT '0',
        "dispensing_id" uuid,
        "dispensing_number" character varying(50),
        "paid_at" TIMESTAMP WITH TIME ZONE,
        "failure_code" character varying(40),
        "failure_message" text,
        "failure_errors" jsonb,
        "voided_at" TIMESTAMP WITH TIME ZONE,
        "voided_by" uuid,
        "void_reason" text,
        CONSTRAINT "PK_d03891c457cbcd22974732b5de2" PRIMARY KEY ("id"))`);

    await queryRunner.query(`
      CREATE TABLE "${s}"."sale_item" (
        ${base},
        "sale_id" uuid NOT NULL,
        "line_no" integer NOT NULL,
        "line_type" character varying(20) NOT NULL,
        "item_id" uuid,
        "item_code" character varying(50) NOT NULL,
        "item_name" character varying(255) NOT NULL,
        "unit_id" uuid,
        "unit_code" character varying(20),
        "unit_name" character varying(100),
        "drug_group_code" character varying(50),
        "quantity" numeric(18,4) NOT NULL,
        "unit_price" numeric(14,2) NOT NULL,
        "discount_amount" numeric(14,2) NOT NULL DEFAULT '0',
        "tax_amount" numeric(14,2) NOT NULL,
        "line_total" numeric(14,2) NOT NULL,
        CONSTRAINT "PK_439a57a4a0d130329d3d2e671b6" PRIMARY KEY ("id"))`);

    await queryRunner.query(`
      CREATE TABLE "${s}"."payment" (
        ${base},
        "sale_id" uuid NOT NULL,
        "shift_id" uuid NOT NULL,
        "payment_method_id" uuid NOT NULL,
        "method_code" character varying(30) NOT NULL,
        "amount" numeric(14,2) NOT NULL,
        "tendered_amount" numeric(14,2),
        "change_amount" numeric(14,2),
        "reference_no" character varying(100),
        "status" character varying(20) NOT NULL,
        CONSTRAINT "PK_fcaec7df5adf9cac408c686b2ab" PRIMARY KEY ("id"))`);

    for (const [table, tenantIdx, branchIdx] of baseIndexes) {
      await queryRunner.query(
        `CREATE INDEX "${tenantIdx}" ON "${s}"."${table}" ("tenant_id")`,
      );
      await queryRunner.query(
        `CREATE INDEX "${branchIdx}" ON "${s}"."${table}" ("branch_id")`,
      );
    }

    // billing_setting / payment_method
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_billing_setting_branch" ON "${s}"."billing_setting" ("tenant_id", "branch_id") WHERE "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_payment_method_code" ON "${s}"."payment_method" ("tenant_id", "branch_id", "code") WHERE "deleted_at" IS NULL`,
    );

    // cashier_shift
    await queryRunner.query(
      `CREATE INDEX "idx_cashier_shift_opened_at" ON "${s}"."cashier_shift" ("tenant_id", "branch_id", "opened_at")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_cashier_shift_number" ON "${s}"."cashier_shift" ("tenant_id", "branch_id", "shift_number") WHERE "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_cashier_shift_open" ON "${s}"."cashier_shift" ("tenant_id", "branch_id", "cashier_user_id") WHERE "status" = 'OPEN' AND "deleted_at" IS NULL`,
    );

    // sale
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_sale_number" ON "${s}"."sale" ("tenant_id", "branch_id", "sale_number") WHERE "sale_number" IS NOT NULL AND "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_sale_idempotency" ON "${s}"."sale" ("tenant_id", "idempotency_key") WHERE "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_sale_shift_status" ON "${s}"."sale" ("shift_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_sale_cashier_created" ON "${s}"."sale" ("tenant_id", "branch_id", "cashier_user_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_sale_created" ON "${s}"."sale" ("tenant_id", "branch_id", "created_at")`,
    );

    // sale_item / payment
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_sale_item_line" ON "${s}"."sale_item" ("sale_id", "line_no") WHERE "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_payment_shift_status" ON "${s}"."payment" ("shift_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_payment_sale" ON "${s}"."payment" ("sale_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_payment_method" ON "${s}"."payment" ("payment_method_id")`,
    );

    // Foreign keys
    await queryRunner.query(
      `ALTER TABLE "${s}"."sale" ADD CONSTRAINT "fk_sale_shift" FOREIGN KEY ("shift_id") REFERENCES "${s}"."cashier_shift"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "${s}"."sale_item" ADD CONSTRAINT "fk_sale_item_sale" FOREIGN KEY ("sale_id") REFERENCES "${s}"."sale"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "${s}"."payment" ADD CONSTRAINT "fk_payment_sale" FOREIGN KEY ("sale_id") REFERENCES "${s}"."sale"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "${s}"."payment" ADD CONSTRAINT "fk_payment_shift" FOREIGN KEY ("shift_id") REFERENCES "${s}"."cashier_shift"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "${s}"."payment" ADD CONSTRAINT "fk_payment_method" FOREIGN KEY ("payment_method_id") REFERENCES "${s}"."payment_method"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const s = schemaOf(queryRunner);
    // Urutan: tabel pemegang FK dulu. Index ikut terhapus bersama tabelnya.
    for (const table of [
      'payment',
      'sale_item',
      'sale',
      'payment_method',
      'cashier_shift',
      'billing_setting',
      'document_number_sequence',
    ]) {
      await queryRunner.query(`DROP TABLE "${s}"."${table}"`);
    }
  }
}

/** Nama schema dari DataSource (DB_SCHEMA); migration tidak boleh menebak. */
function schemaOf(queryRunner: QueryRunner): string {
  const schema = (queryRunner.connection.options as PostgresConnectionOptions)
    .schema;
  if (!schema) throw new Error('DataSource schema (DB_SCHEMA) is not set');
  return schema;
}
