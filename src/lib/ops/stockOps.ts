// Stock that leaves without a sale (expiry, breakage), stock corrections, and money in/out.
import { Batch } from "../../db/batch";
import type { Paise } from "../money";

export interface OutLine {
  batchId: number;
  qtyUnits: number;
  /** Value per pack used for the record (purchase rate). */
  ratePaise: Paise;
  packSize: number;
}

export function outValue(l: OutLine): Paise {
  return Math.round((l.ratePaise * l.qtyUnits) / Math.max(1, l.packSize));
}

/**
 * Expired stock sent back to the supplier, or broken / damaged stock written off.
 * An expiry return to a supplier records the claim in their account (they owe a credit note).
 */
export function planStockOut(p: {
  type: "EXPIRY_RETURN" | "BREAKAGE";
  supplierId: number | null;
  lines: OutLine[];
  claimPaise: Paise;
  note: string;
  today: string;
}): Batch {
  const b = new Batch();
  b.add(`INSERT INTO returns (type, party_id, return_date, total_paise, note, user_id) VALUES ($1, $2, $3, $4, $5, 1)`, [
    p.type,
    p.supplierId,
    p.today,
    p.claimPaise,
    p.note.trim() || null,
  ]);
  for (const l of p.lines) {
    if (l.qtyUnits <= 0) continue;
    b.add(`INSERT INTO return_lines (return_id, batch_id, qty_units, rate_paise, amount_paise) VALUES ((SELECT MAX(id) FROM returns), $1, $2, $3, $4)`, [
      l.batchId,
      l.qtyUnits,
      l.ratePaise,
      outValue(l),
    ]);
    b.add(`INSERT INTO stock_moves (batch_id, qty_units, reason, ref_id, user_id) VALUES ($1, $2, $3, last_insert_rowid(), 1)`, [l.batchId, -l.qtyUnits, p.type]);
  }
  if (p.type === "EXPIRY_RETURN" && p.supplierId && p.claimPaise > 0)
    b.add(
      `INSERT INTO ledger_entries (entry_date, party_type, party_id, debit_paise, ref_type, ref_id, narration)
       VALUES ($1, 'SUPPLIER', $2, $3, 'EXPIRY_RETURN', (SELECT MAX(id) FROM returns), 'Expiry return (credit note due)')`,
      [p.today, p.supplierId, p.claimPaise],
    );
  return b;
}

/** Physical count differs from the system: set the batch to what is really on the shelf. */
export function planAdjustment(p: { batchId: number; currentUnits: number; countedUnits: number; reason: string }): Batch | null {
  const diff = p.countedUnits - p.currentUnits;
  if (diff === 0) return null;
  const b = new Batch();
  b.add(`INSERT INTO stock_moves (batch_id, qty_units, reason, note, user_id) VALUES ($1, $2, 'ADJUSTMENT', $3, 1)`, [p.batchId, diff, p.reason.trim() || null]);
  b.add(`INSERT INTO audit_log (user_id, action, entity, entity_id, old_value, new_value) VALUES (1, 'STOCK_ADJUST', 'batches', $1, $2, $3)`, [
    p.batchId,
    JSON.stringify({ qty: p.currentUnits }),
    JSON.stringify({ qty: p.countedUnits, reason: p.reason }),
  ]);
  return b;
}

export type MoneyMode = "CASH" | "UPI" | "CARD" | "BANK";

/** Money received from a customer (reduces what they owe) or paid to a supplier (reduces what we owe). */
export function planPayment(p: {
  party: "CUSTOMER" | "SUPPLIER";
  partyId: number;
  amountPaise: Paise;
  mode: MoneyMode;
  note: string;
  date: string;
}): Batch {
  const b = new Batch();
  const col = p.party === "CUSTOMER" ? "credit_paise" : "debit_paise";
  const ref = p.party === "CUSTOMER" ? "RECEIPT" : "PAYMENT";
  b.add(`INSERT INTO ledger_entries (entry_date, party_type, party_id, ${col}, ref_type, mode, narration) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
    p.date,
    p.party,
    p.partyId,
    p.amountPaise,
    ref,
    p.mode,
    p.note.trim() || (p.party === "CUSTOMER" ? "Payment received" : "Payment made"),
  ]);
  return b;
}

/**
 * Balance SQL. Customer: positive = they owe us. Supplier: positive = we owe them.
 * $1 = party id.
 */
export const BALANCE_SQL = {
  CUSTOMER: `SELECT (SELECT opening_balance_paise FROM customers WHERE id = $1)
                  + COALESCE((SELECT SUM(debit_paise - credit_paise) FROM ledger_entries WHERE party_type = 'CUSTOMER' AND party_id = $1), 0) AS balance`,
  SUPPLIER: `SELECT (SELECT opening_balance_paise FROM suppliers WHERE id = $1)
                  + COALESCE((SELECT SUM(credit_paise - debit_paise) FROM ledger_entries WHERE party_type = 'SUPPLIER' AND party_id = $1), 0) AS balance`,
};
