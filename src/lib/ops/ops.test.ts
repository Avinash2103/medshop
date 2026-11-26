import { describe, expect, it } from "vitest";
import { all, freshDb, get, runBatch } from "../../test/sqlite";
import { billPrefix, financialYear } from "./fy";
import { cartTotals, checkSale, planCancelSale, planSale, planSaleReturn, refundFor, type CartLine, type SaleInput } from "./sale";
import { checkPurchase, planCancelPurchase, planPurchase, purchaseTotals, type PurchaseLine } from "./purchase";
import { BALANCE_SQL, planAdjustment, planPayment, planStockOut } from "./stockOps";
import type { DatabaseSync } from "node:sqlite";

const TODAY = "2026-11-08";
const stock = (db: DatabaseSync, batchId: number) => get<{ q: number }>(db, "SELECT qty_units q FROM batches WHERE id = $1", batchId).q;

/** Shop with one supplier, one customer, and two medicines bought through a real purchase. */
function shop() {
  const db = freshDb();
  db.exec(`INSERT INTO suppliers (name) VALUES ('Shree Ganesh Pharma');
           INSERT INTO customers (name, phone) VALUES ('Ramesh Patil', '9822011223');
           INSERT INTO items (name, pack_size, gst_rate_bp, schedule) VALUES ('DOLO 650', 15, 500, 'OTC'), ('AZITHRAL 500', 5, 500, 'H1');`);
  const line = (over: Partial<PurchaseLine>): PurchaseLine => ({
    key: "x", itemId: 1, name: "DOLO 650", packSize: 15, gstBp: 500, batchNo: "dl1", expiry: "2027-08-31",
    mrpPaise: 3091, ratePaise: 2207, salePaise: 3091, qtyUnits: 150, freeUnits: 15, discountBp: 0, ...over,
  });
  const purchase = {
    supplierId: 1, supplierBillNo: "GP/1001", billDate: TODAY, note: "", today: TODAY,
    lines: [line({}), line({ key: "y", itemId: 2, name: "AZITHRAL 500", packSize: 5, batchNo: "AZ9", mrpPaise: 11950, ratePaise: 8536, salePaise: 11950, qtyUnits: 50, freeUnits: 0, discountBp: 1000 })],
  };
  runBatch(db, planPurchase(purchase));
  return { db, purchase };
}

function cartLine(over: Partial<CartLine>): CartLine {
  return {
    key: "a", itemId: 1, name: "DOLO 650", packSize: 15, unit: "TAB", schedule: "OTC", gstBp: 500, hsn: null,
    batchId: 1, batchNo: "DL1", expiry: "2027-08-31", mrpPaise: 3091, ratePaise: 3091, qtyUnits: 15, discountBp: 0, stockUnits: 165, ...over,
  };
}

function sale(over: Partial<SaleInput>): SaleInput {
  return {
    lines: [cartLine({})], billDate: TODAY, billTime: "10:15:00", billPrefix: "S", paymentMode: "CASH",
    customerId: null, customerName: "", customerPhone: "", doctorName: "",
    rx: { prescriberName: "", prescriberAddress: "", patientName: "", patientAddress: "", rxNo: "" }, today: TODAY, ...over,
  };
}

describe("financial year", () => {
  it("starts in April", () => {
    expect(financialYear("2026-11-08")).toBe("2026-27");
    expect(financialYear("2027-03-31")).toBe("2026-27");
    expect(financialYear("2027-04-01")).toBe("2027-28");
    expect(billPrefix("S", "2026-11-08")).toBe("S/2026-27/");
  });
});

