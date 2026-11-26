// Billing: cart maths, checks before saving, and the SQL that saves a bill.
// Pure functions; tested against real SQLite in ops.test.ts.

import { Batch } from "../../db/batch";
import type { Schedule } from "../../db/types";
import { computeSaleLine, roundOffBill, splitCgstSgst, type Paise } from "../money";
import { billPrefix } from "./fy";

export type PaymentMode = "CASH" | "UPI" | "CARD" | "CREDIT";
export const PAYMENT_MODES: PaymentMode[] = ["CASH", "UPI", "CARD", "CREDIT"];

/** Schedules whose sale must be written in the register with doctor and patient details. */
export const REGISTER_SCHEDULES: ReadonlySet<Schedule> = new Set<Schedule>(["H1", "X", "NDPS"]);

export interface CartLine {
  key: string;
  itemId: number;
  name: string;
  packSize: number;
  unit: string;
  schedule: Schedule;
  gstBp: number;
  hsn: string | null;
  batchId: number;
  batchNo: string;
  expiry: string;
  mrpPaise: Paise;
  /** Per pack, GST inclusive, never above MRP. */
  ratePaise: Paise;
  qtyUnits: number;
  discountBp: number;
  /** Saleable stock of this batch when it was picked. */
  stockUnits: number;
}

export interface CartLineAmounts {
  gross: Paise;
  discount: Paise;
  amount: Paise;
  taxable: Paise;
  gst: Paise;
}

export interface CartTotals {
  lines: CartLineAmounts[];
  gross: Paise;
  discount: Paise;
  taxable: Paise;
  gst: Paise;
  total: Paise;
  roundOff: Paise;
  payable: Paise;
  /** For the printed bill and GST reports: taxable and tax per rate. */
  byRate: { gstBp: number; taxable: Paise; cgst: Paise; sgst: Paise }[];
}

export function lineAmounts(l: CartLine): CartLineAmounts {
  if (l.qtyUnits <= 0) return { gross: 0, discount: 0, amount: 0, taxable: 0, gst: 0 };
  return computeSaleLine({ qtyUnits: l.qtyUnits, packSize: l.packSize, ratePerPack: l.ratePaise, discount: l.discountBp, gstRate: l.gstBp });
}

export function cartTotals(lines: CartLine[]): CartTotals {
  const amounts = lines.map(lineAmounts);
  const sum = (k: keyof CartLineAmounts) => amounts.reduce((s, a) => s + a[k], 0);
  const total = sum("amount");
  const { roundOff, payable } = roundOffBill(total);
  const rates = new Map<number, { taxable: Paise; gst: Paise }>();
  lines.forEach((l, i) => {
    const r = rates.get(l.gstBp) ?? { taxable: 0, gst: 0 };
    r.taxable += amounts[i].taxable;
    r.gst += amounts[i].gst;
    rates.set(l.gstBp, r);
  });
  const byRate = [...rates.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([gstBp, r]) => ({ gstBp, taxable: r.taxable, ...splitCgstSgst(r.gst) }));
  return { lines: amounts, gross: sum("gross"), discount: sum("discount"), taxable: sum("taxable"), gst: sum("gst"), total, roundOff, payable, byRate };
}

export interface RxDetails {
  prescriberName: string;
  prescriberAddress: string;
  patientName: string;
  patientAddress: string;
  rxNo: string;
}

export interface SaleInput {
  lines: CartLine[];
  billDate: string;
  billTime: string;
  billPrefix: string;
  paymentMode: PaymentMode;
  customerId: number | null;
  customerName: string;
  customerPhone: string;
  doctorName: string;
  rx: RxDetails;
  today: string;
}

export type SaleProblem =
  | { code: "EMPTY" }
  | { code: "QTY_ZERO"; key: string }
  | { code: "OVER_STOCK"; key: string }
  | { code: "EXPIRED_BATCH"; key: string }
  | { code: "RATE_ABOVE_MRP"; key: string }
  | { code: "RX_MISSING" }
  | { code: "CREDIT_NEEDS_CUSTOMER" };

export function needsRegister(lines: CartLine[]): boolean {
  return lines.some((l) => REGISTER_SCHEDULES.has(l.schedule));
}

