import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { RequestContextData } from '../../common/context/request-context';
import { CurrentContext } from '../../common/decorators/current-context.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { CreateSaleDto, ListSaleQueryDto } from './dto/sale.dto';
import { SaleQueryService } from './sale-query.service';
import { SaleService } from './sale.service';

/**
 * Endpoint penjualan (spec §7.5). Global prefix `billing` ditambahkan di main.ts.
 * Tenant/branch/kasir hanya dari JWT; controller tipis, aturan di service.
 */
@ApiTags('Sales')
@Controller('sales')
export class SaleController {
  constructor(
    private readonly sales: SaleService,
    private readonly queries: SaleQueryService,
  ) {}

  @Post()
  @RequirePermission('billing.sale.create')
  @ResponseMessage('Penjualan berhasil diproses')
  @ApiOperation({
    summary: 'Checkout penjualan OTC tunai (201 baru, 200 replay)',
  })
  @ApiHeader({ name: 'Idempotency-Key', description: 'UUID, wajib (BIL_008)' })
  async create(
    @CurrentContext() ctx: RequestContextData,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateSaleDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { sale, replayed } = await this.sales.checkout(
      ctx,
      idempotencyKey,
      dto,
    );
    res.status(replayed ? 200 : 201);
    return { ...sale, replayed };
  }

  @Get()
  @RequirePermission('billing.sale.read', 'billing.sale.read_all')
  @ResponseMessage('Daftar penjualan berhasil diambil')
  @ApiOperation({ summary: 'Riwayat penjualan (scope BR-SL-12)' })
  list(
    @CurrentContext() ctx: RequestContextData,
    @Query() query: ListSaleQueryDto,
  ) {
    return this.queries.list(ctx, query);
  }

  @Get(':id')
  @RequirePermission('billing.sale.read', 'billing.sale.read_all')
  @ResponseMessage('Detail penjualan berhasil diambil')
  @ApiOperation({ summary: 'Detail penjualan / data struk (scope BR-SL-12)' })
  findOne(
    @CurrentContext() ctx: RequestContextData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.queries.findOne(ctx, id);
  }
}
