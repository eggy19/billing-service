import type { Repository } from 'typeorm';
import { BillingSettingService } from './billing-setting.service';
import { BillingSetting } from './entities/billing-setting.entity';

function make(findResults: Array<Partial<BillingSetting> | null>) {
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
  } as unknown as Repository<BillingSetting>;
  return { service: new BillingSettingService(repo), findOne, qb };
}

describe('BillingSettingService.getOrCreate', () => {
  it('returns the existing row without inserting, scoped by tenant+branch', async () => {
    const row = { id: 's1', tax_rate: 11 };
    const { service, findOne, qb } = make([row]);
    await expect(service.getOrCreate('t1', 'b1')).resolves.toBe(row);
    expect(findOne).toHaveBeenCalledWith({
      where: { tenant_id: 't1', branch_id: 'b1' },
    });
    expect(qb.insert).not.toHaveBeenCalled();
  });

  it('lazy-creates tax_rate 0 with ON CONFLICT DO NOTHING (orIgnore), then re-reads', async () => {
    const created = { id: 's2', tax_rate: 0 };
    const { service, qb, findOne } = make([null, created]);
    await expect(service.getOrCreate('t1', 'b1')).resolves.toBe(created);
    expect(qb.values).toHaveBeenCalledWith({
      tenant_id: 't1',
      branch_id: 'b1',
      tax_rate: 0,
    });
    expect(qb.orIgnore).toHaveBeenCalled();
    expect(findOne).toHaveBeenCalledTimes(2);
  });

  it('parallel loser: insert ignored, re-read returns the winner row (no error)', async () => {
    const winner = { id: 's3', tax_rate: 0 };
    const { service } = make([null, winner]);
    await expect(service.getOrCreate('t1', 'b1')).resolves.toBe(winner);
  });
});
