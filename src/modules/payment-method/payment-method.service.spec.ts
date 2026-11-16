import type { Repository } from 'typeorm';
import { PaymentMethod } from './entities/payment-method.entity';
import { PaymentMethodService } from './payment-method.service';

function make(findResults: Array<Partial<PaymentMethod> | null>) {
  const findOne = jest.fn();
  findResults.forEach((r) => findOne.mockResolvedValueOnce(r));
  const qb = {
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orIgnore: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue(undefined),
  };
  const repo = {
    findOne,
    createQueryBuilder: jest.fn().mockReturnValue(qb),
  } as unknown as Repository<PaymentMethod>;
  return { service: new PaymentMethodService(repo), findOne, qb };
}

describe('PaymentMethodService.findActiveByCode', () => {
  it('returns the active method scoped by tenant+branch+code', async () => {
    const row = { id: 'm1', code: 'CASH', is_active: true };
    const { service, findOne, qb } = make([row]);
    await expect(service.findActiveByCode('t1', 'b1', 'CASH')).resolves.toBe(
      row,
    );
    expect(findOne).toHaveBeenCalledWith({
      where: { tenant_id: 't1', branch_id: 'b1', code: 'CASH' },
    });
    expect(qb.insert).not.toHaveBeenCalled();
  });

  it('lazy-creates CASH (Tunai, is_cash) once per branch via orIgnore, then re-reads', async () => {
    const created = { id: 'm2', code: 'CASH', is_active: true };
    const { service, qb } = make([null, created]);
    await expect(service.findActiveByCode('t1', 'b1', 'CASH')).resolves.toBe(
      created,
    );
    expect(qb.values).toHaveBeenCalledWith({
      tenant_id: 't1',
      branch_id: 'b1',
      code: 'CASH',
      name: 'Tunai',
      is_cash: true,
      requires_reference: false,
      is_active: true,
    });
    expect(qb.orIgnore).toHaveBeenCalled();
  });

  it('does not recreate a CASH method that exists but is inactive (returns null)', async () => {
    const { service, qb } = make([{ code: 'CASH', is_active: false }]);
    await expect(
      service.findActiveByCode('t1', 'b1', 'CASH'),
    ).resolves.toBeNull();
    expect(qb.insert).not.toHaveBeenCalled();
  });

  it('unknown code is never lazy-created -> null', async () => {
    const { service, qb } = make([null]);
    await expect(
      service.findActiveByCode('t1', 'b1', 'QRIS'),
    ).resolves.toBeNull();
    expect(qb.insert).not.toHaveBeenCalled();
  });
});
