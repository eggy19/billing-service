import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequestContextData } from '../../common/context/request-context';
import { CurrentContext } from '../../common/decorators/current-context.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { BillingSettingService } from '../setting/billing-setting.service';
import { PaymentMethodService } from './payment-method.service';

/** `GET /billing/payment-methods` (spec §7.5). Scope tenant + cabang dari JWT. */
@ApiTags('Payment Methods')
@Controller('payment-methods')
export class PaymentMethodController {
  constructor(
    private readonly methods: PaymentMethodService,
    private readonly settings: BillingSettingService,
  ) {}

  @Get()
  @RequirePermission('billing.sale.create')
  @ResponseMessage('Metode pembayaran berhasil diambil')
  @ApiOperation({ summary: 'Metode pembayaran aktif cabang' })
  async list(@CurrentContext() ctx: RequestContextData) {
    // Cabang yang pertama kali mengakses otomatis punya setting + CASH (BR-BL-05).
    await this.settings.getOrCreate(ctx.tenantId, ctx.branchId);
    const rows = await this.methods.listActive(ctx.tenantId, ctx.branchId);
    return rows.map((m) => ({
      id: m.id,
      code: m.code,
      name: m.name,
      is_cash: m.is_cash,
    }));
  }
}
