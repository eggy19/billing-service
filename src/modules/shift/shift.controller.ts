import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequestContextData } from '../../common/context/request-context';
import { CurrentContext } from '../../common/decorators/current-context.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import {
  CloseShiftDto,
  ListShiftQueryDto,
  OpenShiftDto,
} from './dto/shift.dto';
import { ShiftService } from './shift.service';

/**
 * Endpoint shift (spec §7.5). Global prefix `billing` ditambahkan di main.ts.
 * Tenant/branch/kasir hanya dari JWT (BR-SH-09); controller tipis, aturan di ShiftService.
 * `current` dideklarasikan sebelum `:id`.
 */
@ApiTags('Shifts')
@Controller('shifts')
export class ShiftController {
  constructor(private readonly shifts: ShiftService) {}

  @Get('current')
  @RequirePermission('billing.shift.read', 'billing.shift.read_all')
  @ResponseMessage('Shift aktif berhasil diambil')
  @ApiOperation({ summary: 'Shift OPEN milik user (atau null)' })
  current(@CurrentContext() ctx: RequestContextData) {
    return this.shifts.current(ctx);
  }

  @Post('open')
  @RequirePermission('billing.shift.open')
  @ResponseMessage('Shift berhasil dibuka')
  @ApiOperation({ summary: 'Buka shift' })
  open(@CurrentContext() ctx: RequestContextData, @Body() dto: OpenShiftDto) {
    return this.shifts.open(ctx, dto);
  }

  @Post(':id/close')
  @HttpCode(200)
  @RequirePermission('billing.shift.close')
  @ResponseMessage('Shift berhasil ditutup')
  @ApiOperation({ summary: 'Tutup shift milik sendiri' })
  close(
    @CurrentContext() ctx: RequestContextData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseShiftDto,
  ) {
    return this.shifts.close(ctx, id, dto);
  }

  @Get()
  @RequirePermission('billing.shift.read', 'billing.shift.read_all')
  @ResponseMessage('Daftar shift berhasil diambil')
  @ApiOperation({ summary: 'Daftar shift (scope BR-SH-13)' })
  list(
    @CurrentContext() ctx: RequestContextData,
    @Query() query: ListShiftQueryDto,
  ) {
    return this.shifts.list(ctx, query);
  }

  @Get(':id')
  @RequirePermission('billing.shift.read', 'billing.shift.read_all')
  @ResponseMessage('Detail shift berhasil diambil')
  @ApiOperation({ summary: 'Detail shift (scope BR-SH-13)' })
  findOne(
    @CurrentContext() ctx: RequestContextData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.shifts.findOne(ctx, id);
  }
}
