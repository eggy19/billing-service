import { Module } from '@nestjs/common';
import { DocumentNumberModule } from '../../common/document-number/document-number.module';
import { PaymentMethodModule } from '../payment-method/payment-method.module';
import { SettingModule } from '../setting/setting.module';
import { ShiftModule } from '../shift/shift.module';
import { INVENTORY_DISPENSING_CLIENT } from './inventory/inventory-dispensing.port';
import { InventoryHttpClient } from './inventory/inventory-http.client';
import { SaleController } from './sale.controller';
import { SaleQueryService } from './sale-query.service';
import { SaleService } from './sale.service';

/**
 * Modul penjualan (BL-16). Hanya bergantung pada token SHIFT_GUARD dari ShiftModule
 * (BR-MD-07) dan pada client Inventory di balik port INVENTORY_DISPENSING_CLIENT.
 */
@Module({
  imports: [
    DocumentNumberModule,
    SettingModule,
    PaymentMethodModule,
    ShiftModule,
  ],
  controllers: [SaleController],
  providers: [
    SaleService,
    SaleQueryService,
    InventoryHttpClient,
    { provide: INVENTORY_DISPENSING_CLIENT, useExisting: InventoryHttpClient },
  ],
})
export class SaleModule {}
