import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PermissionExempt } from './common/decorators/require-permission.decorator';

@ApiTags('Health')
@PermissionExempt()
@Controller()
export class HealthController {
  /** `/health` untuk probe lokal/Docker; `/billing/health` untuk jalur Gateway (spec §7.5). */
  @Get(['health', 'billing/health'])
  @ApiOperation({ summary: 'Liveness probe' })
  health() {
    return { success: true, status: 'ok', timestamp: new Date().toISOString() };
  }
}
