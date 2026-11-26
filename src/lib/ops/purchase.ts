// Purchase entry: a supplier's bill brings stock in, batch by batch.
import { Batch } from "../../db/batch";
import { addExclusive, roundHalf, type Paise } from "../money";

export interface PurchaseLine {
  key: string;
  itemId: number;
  name: string;
  packSize: number;
  gstBp: number;
  batchNo: string;
  expiry: string;
  mrpPaise: Paise;
  /** Supplier rate per pack, before GST (as printed on distributor bills). */
  ratePaise: Paise;
  /** Sale rate per pack, GST inclusive; defaults to MRP. */
  salePaise: Paise;
  qtyUnits: number;
  freeUnits: number;
  discountBp: number;
}

export interface PurchaseLineAmounts {
  gross: Paise;
  discount: Paise;
  taxable: Paise;
  gst: Paise;
  total: Paise;
}

export function purchaseLineAmounts(l: PurchaseLine): PurchaseLineAmounts {
  const gross = roundHalf((l.ratePaise * l.qtyUnits) / Math.max(1, l.packSize));
  const discount = roundHalf((gross * l.discountBp) / 10_000);
  const taxable = gross - discount;
  const { gst, total } = addExclusive(taxable, l.gstBp);
  return { gross, discount, taxable, gst, total };
}

export function purchaseTotals(lines: PurchaseLine[]) {
  const a = lines.map(purchaseLineAmounts);
  const sum = (k: keyof PurchaseLineAmounts) => a.reduce((s, x) => s + x[k], 0);
  return { lines: a, gross: sum("gross"), discount: sum("discount"), taxable: sum("taxable"), gst: sum("gst"), total: sum("total") };
}

export interface PurchaseInput {
  supplierId: number | null;
  supplierBillNo: string;
  billDate: string;
  note: string;
  lines: PurchaseLine[];
  today: string;
}

export type PurchaseProblem =
  | { code: "NO_SUPPLIER" }
  | { code: "NO_BILL_NO" }
  | { code: "EMPTY" }
  | { code: "LINE_INCOMPLETE"; key: string }
  | { code: "SALE_ABOVE_MRP"; key: string }
  | { code: "EXPIRED"; key: string };

export function checkPurchase(p: PurchaseInput): PurchaseProblem[] {
  const out: PurchaseProblem[] = [];
  if (!p.supplierId) out.push({ code: "NO_SUPPLIER" });
  if (!p.supplierBillNo.trim()) out.push({ code: "NO_BILL_NO" });
  if (p.lines.length === 0) out.push({ code: "EMPTY" });
  for (const l of p.lines) {
    if (!l.batchNo.trim() || !l.expiry || l.mrpPaise <= 0 || l.qtyUnits + l.freeUnits <= 0) out.push({ code: "LINE_INCOMPLETE", key: l.key });
    else if (l.salePaise > l.mrpPaise) out.push({ code: "SALE_ABOVE_MRP", key: l.key });
    else if (l.expiry < p.today) out.push({ code: "EXPIRED", key: l.key });
  }
  return out;
}

const BATCH_ID = `(SELECT id FROM batches WHERE item_id = $1 AND batch_no = $2 AND expiry = $3 AND mrp_paise = $4)`;

export function planPurchase(p: PurchaseInput): Batch {
  const t = purchaseTotals(p.lines);
  const b = new Batch();
  b.add(
    `INSERT INTO purchases (supplier_id, supplier_bill_no, bill_date, taxable_paise, gst_paise, total_paise, note, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
    [p.supplierId, p.supplierBillNo.trim(), p.billDate, t.taxable, t.gst, t.total, p.note.trim() || null],
  );
  p.lines.forEach((l, i) => {
    const a = t.lines[i];
    const key = [l.itemId, l.batchNo.trim().toUpperCase(), l.expiry, l.mrpPaise];
    b.add(
      `INSERT OR IGNORE INTO batches (item_id, batch_no, expiry, mrp_paise, purchase_rate_paise, sale_rate_paise) VALUES ($1, $2, $3, $4, $5, $6)`,
      [...key, l.ratePaise, l.salePaise],
    );
    // A batch bought again keeps the latest rates.
    b.add(`UPDATE batches SET purchase_rate_paise = $5, sale_rate_paise = $6 WHERE id = ${BATCH_ID}`, [...key, l.ratePaise, l.salePaise]);
    b.add(
      `INSERT INTO purchase_lines (purchase_id, batch_id, qty_units, free_units, rate_paise, discount_bp, gst_rate_bp, taxable_paise, gst_paise)
       VALUES ((SELECT MAX(id) FROM purchases), ${BATCH_ID}, $5, $6, $7, $8, $9, $10, $11)`,
      [...key, l.qtyUnits, l.freeUnits, l.ratePaise, l.discountBp, l.gstBp, a.taxable, a.gst],
    );
    b.add(
      `INSERT INTO stock_moves (batch_id, qty_units, reason, ref_id, user_id) VALUES (${BATCH_ID}, $5, 'PURCHASE', last_insert_rowid(), 1)`,
      [...key, l.qtyUnits + l.freeUnits],
    );
  });
  b.add(
    `INSERT INTO ledger_entries (entry_date, party_type, party_id, credit_paise, ref_type, ref_id, narration)
     VALUES ($1, 'SUPPLIER', $2, $3, 'PURCHASE', (SELECT MAX(id) FROM purchases), $4)`,
    [p.billDate, p.supplierId, t.total, `Bill ${p.supplierBillNo.trim()}`],
  );
  return b;
}

/** Cancel a wrongly entered purchase. Fails (nothing saved) if some of that stock is already sold. */
export function planCancelPurchase(p: { purchaseId: number; reason: string; today: string }): Batch {
  const b = new Batch();
  b.add(`UPDATE purchases SET status = 'CANCELLED', cancel_reason = $2 WHERE id = $1`, [p.purchaseId, p.reason.trim() || null]);
  b.add(
    `INSERT INTO stock_moves (batch_id, qty_units, reason, ref_id, note, user_id)
     SELECT batch_id, -(qty_units + free_units), 'PURCHASE_RETURN', id, 'Purchase cancelled', 1
     FROM purchase_lines WHERE purchase_id = $1 AND qty_units + free_units > 0`,
    [p.purchaseId],
  );
  b.add(
    `INSERT INTO ledger_entries (entry_date, party_type, party_id, debit_paise, ref_type, ref_id, narration)
     SELECT $2, 'SUPPLIER', supplier_id, total_paise, 'PURCHASE_CANCEL', id, 'Purchase cancelled' FROM purchases WHERE id = $1`,
    [p.purchaseId, p.today],
  );
  b.add(`INSERT INTO audit_log (user_id, action, entity, entity_id, new_value) VALUES (1, 'PURCHASE_CANCEL', 'purchases', $1, $2)`, [
    p.purchaseId,
    JSON.stringify({ reason: p.reason }),
  ]);
  return b;
}
