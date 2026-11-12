import {
  Injectable,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { importSPKI, jwtVerify } from 'jose';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface GatewayContext {
  sub: string;
  tenantId: string;
  branchId: string;
  sessionId: string;
  requestId: string;
  roles: string[];
  permissions: string[];
  name?: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Claim lama (tanpa roles/permissions) atau bentuk salah -> []. */
function toStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
    ? value
    : [];
}

@Injectable()
export class GatewayAuthService implements OnModuleInit {
  private publicKey!: CryptoKey;
  private issuer!: string;
  private audience!: string;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const keyPath =
      this.config.get<string>('jwt.publicKeyPath') ?? 'certs/public.pem';
    const pem = readFileSync(resolve(process.cwd(), keyPath), 'utf-8');
    this.publicKey = await importSPKI(pem, 'EdDSA');
    this.issuer =
      this.config.get<string>('jwt.issuer') ?? 'gateway-identity-service';
    this.audience =
      this.config.get<string>('jwt.audience') ?? 'billing-service';
  }

  async verify(token: string): Promise<GatewayContext> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ['EdDSA'],
        requiredClaims: ['exp', 'sub', 'tenantId', 'branchId', 'requestId'],
      });

      const { sub, tenantId, branchId, requestId } = payload as Record<
        string,
        unknown
      >;
      if (
        !isUuid(sub) ||
        !isUuid(tenantId) ||
        !isUuid(branchId) ||
        typeof requestId !== 'string' ||
        requestId.length === 0
      ) {
        throw new Error('invalid identity claims');
      }

      return {
        sub,
        tenantId,
        branchId,
        sessionId:
          typeof payload['sessionId'] === 'string' ? payload['sessionId'] : '',
        requestId,
        roles: toStringArray(payload['roles']),
        permissions: toStringArray(payload['permissions']),
        ...(typeof payload['name'] === 'string'
          ? { name: payload['name'] }
          : {}),
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired gateway token');
    }
  }
}
