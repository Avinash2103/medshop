// Queries for billing, purchase, returns, accounts and reports.
// Writes go through the plans in src/lib/ops (one transaction each).
import { query, queryOne } from "./index";
import { Batch } from "./batch";
import type { Schedule } from "./types";
import { BALANCE_SQL } from "../lib/ops/stockOps";

// ---------- Settings ----------

export async function saveSettings(values: Record<string, string>): Promise<void> {
  const b = new Batch();
  for (const [k, v] of Object.entries(values))
    b.add("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [k, v]);
  await b.run();
}

// ---------- Billing lookups ----------

export interface SellableBatch {
  id: number;
  batch_no: string;
  expiry: string;
  mrp_paise: number;
  sale_rate_paise: number;
  qty_units: number;
}

/** Batches that can be sold today, earliest expiry first (FEFO). */
export async function sellableBatches(itemId: number, today: string): Promise<SellableBatch[]> {
  return query<SellableBatch>(
    `SELECT id, batch_no, expiry, mrp_paise, sale_rate_paise, qty_units FROM batches
     WHERE item_id = $1 AND qty_units > 0 AND expiry >= $2 ORDER BY expiry, id`,
    [itemId, today],
  );
}

export interface ItemBasics {
  id: number;
  name: string;
  pack_size: number;
  unit: string;
  schedule: Schedule;
  gst_rate_bp: number;
  hsn: string | null;
}

export async function itemBasics(id: number): Promise<ItemBasics | null> {
  return queryOne<ItemBasics>("SELECT id, name, pack_size, unit, schedule, gst_rate_bp, hsn FROM items WHERE id = $1", [id]);
}

export interface CustomerHit {
  id: number;
  name: string;
  phone: string | null;
  balance: number;
}

export async function findCustomers(q: string): Promise<CustomerHit[]> {
  const t = q.trim();
  if (!t) return [];
  return query<CustomerHit>(
    `SELECT c.id, c.name, c.phone,
            c.opening_balance_paise + COALESCE((SELECT SUM(debit_paise - credit_paise) FROM ledger_entries
              WHERE party_type = 'CUSTOMER' AND party_id = c.id), 0) AS balance
     FROM customers c WHERE c.name LIKE $1 OR c.phone LIKE $1 ORDER BY c.name LIMIT 8`,
    [`%${t}%`],
  );
}

export async function quickAddCustomer(name: string, phone: string): Promise<number> {
  const b = new Batch();
  b.add("INSERT INTO customers (name, phone) VALUES ($1, $2)", [name.trim(), phone.trim() || null]);
  const r = await b.run();
  return r.last_ids[0];
}

// ---------- Bills ----------

export interface SaleHeader {
  id: number;
  bill_no: string;
  bill_date: string;
  bill_time: string;
  customer_id: number | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_gstin: string | null;
  customer_address: string | null;
  doctor_name: string | null;
  payment_mode: string;
  taxable_paise: number;
  gst_paise: number;
  discount_paise: number;
  round_off_paise: number;
  total_paise: number;
  status: "ACTIVE" | "CANCELLED";
  cancel_reason: string | null;
  returned_paise: number;
  line_count: number;
}

const SALE_HEADER = `
  SELECT s.id, s.bill_no, s.bill_date, s.bill_time, s.customer_id,
         COALESCE(c.name, s.customer_name) AS customer_name, COALESCE(s.customer_phone, c.phone) AS customer_phone,
         c.gstin AS customer_gstin, c.address AS customer_address,
         s.doctor_name, s.payment_mode, s.taxable_paise, s.gst_paise, s.discount_paise, s.round_off_paise, s.total_paise,
         s.status, s.cancel_reason,
         COALESCE((SELECT SUM(total_paise) FROM returns r WHERE r.ref_sale_id = s.id AND r.type = 'SALE_RETURN'), 0) AS returned_paise,
         (SELECT COUNT(*) FROM sale_lines WHERE sale_id = s.id) AS line_count
  FROM sales s LEFT JOIN customers c ON c.id = s.customer_id`;

export async function listSales(from: string, to: string, q: string): Promise<SaleHeader[]> {
  const like = `%${q.trim()}%`;
  return query<SaleHeader>(
    `${SALE_HEADER}
     WHERE s.bill_date BETWEEN $1 AND $2
       AND ($3 = '%%' OR s.bill_no LIKE $3 OR COALESCE(c.name, s.customer_name, '') LIKE $3 OR COALESCE(s.customer_phone, c.phone, '') LIKE $3)
     ORDER BY s.id DESC LIMIT 500`,
    [from, to, like],
  );
}

export interface SaleLineFull {
  id: number;
  batch_id: number;
  item_name: string;
  pack_size: number;
  unit: string;
  hsn: string | null;
  schedule: Schedule;
  batch_no: string;
  expiry: string;
  qty_units: number;
  mrp_paise: number;
  rate_paise: number;
  discount_bp: number;
  gst_rate_bp: number;
  taxable_paise: number;
  gst_paise: number;
  amount_paise: number;
  returned_units: number;
}

export interface RegisterEntry {
  schedule: string;
  prescriber_name: string;
  prescriber_address: string;
  patient_name: string;
  patient_address: string;
  rx_no: string | null;
}

export async function getSale(id: number): Promise<{ header: SaleHeader; lines: SaleLineFull[]; rx: RegisterEntry | null } | null> {
  const header = await queryOne<SaleHeader>(`${SALE_HEADER} WHERE s.id = $1`, [id]);
  if (!header) return null;
  const lines = await query<SaleLineFull>(
    `SELECT sl.id, sl.batch_id, i.name AS item_name, i.pack_size, i.unit, i.hsn, i.schedule, b.batch_no, b.expiry,
            sl.qty_units, sl.mrp_paise, sl.rate_paise, sl.discount_bp, sl.gst_rate_bp, sl.taxable_paise, sl.gst_paise, sl.amount_paise,
            COALESCE((SELECT SUM(rl.qty_units) FROM return_lines rl JOIN returns r ON r.id = rl.return_id
                      WHERE r.type = 'SALE_RETURN' AND r.ref_sale_id = sl.sale_id AND rl.batch_id = sl.batch_id), 0) AS returned_units
     FROM sale_lines sl JOIN batches b ON b.id = sl.batch_id JOIN items i ON i.id = b.item_id
     WHERE sl.sale_id = $1 ORDER BY sl.id`,
    [id],
  );
  const rx = await queryOne<RegisterEntry>(
    `SELECT r.schedule, r.prescriber_name, r.prescriber_address, r.patient_name, r.patient_address, r.rx_no
     FROM schedule_register r JOIN sale_lines sl ON sl.id = r.sale_line_id WHERE sl.sale_id = $1 LIMIT 1`,
    [id],
  );
  return { header, lines, rx };
}

// ---------- Purchases ----------

export interface SupplierLite {
  id: number;
  name: string;
}

export async function supplierList(): Promise<SupplierLite[]> {
  return query<SupplierLite>("SELECT id, name FROM suppliers ORDER BY name");
}

export interface PurchaseHeader {
  id: number;
  supplier_id: number;
  supplier_name: string;
  supplier_bill_no: string;
  bill_date: string;
  entry_date: string;
  taxable_paise: number;
  gst_paise: number;
  total_paise: number;
  status: "ACTIVE" | "CANCELLED";
  cancel_reason: string | null;
  note: string | null;
  line_count: number;
}

const PURCHASE_HEADER = `
  SELECT p.id, p.supplier_id, s.name AS supplier_name, p.supplier_bill_no, p.bill_date, p.entry_date,
         p.taxable_paise, p.gst_paise, p.total_paise, p.status, p.cancel_reason, p.note,
         (SELECT COUNT(*) FROM purchase_lines WHERE purchase_id = p.id) AS line_count
  FROM purchases p JOIN suppliers s ON s.id = p.supplier_id`;

export async function listPurchases(from: string, to: string, q: string): Promise<PurchaseHeader[]> {
  const like = `%${q.trim()}%`;
  return query<PurchaseHeader>(
    `${PURCHASE_HEADER} WHERE p.bill_date BETWEEN $1 AND $2 AND ($3 = '%%' OR s.name LIKE $3 OR p.supplier_bill_no LIKE $3)
     ORDER BY p.bill_date DESC, p.id DESC LIMIT 500`,
    [from, to, like],
  );
}

export interface PurchaseLineFull {
  item_name: string;
  pack_size: number;
  batch_no: string;
  expiry: string;
  mrp_paise: number;
  qty_units: number;
  free_units: number;
  rate_paise: number;
  discount_bp: number;
  gst_rate_bp: number;
  taxable_paise: number;
  gst_paise: number;
}

export async function getPurchase(id: number) {
  const header = await queryOne<PurchaseHeader>(`${PURCHASE_HEADER} WHERE p.id = $1`, [id]);
  if (!header) return null;
  const lines = await query<PurchaseLineFull>(
    `SELECT i.name AS item_name, i.pack_size, b.batch_no, b.expiry, b.mrp_paise, pl.qty_units, pl.free_units, pl.rate_paise,
            pl.discount_bp, pl.gst_rate_bp, pl.taxable_paise, pl.gst_paise
     FROM purchase_lines pl JOIN batches b ON b.id = pl.batch_id JOIN items i ON i.id = b.item_id
     WHERE pl.purchase_id = $1 ORDER BY pl.id`,
    [id],
  );
  return { header, lines };
}

/** What we paid last time for this medicine, to catch typing mistakes in a new purchase. */
export async function lastPurchase(itemId: number) {
  return queryOne<{ rate_paise: number; mrp_paise: number; bill_date: string; supplier: string }>(
    `SELECT pl.rate_paise, b.mrp_paise, p.bill_date, s.name AS supplier
     FROM purchase_lines pl JOIN purchases p ON p.id = pl.purchase_id JOIN batches b ON b.id = pl.batch_id
     JOIN suppliers s ON s.id = p.supplier_id
     WHERE b.item_id = $1 AND p.status = 'ACTIVE' ORDER BY p.bill_date DESC, pl.id DESC LIMIT 1`,
    [itemId],
  );
}

/** Newest batch of a medicine (e.g. from opening stock) to pre-fill MRP and rate. */
export async function latestBatch(itemId: number) {
  return queryOne<{ mrp_paise: number; purchase_rate_paise: number }>(
    "SELECT mrp_paise, purchase_rate_paise FROM batches WHERE item_id = $1 ORDER BY id DESC LIMIT 1",
    [itemId],
  );
}

// ---------- Expiry and stock ----------

export interface StockBatchRow {
  batch_id: number;
  item_id: number;
  item_name: string;
  company: string | null;
  pack_size: number;
  unit: string;
  batch_no: string;
  expiry: string;
  qty_units: number;
  mrp_paise: number;
  purchase_rate_paise: number;
  last_supplier_id: number | null;
  last_supplier: string | null;
}

/** Batches in stock expiring on or before `until` (includes already expired). */
export async function expiringBatches(until: string): Promise<StockBatchRow[]> {
  return query<StockBatchRow>(
    `SELECT b.id AS batch_id, i.id AS item_id, i.name AS item_name, c.name AS company, i.pack_size, i.unit, b.batch_no, b.expiry,
            b.qty_units, b.mrp_paise, b.purchase_rate_paise,
            (SELECT p.supplier_id FROM purchase_lines pl JOIN purchases p ON p.id = pl.purchase_id
              WHERE pl.batch_id = b.id ORDER BY p.id DESC LIMIT 1) AS last_supplier_id,
            (SELECT s.name FROM purchase_lines pl JOIN purchases p ON p.id = pl.purchase_id JOIN suppliers s ON s.id = p.supplier_id
              WHERE pl.batch_id = b.id ORDER BY p.id DESC LIMIT 1) AS last_supplier
     FROM batches b JOIN items i ON i.id = b.item_id LEFT JOIN companies c ON c.id = i.company_id
     WHERE b.qty_units > 0 AND b.expiry <= $1 ORDER BY b.expiry, i.name`,
    [until],
  );
}

export interface LowStockRow {
  id: number;
  name: string;
  company: string | null;
  pack_size: number;
  unit: string;
  stock_units: number;
  reorder_level: number;
  last_supplier: string | null;
}

export async function lowStock(today: string): Promise<LowStockRow[]> {
  return query<LowStockRow>(
    `SELECT i.id, i.name, c.name AS company, i.pack_size, i.unit,
            COALESCE(SUM(CASE WHEN b.expiry >= $1 THEN b.qty_units END), 0) AS stock_units, i.reorder_level,
            (SELECT s.name FROM purchase_lines pl JOIN purchases p ON p.id = pl.purchase_id JOIN suppliers s ON s.id = p.supplier_id
              JOIN batches b2 ON b2.id = pl.batch_id WHERE b2.item_id = i.id ORDER BY p.id DESC LIMIT 1) AS last_supplier
     FROM items i LEFT JOIN companies c ON c.id = i.company_id LEFT JOIN batches b ON b.item_id = i.id
     WHERE i.is_active = 1 AND i.reorder_level > 0
     GROUP BY i.id HAVING stock_units < i.reorder_level ORDER BY i.name`,
    [today],
  );
}

// ---------- Accounts ----------

export async function partyBalance(party: "CUSTOMER" | "SUPPLIER", id: number): Promise<number> {
  const r = await queryOne<{ balance: number }>(BALANCE_SQL[party], [id]);
  return r?.balance ?? 0;
}

export interface LedgerRow {
  id: number;
  entry_date: string;
  debit_paise: number;
  credit_paise: number;
  ref_type: string | null;
  ref_id: number | null;
  mode: string | null;
  narration: string | null;
}

export async function partyLedger(party: "CUSTOMER" | "SUPPLIER", id: number): Promise<LedgerRow[]> {
  return query<LedgerRow>(
    `SELECT id, entry_date, debit_paise, credit_paise, ref_type, ref_id, mode, narration FROM ledger_entries
     WHERE party_type = $1 AND party_id = $2 ORDER BY entry_date DESC, id DESC LIMIT 100`,
    [party, id],
  );
}

/** Everyone with money pending, biggest first. */
export async function outstanding(party: "CUSTOMER" | "SUPPLIER") {
  const table = party === "CUSTOMER" ? "customers" : "suppliers";
  const sign = party === "CUSTOMER" ? "debit_paise - credit_paise" : "credit_paise - debit_paise";
  return query<{ id: number; name: string; phone: string | null; balance: number }>(
    `SELECT * FROM (
       SELECT t.id, t.name, t.phone, t.opening_balance_paise + COALESCE((SELECT SUM(${sign}) FROM ledger_entries
         WHERE party_type = $1 AND party_id = t.id), 0) AS balance FROM ${table} t)
     WHERE balance <> 0 ORDER BY balance DESC`,
    [party],
  );
}

// ---------- Reports ----------

export interface DaySummary {
  bills: number;
  cancelled: number;
  discount_paise: number;
  total_paise: number;
  cash: number;
  upi: number;
  card: number;
  credit: number;
  returns_paise: number;
  returns_cash_paise: number;
  received_paise: number;
  received_cash_paise: number;
  paid_cash_paise: number;
  purchases: number;
  purchase_paise: number;
  paid_paise: number;
}

export async function daySummary(from: string, to: string): Promise<DaySummary> {
  const r = await queryOne<DaySummary>(
    `SELECT
      (SELECT COUNT(*) FROM sales WHERE bill_date BETWEEN $1 AND $2 AND status = 'ACTIVE') AS bills,
      (SELECT COUNT(*) FROM sales WHERE bill_date BETWEEN $1 AND $2 AND status = 'CANCELLED') AS cancelled,
      (SELECT COALESCE(SUM(discount_paise), 0) FROM sales WHERE bill_date BETWEEN $1 AND $2 AND status = 'ACTIVE') AS discount_paise,
      (SELECT COALESCE(SUM(total_paise), 0) FROM sales WHERE bill_date BETWEEN $1 AND $2 AND status = 'ACTIVE') AS total_paise,
      (SELECT COALESCE(SUM(total_paise), 0) FROM sales WHERE bill_date BETWEEN $1 AND $2 AND status = 'ACTIVE' AND payment_mode = 'CASH') AS cash,
      (SELECT COALESCE(SUM(total_paise), 0) FROM sales WHERE bill_date BETWEEN $1 AND $2 AND status = 'ACTIVE' AND payment_mode = 'UPI') AS upi,
      (SELECT COALESCE(SUM(total_paise), 0) FROM sales WHERE bill_date BETWEEN $1 AND $2 AND status = 'ACTIVE' AND payment_mode = 'CARD') AS card,
      (SELECT COALESCE(SUM(total_paise), 0) FROM sales WHERE bill_date BETWEEN $1 AND $2 AND status = 'ACTIVE' AND payment_mode = 'CREDIT') AS credit,
      (SELECT COALESCE(SUM(total_paise), 0) FROM returns WHERE type = 'SALE_RETURN' AND return_date BETWEEN $1 AND $2) AS returns_paise,
      (SELECT COALESCE(SUM(total_paise), 0) FROM returns WHERE type = 'SALE_RETURN' AND refund_mode = 'CASH' AND return_date BETWEEN $1 AND $2) AS returns_cash_paise,
      (SELECT COALESCE(SUM(credit_paise), 0) FROM ledger_entries WHERE party_type = 'CUSTOMER' AND ref_type = 'RECEIPT' AND entry_date BETWEEN $1 AND $2) AS received_paise,
      (SELECT COALESCE(SUM(credit_paise), 0) FROM ledger_entries WHERE party_type = 'CUSTOMER' AND ref_type = 'RECEIPT' AND mode = 'CASH' AND entry_date BETWEEN $1 AND $2) AS received_cash_paise,
      (SELECT COALESCE(SUM(debit_paise), 0) FROM ledger_entries WHERE party_type = 'SUPPLIER' AND ref_type = 'PAYMENT' AND mode = 'CASH' AND entry_date BETWEEN $1 AND $2) AS paid_cash_paise,
      (SELECT COUNT(*) FROM purchases WHERE bill_date BETWEEN $1 AND $2 AND status = 'ACTIVE') AS purchases,
      (SELECT COALESCE(SUM(total_paise), 0) FROM purchases WHERE bill_date BETWEEN $1 AND $2 AND status = 'ACTIVE') AS purchase_paise,
      (SELECT COALESCE(SUM(debit_paise), 0) FROM ledger_entries WHERE party_type = 'SUPPLIER' AND ref_type = 'PAYMENT' AND entry_date BETWEEN $1 AND $2) AS paid_paise`,
    [from, to],
  );
  return r!;
}

export interface GstRow {
  gst_rate_bp: number;
  taxable_paise: number;
  gst_paise: number;
}

/** Taxable value and GST per rate. Sales of active bills minus customer returns; purchases of active bills. */
export async function gstSummary(from: string, to: string): Promise<{ sales: GstRow[]; returns: GstRow[]; purchases: GstRow[] }> {
  const sales = await query<GstRow>(
    `SELECT sl.gst_rate_bp, SUM(sl.taxable_paise) AS taxable_paise, SUM(sl.gst_paise) AS gst_paise
     FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
     WHERE s.status = 'ACTIVE' AND s.bill_date BETWEEN $1 AND $2 GROUP BY sl.gst_rate_bp ORDER BY sl.gst_rate_bp`,
    [from, to],
  );
  // Returns are split back into taxable + GST at the rate of the line they came from.
  const returns = await query<GstRow>(
    `SELECT sl.gst_rate_bp,
            SUM(CAST(ROUND(rl.amount_paise * 10000.0 / (10000 + sl.gst_rate_bp)) AS INTEGER)) AS taxable_paise,
            SUM(rl.amount_paise - CAST(ROUND(rl.amount_paise * 10000.0 / (10000 + sl.gst_rate_bp)) AS INTEGER)) AS gst_paise
     FROM return_lines rl JOIN returns r ON r.id = rl.return_id
     JOIN sale_lines sl ON sl.sale_id = r.ref_sale_id AND sl.batch_id = rl.batch_id
     WHERE r.type = 'SALE_RETURN' AND r.return_date BETWEEN $1 AND $2
       AND sl.id = (SELECT MIN(id) FROM sale_lines WHERE sale_id = r.ref_sale_id AND batch_id = rl.batch_id)
     GROUP BY sl.gst_rate_bp ORDER BY sl.gst_rate_bp`,
    [from, to],
  );
  const purchases = await query<GstRow>(
    `SELECT pl.gst_rate_bp, SUM(pl.taxable_paise) AS taxable_paise, SUM(pl.gst_paise) AS gst_paise
     FROM purchase_lines pl JOIN purchases p ON p.id = pl.purchase_id
     WHERE p.status = 'ACTIVE' AND p.bill_date BETWEEN $1 AND $2 GROUP BY pl.gst_rate_bp ORDER BY pl.gst_rate_bp`,
    [from, to],
  );
  return { sales, returns, purchases };
}

export async function hsnSummary(from: string, to: string) {
  return query<{ hsn: string; gst_rate_bp: number; qty_units: number; taxable_paise: number; gst_paise: number; total_paise: number }>(
    `SELECT COALESCE(i.hsn, '') AS hsn, sl.gst_rate_bp, SUM(sl.qty_units) AS qty_units, SUM(sl.taxable_paise) AS taxable_paise,
            SUM(sl.gst_paise) AS gst_paise, SUM(sl.amount_paise) AS total_paise
     FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id JOIN batches b ON b.id = sl.batch_id JOIN items i ON i.id = b.item_id
     WHERE s.status = 'ACTIVE' AND s.bill_date BETWEEN $1 AND $2 GROUP BY 1, 2 ORDER BY 1, 2`,
    [from, to],
  );
}

export interface RegisterRow {
  entry_date: string;
  bill_no: string;
  item_name: string;
  batch_no: string;
  qty_units: number;
  pack_size: number;
  schedule: string;
  prescriber_name: string;
  prescriber_address: string;
  patient_name: string;
  patient_address: string;
  rx_no: string | null;
  status: string;
}

export async function scheduleRegister(from: string, to: string, schedule: string): Promise<RegisterRow[]> {
  return query<RegisterRow>(
    `SELECT r.entry_date, s.bill_no, i.name AS item_name, b.batch_no, sl.qty_units, i.pack_size, r.schedule,
            r.prescriber_name, r.prescriber_address, r.patient_name, r.patient_address, r.rx_no, s.status
     FROM schedule_register r JOIN sale_lines sl ON sl.id = r.sale_line_id JOIN sales s ON s.id = sl.sale_id
     JOIN batches b ON b.id = sl.batch_id JOIN items i ON i.id = b.item_id
     WHERE r.entry_date BETWEEN $1 AND $2 AND ($3 = 'ALL' OR r.schedule = $3)
     ORDER BY r.entry_date, s.id`,
    [from, to, schedule],
  );
}

export async function stockValue(today: string) {
  return queryOne<{ items: number; batches: number; mrp_paise: number; cost_paise: number; expired_cost_paise: number }>(
    `SELECT COUNT(DISTINCT b.item_id) AS items, COUNT(*) AS batches,
            COALESCE(SUM(CAST(ROUND(b.mrp_paise * 1.0 * b.qty_units / i.pack_size) AS INTEGER)), 0) AS mrp_paise,
            COALESCE(SUM(CAST(ROUND(b.purchase_rate_paise * 1.0 * b.qty_units / i.pack_size) AS INTEGER)), 0) AS cost_paise,
            COALESCE(SUM(CASE WHEN b.expiry < $1 THEN CAST(ROUND(b.purchase_rate_paise * 1.0 * b.qty_units / i.pack_size) AS INTEGER) END), 0) AS expired_cost_paise
     FROM batches b JOIN items i ON i.id = b.item_id WHERE b.qty_units > 0`,
    [today],
  );
}