describe("purchase", () => {
  it("computes supplier bill totals (rate before GST, discount, GST on top)", () => {
    const { purchase } = shop();
    const t = purchaseTotals(purchase.lines);
    // DOLO: 10 strips × 22.07 = 220.70, +5% = 11.04 → 231.74
    expect(t.lines[0]).toEqual({ gross: 22070, discount: 0, taxable: 22070, gst: 1104, total: 23174 });
    // AZITHRAL: 10 strips × 85.36 = 853.60, −10% = 768.24, +5% = 38.41
    expect(t.lines[1]).toEqual({ gross: 85360, discount: 8536, taxable: 76824, gst: 3841, total: 80665 });
  });

  it("brings stock in including free goods, and records what we owe", () => {
    const { db } = shop();
    expect(stock(db, 1)).toBe(165); // 150 + 15 free
    expect(get<{ b: string }>(db, "SELECT batch_no b FROM batches WHERE id = 1").b).toBe("DL1"); // saved in capitals
    expect(get<{ balance: number }>(db, BALANCE_SQL.SUPPLIER, 1).balance).toBe(23174 + 80665);
  });

  it("refuses the same supplier bill number twice", () => {
    const { db, purchase } = shop();
    expect(() => runBatch(db, planPurchase(purchase))).toThrow(/UNIQUE/);
  });

  it("flags incomplete lines before saving", () => {
    const { purchase } = shop();
    const bad = { ...purchase, supplierBillNo: " ", lines: [{ ...purchase.lines[0], batchNo: "" }] };
    expect(checkPurchase(bad).map((p) => p.code)).toEqual(["NO_BILL_NO", "LINE_INCOMPLETE"]);
  });

  it("cancels a purchase only while its stock is unsold", () => {
    const { db } = shop();
    runBatch(db, planSale(sale({ lines: [cartLine({ qtyUnits: 10 })] })));
    expect(() => runBatch(db, planCancelPurchase({ purchaseId: 1, reason: "wrong", today: TODAY }))).toThrow(/STOCK_NEGATIVE/);
    expect(get<{ s: string }>(db, "SELECT status s FROM purchases").s).toBe("ACTIVE");
  });
});

describe("billing", () => {
  it("totals a bill with loose tablets, discount and round-off", () => {
    const t = cartTotals([cartLine({ qtyUnits: 20 }), cartLine({ key: "b", batchId: 2, packSize: 5, mrpPaise: 11950, ratePaise: 11950, qtyUnits: 5, discountBp: 1000 })]);
    expect(t.lines[0].amount).toBe(4121); // 20 tabs of a ₹30.91 strip of 15
    expect(t.lines[1].amount).toBe(10755); // ₹119.50 − 10%
    expect(t.total).toBe(14876);
    expect(t.payable).toBe(14900);
    expect(t.roundOff).toBe(24);
    expect(t.byRate).toHaveLength(1);
    expect(t.byRate[0].cgst + t.byRate[0].sgst + t.taxable).toBe(t.total);
  });

  it("numbers bills per financial year without gaps", () => {
    const { db } = shop();
    runBatch(db, planSale(sale({})));
    runBatch(db, planSale(sale({})));
    runBatch(db, planSale(sale({ billDate: "2027-04-02" })));
    const nos = all<{ bill_no: string }>(db, "SELECT bill_no FROM sales ORDER BY id").map((r) => r.bill_no);
    expect(nos).toEqual(["S/2026-27/000001", "S/2026-27/000002", "S/2027-28/000001"]);
  });

  it("takes stock out and blocks overselling in the database too", () => {
    const { db } = shop();
    runBatch(db, planSale(sale({ lines: [cartLine({ qtyUnits: 20 })] })));
    expect(stock(db, 1)).toBe(145);
    expect(() => runBatch(db, planSale(sale({ lines: [cartLine({ qtyUnits: 500 })] })))).toThrow(/STOCK_NEGATIVE/);
    expect(get<{ n: number }>(db, "SELECT COUNT(*) n FROM sales").n).toBe(1); // failed bill left nothing behind
  });

  it("requires prescription details for H1 and writes the register", () => {
    const h1 = cartLine({ key: "h", itemId: 2, name: "AZITHRAL 500", schedule: "H1", batchId: 2, packSize: 5, mrpPaise: 11950, ratePaise: 11950, qtyUnits: 5, stockUnits: 50 });
    expect(checkSale(sale({ lines: [h1] })).map((p) => p.code)).toEqual(["RX_MISSING"]);
    const { db } = shop();
    const rx = { prescriberName: "Dr. Kulkarni", prescriberAddress: "Kothrud, Pune", patientName: "Sunita Joshi", patientAddress: "Karve Nagar", rxNo: "" };
    runBatch(db, planSale(sale({ lines: [cartLine({}), h1], rx })));
    const reg = all<{ schedule: string; patient_name: string }>(db, "SELECT schedule, patient_name FROM schedule_register");
    expect(reg).toEqual([{ schedule: "H1", patient_name: "Sunita Joshi" }]); // only the H1 line
  });

  it("checks stock across two lines of the same batch, expiry and credit", () => {
    const p = checkSale(sale({ paymentMode: "CREDIT", lines: [cartLine({ qtyUnits: 100 }), cartLine({ key: "b", qtyUnits: 100 }), cartLine({ key: "c", expiry: "2026-10-31" })] }));
    expect(p.map((x) => x.code).sort()).toEqual(["CREDIT_NEEDS_CUSTOMER", "EXPIRED_BATCH", "OVER_STOCK", "OVER_STOCK", "OVER_STOCK"]);
  });

  it("puts credit bills on the customer's account", () => {
    const { db } = shop();
    runBatch(db, planSale(sale({ paymentMode: "CREDIT", customerId: 1 })));
    expect(get<{ balance: number }>(db, BALANCE_SQL.CUSTOMER, 1).balance).toBe(3100);
    runBatch(db, planPayment({ party: "CUSTOMER", partyId: 1, amountPaise: 1000, mode: "UPI", note: "", date: TODAY }));
    expect(get<{ balance: number }>(db, BALANCE_SQL.CUSTOMER, 1).balance).toBe(2100);
  });

  it("cancels a bill: stock back, credit reversed, and only once", () => {
    const { db } = shop();
    runBatch(db, planSale(sale({ paymentMode: "CREDIT", customerId: 1, lines: [cartLine({ qtyUnits: 30 })] })));
    runBatch(db, planCancelSale({ saleId: 1, reason: "wrong medicine", today: TODAY, creditCustomerId: 1, totalPaise: 6200 }));
    expect(stock(db, 1)).toBe(165);
    expect(get<{ balance: number }>(db, BALANCE_SQL.CUSTOMER, 1).balance).toBe(0);
    expect(() => runBatch(db, planCancelSale({ saleId: 1, reason: "", today: TODAY, creditCustomerId: 1, totalPaise: 6200 }))).toThrow(/ALREADY_CANCELLED/);
  });

  it("returns part of a bill and refuses returning more than sold", () => {
    const { db } = shop();
    runBatch(db, planSale(sale({ lines: [cartLine({ qtyUnits: 30, discountBp: 1000 })] })));
    const line = get<{ qty_units: number; amount_paise: number }>(db, "SELECT qty_units, amount_paise FROM sale_lines");
    const refund = refundFor(line.qty_units, line.amount_paise, 10);
    expect(refund).toBe(1855); // a third of ₹55.64
    runBatch(db, planSaleReturn({ saleId: 1, customerId: null, refundMode: "CASH", note: "", today: TODAY, lines: [{ batchId: 1, qtyUnits: 10, amountPaise: refund, ratePaise: 3091 }] }));
    expect(stock(db, 1)).toBe(145);
    expect(() =>
      runBatch(db, planSaleReturn({ saleId: 1, customerId: null, refundMode: "CASH", note: "", today: TODAY, lines: [{ batchId: 1, qtyUnits: 21, amountPaise: 1, ratePaise: 1 }] })),
    ).toThrow(/RETURN_MORE_THAN_SOLD/);
    // A bill with a return cannot be cancelled as a whole any more.
    runBatch(db, planCancelSale({ saleId: 1, reason: "", today: TODAY, creditCustomerId: null, totalPaise: 0 }));
    expect(get<{ s: string }>(db, "SELECT status s FROM sales").s).toBe("ACTIVE");
    expect(stock(db, 1)).toBe(145);
  });
});

