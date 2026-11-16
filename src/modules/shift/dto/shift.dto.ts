import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

/** Batas kolom numeric(14,2). */
const MAX_MONEY = 999_999_999_999.99;
const MONEY = { maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false };

/** Body `POST /billing/shifts/open` (BR-SH-02, BR-SH-14). Tanpa field cabang/kasir (BR-SH-09). */
export class OpenShiftDto {
  @ApiProperty({ example: 200000, minimum: 0 })
  @IsNumber(MONEY)
  @Min(0)
  @Max(MAX_MONEY)
  opening_cash: number;

  @ApiPropertyOptional({ maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  open_note?: string | null;
}

/** Body `POST /billing/shifts/:id/close` (BR-SH-04, BR-SH-05, BR-SH-14). */
export class CloseShiftDto {
  @ApiProperty({ example: 543000, minimum: 0 })
  @IsNumber(MONEY)
  @Min(0)
  @Max(MAX_MONEY)
  closing_cash_counted: number;

  @ApiPropertyOptional({ maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  close_note?: string | null;
}

/** Query `GET /billing/shifts` (spec §7.5). Tanggal = tanggal WIB inklusif. */
export class ListShiftQueryDto extends PaginationQueryDto {
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

  @ApiPropertyOptional({ enum: ['OPEN', 'CLOSED'] })
  @IsOptional()
  @IsIn(['OPEN', 'CLOSED'])
  status?: 'OPEN' | 'CLOSED';
}
