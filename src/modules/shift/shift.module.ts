import { Module } from '@nestjs/common';
import { DocumentNumberModule } from '../../common/document-number/document-number.module';
import { SHIFT_GUARD } from './shift-guard.port';
import { ShiftGuardService } from './shift-guard.service';
import { ShiftController } from './shift.controller';
import { ShiftService } from './shift.service';

/**
 * Modul shift (BL-13). Hanya token SHIFT_GUARD yang diekspor: modul `sale`
 * tidak boleh bergantung pada ShiftService (BR-MD-07). Modul ini tidak meng-import
 * apa pun dari modul sale selain entity.
 */
@Module({
  imports: [DocumentNumberModule],
  controllers: [ShiftController],
  providers: [
    ShiftService,
    ShiftGuardService,
    { provide: SHIFT_GUARD, useExisting: ShiftGuardService },
  ],
  exports: [SHIFT_GUARD],
})
export class ShiftModule {}
