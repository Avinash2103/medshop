import { beforeAll, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { all, freshDb, get, runBatch } from "../test/sqlite";

// Route the app's read helpers to an in-memory SQLite database.
let db: DatabaseSync;
vi.mock("./index", () => ({
  query: async (sql: string, params: unknown[] = []) => all(db, sql, ...(params as (string | number | null)[])),
  queryOne: async (sql: string, params: unknown[] = []) => get(db, sql, ...(params as (string | number | null)[])) ?? null,
  execute: async () => ({}),
  getDb: async () => ({}),
  hasDatabase: () => true,
}));

import * as ops from "./ops";
import { planCancelSale, planSale, planSaleReturn, type CartLine, type SaleInput } from "../lib/ops/sale";
import { planPurchase, type PurchaseLine } from "../lib/ops/purchase";
import { planPayment, planStockOut } from "../lib/ops/stockOps";

const D = "2026-11-08";

beforeAll(() => {
  db = freshDb();
  db.exec(`INSERT INTO suppliers (name) VALUES ('Shree Ganesh Pharma');
           INSERT INTO customers (name, phone) VALUES ('Ramesh Patil', '9822011223');
           INSERT INTO items (name, pack_size, gst_rate_bp, schedule, hsn, reorder_level) VALUES
             ('DOLO 650', 15, 500, 'OTC', '30049099', 300), ('AZITHRAL 500', 5, 500, 'H1', '30042019', 0), ('VOLINI GEL', 1, 1800, 'OTC', '30049011', 0);`);
  const pl = (o: Partial<PurchaseLine>): PurchaseLine => ({
    key: "k", itemId: 1, name: "", packSize: 15, gstBp: 500, batchNo: "DL1", expiry: "2027-08-31", mrpPaise: 3091, ratePaise: 2207,
    salePaise: 3091, qtyUnits: 150, freeUnits: 0, discountBp: 0, ...o,
  });
  runBatch(db, planPurchase({ supplierId: 1, supplierBillNo: "A1", billDate: D, note: "", today: D, lines: [
    pl({}),
    pl({ itemId: 2, packSize: 5, batchNo: "AZ1", mrpPaise: 11950, ratePaise: 8536, salePaise: 11950, qtyUnits: 50 }),
    pl({ itemId: 3, packSize: 1, gstBp: 1800, batchNo: "VG1", expiry: "2026-12-31", mrpPaise: 16500, ratePaise: 11786, salePaise: 16500, qtyUnits: 10 }),
  ] }));
  const cl = (o: Partial<CartLine>): CartLine => ({
    key: "a", itemId: 1, name: "", packSize: 15, unit: "TAB", schedule: "OTC", gstBp: 500, hsn: null, batchId: 1, batchNo: "DL1",
    expiry: "2027-08-31", mrpPaise: 3091, ratePaise: 3091, qtyUnits: 15, discountBp: 0, stockUnits: 999, ...o,
  });
  const s = (o: Partial<SaleInput>): SaleInput => ({
    lines: [cl({})], billDate: D, billTime: "10:00:00", billPrefix: "S", paymentMode: "CASH", customerId: null, customerName: "",
    customerPhone: "", doctorName: "", rx: { prescriberName: "Dr. K", prescriberAddress: "Pune", patientName: "Sunita", patientAddress: "Pune", rxNo: "" },
    today: D, ...o,
  });
  runBatch(db, planSale(s({}))); // 1: cash ₹31
  runBatch(db, planSale(s({ paymentMode: "UPI", lines: [cl({}), cl({ key: "v", itemId: 3, packSize: 1, gstBp: 1800, batchId: 3, mrpPaise: 16500, ratePaise: 16500, qtyUnits: 1 })] }))); // 2
  runBatch(db, planSale(s({ paymentMode: "CREDIT", customerId: 1, lines: [cl({ itemId: 2, schedule: "H1", batchId: 2, packSize: 5, mrpPaise: 11950, ratePaise: 11950, qtyUnits: 5 })] }))); // 3: H1 on credit
  runBatch(db, planSale(s({}))); // 4: to be cancelled
  runBatch(db, planCancelSale({ saleId: 4, reason: "test", today: D, creditCustomerId: null, totalPaise: 0 }));
  runBatch(db, planSaleReturn({ saleId: 2, customerId: null, refundMode: "CASH", note: "", today: D, lines: [{ batchId: 3, qtyUnits: 1, amountPaise: 16500, ratePaise: 16500 }] }));
  runBatch(db, planPayment({ party: "CUSTOMER", partyId: 1, amountPaise: 5000, mode: "CASH", note: "", date: D }));
  runBatch(db, planStockOut({ type: "BREAKAGE", supplierId: null, claimPaise: 0, note: "", today: D, lines: [{ batchId: 1, qtyUnits: 1, ratePaise: 2207, packSize: 15 }] }));
});

describe("report and lookup queries", () => {
  it("day summary", async () => {
    const d = await ops.daySummary(D, D);
    expect(d).toMatchObject({ bills: 3, cancelled: 1, cash: 3100, upi: 3100 + 16500, credit: 12000, returns_paise: 16500, returns_cash_paise: 16500, received_paise: 5000, received_cash_paise: 5000, paid_cash_paise: 0, purchases: 1 });
    expect(d.total_paise).toBe(3100 + 19600 + 12000);
  });

  it("sales list, bill detail with returned quantity, and the H1 details", async () => {
    const list = await ops.listSales(D, D, "");
    expect(list.map((s) => s.bill_no)).toEqual(["S/2026-27/000004", "S/2026-27/000003", "S/2026-27/000002", "S/2026-27/000001"]);
    expect(list.find((s) => s.id === 2)!.returned_paise).toBe(16500);
    expect((await ops.listSales(D, D, "ramesh")).map((s) => s.id)).toEqual([3]);
    const bill = await ops.getSale(2);
    expect(bill!.lines.map((l) => [l.item_name, l.returned_units])).toEqual([["DOLO 650", 0], ["VOLINI GEL", 1]]);
    expect((await ops.getSale(3))!.rx).toMatchObject({ schedule: "H1", patient_name: "Sunita" });
  });

  it("GST summary nets returns, HSN summary groups", async () => {
    const g = await ops.gstSummary(D, D);
    expect(g.sales.map((r) => r.gst_rate_bp)).toEqual([500, 1800]);
    expect(g.returns).toEqual([{ gst_rate_bp: 1800, taxable_paise: 13983, gst_paise: 2517 }]);
    expect(g.purchases.map((r) => r.gst_rate_bp)).toEqual([500, 1800]);
    const h = await ops.hsnSummary(D, D);
    expect(h.map((r) => r.hsn)).toEqual(["30042019", "30049011", "30049099"]);
  });

  it("schedule register lists only register medicines", async () => {
    const r = await ops.scheduleRegister(D, D, "ALL");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ item_name: "AZITHRAL 500", qty_units: 5, prescriber_name: "Dr. K" });
  });

  it("stock: sellable batches, expiring, low stock, value", async () => {
    expect((await ops.sellableBatches(1, D)).map((b) => b.qty_units)).toEqual([150 - 15 - 15 - 1]); // cancelled bill gave its 15 back
    expect((await ops.expiringBatches("2027-01-31")).map((b) => [b.item_name, b.last_supplier])).toEqual([["VOLINI GEL", "Shree Ganesh Pharma"]]);
    expect((await ops.lowStock(D)).map((r) => r.name)).toEqual(["DOLO 650"]);
    const v = await ops.stockValue(D);
    expect(v!.items).toBe(3);
  });

  it("balances, outstanding and ledger", async () => {
    expect(await ops.partyBalance("CUSTOMER", 1)).toBe(12000 - 5000) // ₹119.50 bill rounded to ₹120;
    expect((await ops.outstanding("CUSTOMER")).map((r) => r.balance)).toEqual([7000]);
    expect((await ops.partyLedger("CUSTOMER", 1)).length).toBe(2);
    expect(await ops.partyBalance("SUPPLIER", 1)).toBeGreaterThan(0);
    expect((await ops.findCustomers("9822"))[0]).toMatchObject({ name: "Ramesh Patil", balance: 7000 });
    expect((await ops.lastPurchase(1))!.rate_paise).toBe(2207);
  });
});
