import type { BillingSetting } from '../setting/entities/billing-setting.entity';
import type { Payment } from './entities/payment.entity';
import type { SaleItem } from './entities/sale-item.entity';
import type { Sale } from './entities/sale.entity';
import type { PaymentMethod } from '../payment-method/entities/payment-method.entity';
import type { CashierShift } from '../shift/entities/cashier-shift.entity';

/**
 * Bentuk `SaleSummary` / `Sale` (spec §7.5). Key snake_case di sini; key camelCase
 * dibuat ResponseInterceptor. `failure_errors` sengaja tidak dikirim (hanya untuk replay).
 * `dispensing_number` hanya pelacakan supervisor, tidak dicetak (BR-RC-09).
 */
export interface SaleSummaryView {
  id: string;
  sale_number: string | null;
  status: string;
  source_type: string;
  shift_id: string;
  shift_number: string | null;
  cashier_user_id: string;
  cashier_name: string | null;
  customer_name: string | null;
  created_at: Date;
  paid_at: Date | null;
  subtotal: number;
  discount_total: number;
  tax_rate: number;
  tax_total: number;
  grand_total: number;
  paid_total: number;
  tendered_amount: number;
  change_amount: number;
  dispensing_number: string | null;
  failure_code: string | null;
  failure_message: string | null;
}

export interface SaleItemView {
  line_no: number;
  item_code: string;
  item_name: string;
  unit_code: string | null;
  unit_name: string | null;
  quantity: number;
  unit_price: number;
  discount_amount: number;
  tax_amount: number;
  line_total: number;
  drug_group_code: string | null;
}

export interface SalePaymentView {
  method_code: string;
  method_name: string | null;
  amount: number;
  tendered_amount: number | null;
  change_amount: number | null;
}

export interface SaleView extends SaleSummaryView {
  items: SaleItemView[];
  payments: SalePaymentView[];
  receipt: { header: string | null; footer: string | null };
}

export type SaleWithShift = Sale & {
  shift?: Pick<CashierShift, 'shift_number'> | null;
};
export type PaymentWithMethod = Payment & {
  payment_method?: Pick<PaymentMethod, 'name'> | null;
};

export function toSaleSummary(sale: SaleWithShift): SaleSummaryView {
  return {
    id: sale.id,
    sale_number: sale.sale_number,
    status: sale.status,
    source_type: sale.source_type,
    shift_id: sale.shift_id,
    shift_number: sale.shift?.shift_number ?? null,
    cashier_user_id: sale.cashier_user_id,
    cashier_name: sale.cashier_name,
    customer_name: sale.customer_name,
    created_at: sale.created_at,
    paid_at: sale.paid_at,
    subtotal: sale.subtotal,
    discount_total: sale.discount_total,
    tax_rate: sale.tax_rate,
    tax_total: sale.tax_total,
    grand_total: sale.grand_total,
    paid_total: sale.paid_total,
    tendered_amount: sale.tendered_amount,
    change_amount: sale.change_amount,
    dispensing_number: sale.dispensing_number,
    failure_code: sale.failure_code,
    failure_message: sale.failure_message,
  };
}

export function toSaleView(
  sale: SaleWithShift,
  items: SaleItem[],
  payments: PaymentWithMethod[],
  setting: Pick<BillingSetting, 'receipt_header' | 'receipt_footer'>,
): SaleView {
  return {
    ...toSaleSummary(sale),
    items: items.map((i) => ({
      line_no: i.line_no,
      item_code: i.item_code,
      item_name: i.item_name,
      unit_code: i.unit_code,
      unit_name: i.unit_name,
      quantity: i.quantity,
      unit_price: i.unit_price,
      discount_amount: i.discount_amount,
      tax_amount: i.tax_amount,
      line_total: i.line_total,
      drug_group_code: i.drug_group_code,
    })),
    payments: payments.map((p) => ({
      method_code: p.method_code,
      method_name: p.payment_method?.name ?? null,
      amount: p.amount,
      tendered_amount: p.tendered_amount,
      change_amount: p.change_amount,
    })),
    receipt: {
      header: setting.receipt_header,
      footer: setting.receipt_footer,
    },
  };
}
