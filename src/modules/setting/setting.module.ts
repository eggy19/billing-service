import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BillingSettingService } from './billing-setting.service';
import { BillingSetting } from './entities/billing-setting.entity';

@Module({
  imports: [TypeOrmModule.forFeature([BillingSetting])],
  providers: [BillingSettingService],
  exports: [BillingSettingService],
})
export class SettingModule {}