describe("stock out, adjustment, payments", () => {
  it("sends expired stock back and records the claim on the supplier", () => {
    const { db } = shop();
    const before = get<{ balance: number }>(db, BALANCE_SQL.SUPPLIER, 1).balance;
    runBatch(db, planStockOut({ type: "EXPIRY_RETURN", supplierId: 1, claimPaise: 2207, note: "", today: TODAY, lines: [{ batchId: 1, qtyUnits: 15, ratePaise: 2207, packSize: 15 }] }));
    expect(stock(db, 1)).toBe(150);
    expect(get<{ balance: number }>(db, BALANCE_SQL.SUPPLIER, 1).balance).toBe(before - 2207);
  });

  it("corrects stock to the physical count with a reason", () => {
    const { db } = shop();
    runBatch(db, planAdjustment({ batchId: 1, currentUnits: 165, countedUnits: 160, reason: "count" })!);
    expect(stock(db, 1)).toBe(160);
    expect(planAdjustment({ batchId: 1, currentUnits: 160, countedUnits: 160, reason: "" })).toBeNull();
    expect(get<{ n: number }>(db, "SELECT COUNT(*) n FROM audit_log WHERE action = 'STOCK_ADJUST'").n).toBe(1);
  });

  it("reduces what we owe a supplier when we pay", () => {
    const { db } = shop();
    const before = get<{ balance: number }>(db, BALANCE_SQL.SUPPLIER, 1).balance;
    runBatch(db, planPayment({ party: "SUPPLIER", partyId: 1, amountPaise: 50000, mode: "BANK", note: "NEFT", date: TODAY }));
    expect(get<{ balance: number }>(db, BALANCE_SQL.SUPPLIER, 1).balance).toBe(before - 50000);
  });
});
