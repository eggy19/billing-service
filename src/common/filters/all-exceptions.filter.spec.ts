import { ArgumentsHost, BadRequestException } from '@nestjs/common';
import { of } from 'rxjs';
import { BusinessException } from '../exceptions/business.exception';
import { ResponseInterceptor } from '../interceptors/response.interceptor';
import { Reflector } from '@nestjs/core';
import { AllExceptionsFilter } from './all-exceptions.filter';

function run(exception: unknown): {
  status: number;
  body: Record<string, unknown>;
} {
  const logger = { error: jest.fn() };
  const out = { status: 0, body: {} as Record<string, unknown> };
  const response = {
    status: (s: number) => {
      out.status = s;
      return { json: (b: Record<string, unknown>) => (out.body = b) };
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter(logger as never).catch(exception, host);
  return out;
}

describe('AllExceptionsFilter (BR-BL-03)', () => {
  it('BusinessException BIL_010 -> 409 envelope with code and message', () => {
    const { status, body } = run(new BusinessException('BIL_010'));
    expect(status).toBe(409);
    expect(body).toMatchObject({
      success: false,
      code: 'BIL_010',
      message: 'Transaksi sedang diproses, coba lagi sebentar',
    });
    expect(typeof body.timestamp).toBe('string');
  });

  it('class-validator failure -> 400 VALIDATION_ERROR with errors[]', () => {
    const { status, body } = run(
      new BadRequestException({
        message: ['opening_cash must not be less than 0'],
      }),
    );
    expect(status).toBe(400);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.errors).toEqual([
      {
        field: 'opening_cash',
        message: 'opening_cash must not be less than 0',
      },
    ]);
  });

  it('unknown error -> 500 INTERNAL_SERVER_ERROR without leaking the message', () => {
    const { status, body } = run(new Error('db password leaked'));
    expect(status).toBe(500);
    expect(body.code).toBe('INTERNAL_SERVER_ERROR');
    expect(JSON.stringify(body)).not.toContain('leaked');
  });
});

describe('ResponseInterceptor (BR-BL-03)', () => {
  const interceptor = new ResponseInterceptor(new Reflector());
  const ctx = { getHandler: () => () => undefined } as never;

  it('wraps success and converts keys to camelCase', async () => {
    const result = await new Promise<Record<string, unknown>>((resolve) =>
      interceptor
        .intercept(ctx, {
          handle: () => of({ shift_number: 'SHF-1', nested: { opened_at: 1 } }),
        })
        .subscribe((v) => resolve(v as Record<string, unknown>)),
    );
    expect(result).toMatchObject({
      success: true,
      message: 'Success',
      data: { shiftNumber: 'SHF-1', nested: { openedAt: 1 } },
    });
  });
});
