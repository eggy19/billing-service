import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

/** Batas kolom numeric(14,2). */
const MAX_MONEY = 999_999_999_999.99;
const MONEY = { maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false };
/** Batas kuantitas per baris (bilangan bulat, KB-10); total tetap dicek terhadap numeric(14,2). */
const MAX_QUANTITY = 1_000_000;

/** Baris keranjang (BR-SL-03). `expected_unit_price` = harga yang dilihat kasir. */
export class SaleItemDto {
  @ApiProperty()
  @IsUUID()
  item_id: string;

  @ApiProperty()
  @IsUUID()
  unit_id: string;

  @ApiProperty({ example: 2, minimum: 1 })
  @IsInt()
  @Min(1)
  @Max(MAX_QUANTITY)
  quantity: number;

  @ApiProperty({ example: 5500, minimum: 0 })
  @IsNumber(MONEY)
  @Min(0)
  @Max(MAX_MONEY)
  expected_unit_price: number;
}

/** Pembayaran. Hanya satu elemen `CASH` yang valid di MVP; sisanya BIL_007 di service. */
export class SalePaymentDto {
  @ApiProperty({ example: 'CASH' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  method_code: string;

  @ApiProperty({ example: 50000, minimum: 0 })
  @IsNumber(MONEY)
  @Min(0)
  @Max(MAX_MONEY)
  tendered_amount: number;
}

/** Body `POST /billing/sales` (spec §7.5). Tanpa shift/kasir/cabang di body. */
export class CreateSaleDto {
  @ApiPropertyOptional({ maxLength: 100, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  customer_name?: string | null;

  @ApiProperty({ type: [SaleItemDto], minItems: 1, maxItems: 100 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => SaleItemDto)
  items: SaleItemDto[];

  @ApiProperty({ type: [SalePaymentDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SalePaymentDto)
  payments: SalePaymentDto[];
}

export const SALE_LIST_STATUSES = [
  'PENDING',
  'PAID',
  'FAILED',
  'NEEDS_RECONCILIATION',
] as const;

/** Query `GET /billing/sales` (spec §7.5). Tanggal = tanggal WIB inklusif. */
export class ListSaleQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: '2026-11-13' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsISO8601({ strict: true })
  date_from?: string;

  @ApiPropertyOptional({ example: '2026-11-13' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsISO8601({ strict: true })
  date_to?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cashier_user_id?: string;

  @ApiPropertyOptional({ enum: SALE_LIST_STATUSES })
  @IsOptional()
  @IsIn(SALE_LIST_STATUSES)
  status?: (typeof SALE_LIST_STATUSES)[number];

  @ApiPropertyOptional({ description: 'Cari nomor penjualan (sebagian)' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  q?: string;
}
