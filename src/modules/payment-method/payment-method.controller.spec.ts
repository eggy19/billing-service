import type { Repository } from 'typeorm';
import type { RequestContextData } from '../../common/context/request-context';
import type { BillingSettingService } from '../setting/billing-setting.service';
import { PaymentMethod } from './entities/payment-method.entity';
import { PaymentMethodController } from './payment-method.controller';
import { PaymentMethodService } from './payment-method.service';

const ctx = {
  tenantId: 't-A',
  branchId: 'b-P',
  userId: 'u-rina',
  permissions: ['billing.sale.create'],
} as RequestContextData;

function make(rows: Array<Partial<PaymentMethod>>, existing: unknown = null) {
  const findOne = jest.fn().mockResolvedValue(existing);
  const find = jest.fn().mockResolvedValue(rows);
  const qb = {
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orIgnore: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue(undefined),
  };
  const repo = {
    findOne,
    find,
    createQueryBuilder: jest.fn().mockReturnValue(qb),
  } as unknown as Repository<PaymentMethod>;
  const service = new PaymentMethodService(repo);
  const settings = {
    getOrCreate: jest.fn().mockResolvedValue({ tax_rate: 0 }),
  };
  const controller = new PaymentMethodController(
    service,
    settings as unknown as BillingSettingService,
  );
  return { controller, find, findOne, qb, settings };
}

describe('GET /billing/payment-methods (AC-SL-20, AC-BL-04)', () => {
  it('mengembalikan metode aktif cabang dari JWT: id, code, name, is_cash saja', async () => {
    const t = make(
      [
        {
          id: 'pm-1',
          code: 'CASH',
          name: 'Tunai',
          is_cash: true,
          requires_reference: false,
          is_active: true,
          tenant_id: 't-A',
        },
      ],
      { code: 'CASH', is_active: true },
    );
    await expect(t.controller.list(ctx)).resolves.toEqual([
      { id: 'pm-1', code: 'CASH', name: 'Tunai', is_cash: true },
    ]);
    expect(t.find).toHaveBeenCalledWith({
      where: { tenant_id: 't-A', branch_id: 'b-P', is_active: true },
      order: { code: 'ASC' },
    });
  });

  it('cabang baru: billing_setting dan CASH dibuat lazy (BR-BL-05) sebelum daftar dibaca', async () => {
    const t = make([
      { id: 'pm-1', code: 'CASH', name: 'Tunai', is_cash: true },
    ]);
    await t.controller.list(ctx);
    expect(t.settings.getOrCreate).toHaveBeenCalledWith('t-A', 'b-P');
    expect(t.qb.values).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 't-A',
        branch_id: 'b-P',
        code: 'CASH',
        is_cash: true,
      }),
    );
    expect(t.qb.orIgnore).toHaveBeenCalled();
  });

  it('CASH nonaktif -> data [] dan tidak dibuat ulang', async () => {
    const t = make([], { code: 'CASH', is_active: false });
    await expect(t.controller.list(ctx)).resolves.toEqual([]);
    expect(t.qb.insert).not.toHaveBeenCalled();
  });
});