export function checkSale(s: SaleInput): SaleProblem[] {
  const p: SaleProblem[] = [];
  if (s.lines.length === 0) p.push({ code: "EMPTY" });
  const perBatch = new Map<number, number>();
  for (const l of s.lines) {
    if (l.qtyUnits <= 0) p.push({ code: "QTY_ZERO", key: l.key });
    perBatch.set(l.batchId, (perBatch.get(l.batchId) ?? 0) + l.qtyUnits);
    if (l.expiry < s.today) p.push({ code: "EXPIRED_BATCH", key: l.key });
    if (l.ratePaise > l.mrpPaise) p.push({ code: "RATE_ABOVE_MRP", key: l.key });
  }
  for (const l of s.lines) {
    if ((perBatch.get(l.batchId) ?? 0) > l.stockUnits) p.push({ code: "OVER_STOCK", key: l.key });
  }
  if (needsRegister(s.lines)) {
    const r = s.rx;
    if (![r.prescriberName, r.prescriberAddress, r.patientName, r.patientAddress].every((x) => x.trim())) p.push({ code: "RX_MISSING" });
  }
  if (s.paymentMode === "CREDIT" && !s.customerId) p.push({ code: "CREDIT_NEEDS_CUSTOMER" });
  return p;
}

const nul = (x: string) => (x.trim() ? x.trim() : null);

