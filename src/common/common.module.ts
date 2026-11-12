import { Global, Module } from '@nestjs/common';
import { GatewayAuthService } from './gateway-auth/gateway-auth.service';
import { GatewayJwtGuard } from './gateway-auth/gateway-jwt.guard';

/** Cross-cutting providers shared by all domain modules. */
@Global()
@Module({
  providers: [GatewayAuthService, GatewayJwtGuard],
  exports: [GatewayAuthService, GatewayJwtGuard],
})
export class CommonModule {}