export const SALE_SQL = {
  // The running number is worked out inside the same transaction, so two bills can never share a number.
  sale: `INSERT INTO sales (bill_no, bill_date, bill_time, customer_id, customer_name, customer_phone, doctor_name,
           payment_mode, taxable_paise, gst_paise, discount_paise, round_off_paise, total_paise, user_id)
         VALUES ($1 || printf('%06d', (SELECT COALESCE(MAX(CAST(substr(bill_no, length($1) + 1) AS INTEGER)), 0) + 1
                                       FROM sales WHERE substr(bill_no, 1, length($1)) = $1)),
                 $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1)`,
  line: `INSERT INTO sale_lines (sale_id, batch_id, qty_units, mrp_paise, rate_paise, discount_bp, gst_rate_bp,
           taxable_paise, gst_paise, amount_paise)
         VALUES ((SELECT MAX(id) FROM sales), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
  move: `INSERT INTO stock_moves (batch_id, qty_units, reason, ref_id, user_id) VALUES ($1, $2, 'SALE', last_insert_rowid(), 1)`,
  register: `INSERT INTO schedule_register (sale_line_id, schedule, entry_date, prescriber_name, prescriber_address,
               patient_name, patient_address, rx_no)
             VALUES ((SELECT MAX(id) FROM sale_lines), $1, $2, $3, $4, $5, $6, $7)`,
  credit: `INSERT INTO ledger_entries (entry_date, party_type, party_id, debit_paise, ref_type, ref_id, narration)
           VALUES ($1, 'CUSTOMER', $2, $3, 'SALE', (SELECT MAX(id) FROM sales), 'Credit bill')`,
};

/** Saves the bill, its lines, the stock going out, the register entries and any credit. Step 0 inserts the sale. */
export function planSale(s: SaleInput): Batch {
  const t = cartTotals(s.lines);
  const b = new Batch();
  b.add(SALE_SQL.sale, [
    billPrefix(s.billPrefix, s.billDate),
    s.billDate,
    s.billTime,
    s.customerId,
    nul(s.customerName),
    nul(s.customerPhone),
    nul(s.doctorName),
    s.paymentMode,
    t.taxable,
    t.gst,
    t.discount,
    t.roundOff,
    t.payable,
  ]);
  s.lines.forEach((l, i) => {
    const a = t.lines[i];
    b.add(SALE_SQL.line, [l.batchId, l.qtyUnits, l.mrpPaise, l.ratePaise, l.discountBp, l.gstBp, a.taxable, a.gst, a.amount]);
    b.add(SALE_SQL.move, [l.batchId, -l.qtyUnits]);
    if (REGISTER_SCHEDULES.has(l.schedule)) {
      const r = s.rx;
      b.add(SALE_SQL.register, [l.schedule, s.billDate, r.prescriberName.trim(), r.prescriberAddress.trim(), r.patientName.trim(), r.patientAddress.trim(), nul(r.rxNo)]);
    }
  });
  if (s.paymentMode === "CREDIT" && s.customerId) b.add(SALE_SQL.credit, [s.billDate, s.customerId, t.payable]);
  return b;
}

// ---------- Cancel and return ----------

/** Cancel a whole bill: stock goes back, credit is reversed. Only for bills with no returns. */
export function planCancelSale(p: { saleId: number; reason: string; today: string; creditCustomerId: number | null; totalPaise: Paise }): Batch {
  const b = new Batch();
  b.add(
    `UPDATE sales SET status = 'CANCELLED', cancel_reason = $2, cancelled_at = datetime('now','localtime')
     WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM returns WHERE ref_sale_id = $1)`,
    [p.saleId, p.reason.trim() || null],
  );
  // If the UPDATE did nothing (returns exist), this inserts nothing either.
  b.add(
    `INSERT INTO stock_moves (batch_id, qty_units, reason, ref_id, note, user_id)
     SELECT sl.batch_id, sl.qty_units, 'SALE_CANCEL', sl.id, 'Bill cancelled', 1
     FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
     WHERE sl.sale_id = $1 AND s.status = 'CANCELLED' AND s.cancelled_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM stock_moves m WHERE m.reason = 'SALE_CANCEL' AND m.ref_id = sl.id)`,
    [p.saleId],
  );
  if (p.creditCustomerId)
    b.add(
      `INSERT INTO ledger_entries (entry_date, party_type, party_id, credit_paise, ref_type, ref_id, narration)
       SELECT $1, 'CUSTOMER', $2, $3, 'SALE_CANCEL', $4, 'Bill cancelled' WHERE (SELECT status FROM sales WHERE id = $4) = 'CANCELLED'`,
      [p.today, p.creditCustomerId, p.totalPaise, p.saleId],
    );
  b.add(
    `INSERT INTO audit_log (user_id, action, entity, entity_id, new_value) VALUES (1, 'SALE_CANCEL', 'sales', $1, $2)`,
    [p.saleId, JSON.stringify({ reason: p.reason })],
  );
  return b;
}

export interface ReturnLine {
  batchId: number;
  qtyUnits: number;
  /** Refund for this many units (pro-rata from the sold line, after its discount). */
  amountPaise: Paise;
  ratePaise: Paise;
}

/** Customer brings medicines back. The database refuses to take back more than was sold. */
export function planSaleReturn(p: {
  saleId: number;
  customerId: number | null;
  lines: ReturnLine[];
  refundMode: PaymentMode;
  note: string;
  today: string;
}): Batch {
  const total = p.lines.reduce((s, l) => s + l.amountPaise, 0);
  const b = new Batch();
  b.add(
    `INSERT INTO returns (type, ref_sale_id, party_id, return_date, total_paise, refund_mode, note, user_id)
     VALUES ('SALE_RETURN', $1, $2, $3, $4, $5, $6, 1)`,
    [p.saleId, p.customerId, p.today, total, p.refundMode, p.note.trim() || null],
  );
  for (const l of p.lines) {
    if (l.qtyUnits <= 0) continue;
    b.add(`INSERT INTO return_lines (return_id, batch_id, qty_units, rate_paise, amount_paise) VALUES ((SELECT MAX(id) FROM returns), $1, $2, $3, $4)`, [
      l.batchId,
      l.qtyUnits,
      l.ratePaise,
      l.amountPaise,
    ]);
    b.add(`INSERT INTO stock_moves (batch_id, qty_units, reason, ref_id, user_id) VALUES ($1, $2, 'SALE_RETURN', last_insert_rowid(), 1)`, [l.batchId, l.qtyUnits]);
  }
  if (p.refundMode === "CREDIT" && p.customerId)
    b.add(
      `INSERT INTO ledger_entries (entry_date, party_type, party_id, credit_paise, ref_type, ref_id, narration)
       VALUES ($1, 'CUSTOMER', $2, $3, 'SALE_RETURN', (SELECT MAX(id) FROM returns), 'Return adjusted in account')`,
      [p.today, p.customerId, total],
    );
  return b;
}

/** Refund for returning part of a sold line, pro-rata to what the customer actually paid. */
export function refundFor(soldQtyUnits: number, soldAmountPaise: Paise, returnQtyUnits: number): Paise {
  if (soldQtyUnits <= 0) return 0;
  return Math.round((soldAmountPaise * returnQtyUnits) / soldQtyUnits);
}
