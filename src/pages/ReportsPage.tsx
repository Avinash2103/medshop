import { useEffect, useState, type ReactNode } from "react";
import { useT } from "../i18n/I18nProvider";
import type { StringKey } from "../i18n/strings";
import { useSettings } from "../app/SettingsContext";
import { hasDatabase } from "../db";
import * as ops from "../db/ops";
import { formatPaise, splitCgstSgst } from "../lib/money";
import { isoDate } from "../lib/stock";
import { fyRange } from "../lib/ops/fy";
import { downloadCsv, rs, type CsvValue } from "../lib/csv";
import { Button, PageHeader, Select } from "../components/Form";
import { DateRange, Table, showDate, td, tdR } from "../components/ListTools";
import { PrintJob } from "../components/Print";

type Tab = "day" | "sales" | "purchases" | "gst" | "register" | "stock";
const TABS: { k: Tab; label: StringKey }[] = [
  { k: "day", label: "repDay" },
  { k: "sales", label: "repSales" },
  { k: "purchases", label: "repPurchases" },
  { k: "gst", label: "repGst" },
  { k: "register", label: "repRegister" },
  { k: "stock", label: "repStock" },
];

/** A report = what to show on screen + rows for Excel. */
interface Report {
  body: ReactNode;
  csv?: { name: string; header: string[]; rows: CsvValue[][] };
}

export function ReportsPage() {
  const { t } = useT();
  const { settings } = useSettings();
  const [tab, setTab] = useState<Tab>("day");
  const [from, setFrom] = useState(isoDate());
  const [to, setTo] = useState(isoDate());
  const [schedule, setSchedule] = useState("ALL");
  const [report, setReport] = useState<Report | null>(null);
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    if (!hasDatabase()) return;
    let stale = false;
    build(tab, from, to, schedule, t).then((r) => !stale && setReport(r)).catch((e) => !stale && setReport({ body: <p className="text-bad">{String(e)}</p> }));
    return () => {
      stale = true;
    };
  }, [tab, from, to, schedule, t]);

  const title = t(TABS.find((x) => x.k === tab)!.label);
  return (
    <div className="space-y-4">
      <PageHeader title={t("reports")} actions={<>
        <Button onClick={() => setPrinting(true)}>{t("print")}</Button>
        {report?.csv && <Button onClick={() => downloadCsv(report.csv!.name, report.csv!.header, report.csv!.rows)}>{t("exportCsv")}</Button>}
      </>} />
      <div className="flex flex-wrap gap-2" role="tablist">
        {TABS.map((x) => (
          <button key={x.k} type="button" role="tab" aria-selected={tab === x.k} onClick={() => setTab(x.k)}
            className={"rounded-lg px-4 py-2 font-medium " + (tab === x.k ? "bg-brand text-white" : "border border-line bg-card hover:border-brand")}>
            {t(x.label)}
          </button>
        ))}
      </div>
      {tab !== "stock" && (
        <DateRange from={from} to={to} onChange={(f, tt) => { setFrom(f); setTo(tt); }}>
          <button type="button" className="h-10 rounded-lg border border-line px-3 text-sm hover:border-brand" onClick={() => {
            const d = new Date();
            setFrom(isoDate(new Date(d.getFullYear(), d.getMonth(), 1)));
            setTo(isoDate());
          }}>{new Intl.DateTimeFormat("en-IN", { month: "short" }).format(new Date())}</button>
          <button type="button" className="h-10 rounded-lg border border-line px-3 text-sm hover:border-brand" onClick={() => { const r = fyRange(isoDate()); setFrom(r.from); setTo(r.to); }}>FY</button>
          {tab === "register" && (
            <label className="text-sm">
              <span className="mb-1 block font-medium">{t("scheduleFilter")}</span>
              <Select value={schedule} onChange={(e) => setSchedule(e.target.value)} className="w-32">
                <option value="ALL">{t("allSchedules")}</option>
                <option value="H1">H1</option>
                <option value="X">X</option>
                <option value="NDPS">NDPS</option>
              </Select>
            </label>
          )}
        </DateRange>
      )}
      {report?.body}
      {printing && report && (
        <PrintJob paper="A4" onDone={() => setPrinting(false)}>
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{settings.shop_name || "MedShop"} — {title}</div>
            <div>{tab === "stock" ? showDate(isoDate()) : `${showDate(from)} – ${showDate(to)}`}{settings.dl_no_20 ? ` · DL ${settings.dl_no_20}` : ""}{settings.gstin ? ` · GSTIN ${settings.gstin}` : ""}</div>
          </div>
          {report.body}
        </PrintJob>
      )}
    </div>
  );
}

type T = (k: StringKey, v?: Record<string, string | number>) => string;

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between border-b border-line py-2 last:border-0">
      <span>{label}</span>
      <span className={"num " + (strong ? "text-lg font-bold" : "")}>{value}</span>
    </div>
  );
}

async function build(tab: Tab, from: string, to: string, schedule: string, t: T): Promise<Report> {
  if (tab === "day") {
    const d = await ops.daySummary(from, to);
    return {
      body: (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <section className="rounded-xl border border-line bg-card p-4">
            <Stat label={t("billsCount")} value={String(d.bills)} />
            <Stat label={t("salesTotal")} value={formatPaise(d.total_paise)} strong />
            <Stat label={t("payCASH")} value={formatPaise(d.cash)} />
            <Stat label={t("payUPI")} value={formatPaise(d.upi)} />
            <Stat label={t("payCARD")} value={formatPaise(d.card)} />
            <Stat label={t("payCREDIT")} value={formatPaise(d.credit)} />
            <Stat label={t("discountL")} value={formatPaise(d.discount_paise)} />
            <Stat label={t("cancelledCount")} value={String(d.cancelled)} />
          </section>
          <section className="rounded-xl border border-line bg-card p-4">
            <Stat label={t("returnsL")} value={formatPaise(d.returns_paise)} />
            <Stat label={t("cashNet")} value={formatPaise(d.cash - d.returns_cash_paise + d.received_cash_paise - d.paid_cash_paise)} strong />
            <Stat label={t("receivedL")} value={formatPaise(d.received_paise)} />
            <Stat label={`${t("purchaseTotal")} (${d.purchases})`} value={formatPaise(d.purchase_paise)} />
            <Stat label={t("paidL")} value={formatPaise(d.paid_paise)} />
          </section>
        </div>
      ),
      csv: {
        name: `day-summary-${from}-to-${to}.csv`,
        header: ["Item", "Value"],
        rows: [["Bills", d.bills], ["Sales", rs(d.total_paise)], ["Cash", rs(d.cash)], ["UPI", rs(d.upi)], ["Card", rs(d.card)], ["Credit", rs(d.credit)],
          ["Discount", rs(d.discount_paise)], ["Cancelled bills", d.cancelled], ["Returns", rs(d.returns_paise)], ["Cash refunds", rs(d.returns_cash_paise)],
          ["Received from customers", rs(d.received_paise)], ["Purchases", rs(d.purchase_paise)], ["Paid to suppliers", rs(d.paid_paise)]],
      },
    };
  }

  if (tab === "sales") {
    const rows = (await ops.listSales(from, to, "")).reverse();
    const act = rows.filter((r) => r.status === "ACTIVE");
    const sum = (k: "taxable_paise" | "gst_paise" | "total_paise") => act.reduce((s, r) => s + r[k], 0);
    return {
      body: (
        <Table head={[t("colBillNo"), t("colDate"), t("colCustomer"), t("colMode"), t("taxable"), t("gstAmount"), t("total")]} rightCols={[4, 5, 6]} empty={rows.length ? undefined : t("noBills")}
          foot={<tr><td className={td} colSpan={4}>{t("total")} ({act.length})</td><td className={tdR}>{formatPaise(sum("taxable_paise"))}</td><td className={tdR}>{formatPaise(sum("gst_paise"))}</td><td className={tdR}>{formatPaise(sum("total_paise"))}</td></tr>}>
          {rows.map((r) => (
            <tr key={r.id} className={"border-t border-line " + (r.status === "CANCELLED" ? "text-ink-soft line-through" : "")}>
              <td className={td + " font-mono"}>{r.bill_no}</td>
              <td className={td + " num"}>{showDate(r.bill_date)}</td>
              <td className={td}>{r.customer_name}</td>
              <td className={td}>{t(`pay${r.payment_mode}` as StringKey)}</td>
              <td className={tdR}>{formatPaise(r.taxable_paise)}</td>
              <td className={tdR}>{formatPaise(r.gst_paise)}</td>
              <td className={tdR}>{formatPaise(r.total_paise)}</td>
            </tr>
          ))}
        </Table>
      ),
      csv: { name: `sales-${from}-to-${to}.csv`, header: ["Bill no", "Date", "Customer", "Payment", "Taxable", "GST", "Total", "Status"],
        rows: rows.map((r) => [r.bill_no, r.bill_date, r.customer_name, r.payment_mode, rs(r.taxable_paise), rs(r.gst_paise), rs(r.total_paise), r.status]) },
    };
  }

  if (tab === "purchases") {
    const rows = (await ops.listPurchases(from, to, "")).reverse();
    const act = rows.filter((r) => r.status === "ACTIVE");
    const sum = (k: "taxable_paise" | "gst_paise" | "total_paise") => act.reduce((s, r) => s + r[k], 0);
    return {
      body: (
        <Table head={[t("colDate"), t("supplier"), t("colSupplierBill"), t("taxable"), t("gstAmount"), t("total")]} rightCols={[3, 4, 5]} empty={rows.length ? undefined : t("noPurchases")}
          foot={<tr><td className={td} colSpan={3}>{t("total")} ({act.length})</td><td className={tdR}>{formatPaise(sum("taxable_paise"))}</td><td className={tdR}>{formatPaise(sum("gst_paise"))}</td><td className={tdR}>{formatPaise(sum("total_paise"))}</td></tr>}>
          {rows.map((r) => (
            <tr key={r.id} className={"border-t border-line " + (r.status === "CANCELLED" ? "text-ink-soft line-through" : "")}>
              <td className={td + " num"}>{showDate(r.bill_date)}</td>
              <td className={td}>{r.supplier_name}</td>
              <td className={td + " font-mono"}>{r.supplier_bill_no}</td>
              <td className={tdR}>{formatPaise(r.taxable_paise)}</td>
              <td className={tdR}>{formatPaise(r.gst_paise)}</td>
              <td className={tdR}>{formatPaise(r.total_paise)}</td>
            </tr>
          ))}
        </Table>
      ),
      csv: { name: `purchases-${from}-to-${to}.csv`, header: ["Date", "Supplier", "Bill no", "Taxable", "GST", "Total", "Status"],
        rows: rows.map((r) => [r.bill_date, r.supplier_name, r.supplier_bill_no, rs(r.taxable_paise), rs(r.gst_paise), rs(r.total_paise), r.status]) },
    };
  }

  if (tab === "gst") {
    const [g, hsn] = await Promise.all([ops.gstSummary(from, to), ops.hsnSummary(from, to)]);
    const rates = [...new Set([...g.sales, ...g.returns].map((r) => r.gst_rate_bp))].sort((a, b) => a - b);
    const find = (list: ops.GstRow[], bp: number) => list.find((r) => r.gst_rate_bp === bp) ?? { gst_rate_bp: bp, taxable_paise: 0, gst_paise: 0 };
    const net = rates.map((bp) => {
      const s = find(g.sales, bp), r = find(g.returns, bp);
      return { gst_rate_bp: bp, taxable_paise: s.taxable_paise - r.taxable_paise, gst_paise: s.gst_paise - r.gst_paise };
    });
    const gstTable = (rows: ops.GstRow[]) => {
      const tt = rows.reduce((a, r) => ({ tx: a.tx + r.taxable_paise, g: a.g + r.gst_paise }), { tx: 0, g: 0 });
      return (
        <Table head={[t("rate"), t("taxable"), t("cgst"), t("sgst"), t("gstAmount")]} rightCols={[1, 2, 3, 4]} empty={rows.length ? undefined : t("nothingHere")}
          foot={<tr><td className={td}>{t("total")}</td><td className={tdR}>{formatPaise(tt.tx)}</td><td className={tdR}>{formatPaise(splitCgstSgst(tt.g).cgst)}</td><td className={tdR}>{formatPaise(splitCgstSgst(tt.g).sgst)}</td><td className={tdR}>{formatPaise(tt.g)}</td></tr>}>
          {rows.map((r) => {
            const c = splitCgstSgst(r.gst_paise);
            return <tr key={r.gst_rate_bp} className="border-t border-line"><td className={td}>{r.gst_rate_bp / 100}%</td><td className={tdR}>{formatPaise(r.taxable_paise)}</td><td className={tdR}>{formatPaise(c.cgst)}</td><td className={tdR}>{formatPaise(c.sgst)}</td><td className={tdR}>{formatPaise(r.gst_paise)}</td></tr>;
          })}
        </Table>
      );
    };
    return {
      body: (
        <div className="space-y-5">
          <p className="text-sm text-ink-soft">{t("gstNote")}</p>
          <section><h3 className="mb-2 font-semibold">{t("outward")} — {t("netOfReturns")}</h3>{gstTable(net)}</section>
          {g.returns.length > 0 && <section><h3 className="mb-2 font-semibold">{t("returnsL")}</h3>{gstTable(g.returns)}</section>}
          <section><h3 className="mb-2 font-semibold">{t("inward")}</h3>{gstTable(g.purchases)}</section>
          <section>
            <h3 className="mb-2 font-semibold">{t("hsnTitle")}</h3>
            <Table head={["HSN", t("rate"), t("qty"), t("taxable"), t("gstAmount"), t("total")]} rightCols={[1, 2, 3, 4, 5]} empty={hsn.length ? undefined : t("nothingHere")}>
              {hsn.map((h, i) => <tr key={i} className="border-t border-line"><td className={td + " font-mono"}>{h.hsn || "—"}</td><td className={tdR}>{h.gst_rate_bp / 100}%</td><td className={tdR}>{h.qty_units}</td><td className={tdR}>{formatPaise(h.taxable_paise)}</td><td className={tdR}>{formatPaise(h.gst_paise)}</td><td className={tdR}>{formatPaise(h.total_paise)}</td></tr>)}
            </Table>
          </section>
        </div>
      ),
      csv: {
        name: `gst-${from}-to-${to}.csv`,
        header: ["Section", "HSN", "GST %", "Qty units", "Taxable", "CGST", "SGST", "Total GST"],
        rows: [
          ...net.map((r) => ["Sales (net of returns)", "", r.gst_rate_bp / 100, "", rs(r.taxable_paise), rs(splitCgstSgst(r.gst_paise).cgst), rs(splitCgstSgst(r.gst_paise).sgst), rs(r.gst_paise)]),
          ...g.returns.map((r) => ["Sales returns", "", r.gst_rate_bp / 100, "", rs(r.taxable_paise), rs(splitCgstSgst(r.gst_paise).cgst), rs(splitCgstSgst(r.gst_paise).sgst), rs(r.gst_paise)]),
          ...g.purchases.map((r) => ["Purchases (ITC)", "", r.gst_rate_bp / 100, "", rs(r.taxable_paise), rs(splitCgstSgst(r.gst_paise).cgst), rs(splitCgstSgst(r.gst_paise).sgst), rs(r.gst_paise)]),
          ...hsn.map((h) => ["HSN summary", h.hsn, h.gst_rate_bp / 100, h.qty_units, rs(h.taxable_paise), rs(splitCgstSgst(h.gst_paise).cgst), rs(splitCgstSgst(h.gst_paise).sgst), rs(h.gst_paise)]),
        ],
      },
    };
  }

  if (tab === "register") {
    const rows = await ops.scheduleRegister(from, to, schedule);
    return {
      body: (
        <Table head={[t("colDate"), t("colBillNo"), t("colMedicine"), t("colBatch"), t("qty"), t("fPrescriber"), t("fPatient")]} rightCols={[4]} empty={rows.length ? undefined : t("nothingHere")}>
          {rows.map((r, i) => (
            <tr key={i} className={"border-t border-line align-top " + (r.status === "CANCELLED" ? "text-ink-soft line-through" : "")}>
              <td className={td + " num"}>{showDate(r.entry_date)}</td>
              <td className={td + " font-mono text-sm"}>{r.bill_no}</td>
              <td className={td}>{r.item_name} <span className="text-xs text-bad">{r.schedule}</span></td>
              <td className={td + " font-mono"}>{r.batch_no}</td>
              <td className={tdR}>{r.qty_units}</td>
              <td className={td + " text-sm"}>{r.prescriber_name}<div className="text-ink-soft">{r.prescriber_address}</div></td>
              <td className={td + " text-sm"}>{r.patient_name}<div className="text-ink-soft">{r.patient_address}</div></td>
            </tr>
          ))}
        </Table>
      ),
      csv: { name: `schedule-register-${from}-to-${to}.csv`, header: ["Date", "Bill no", "Medicine", "Schedule", "Batch", "Qty units", "Doctor", "Doctor address", "Patient", "Patient address", "Rx no", "Bill status"],
        rows: rows.map((r) => [r.entry_date, r.bill_no, r.item_name, r.schedule, r.batch_no, r.qty_units, r.prescriber_name, r.prescriber_address, r.patient_name, r.patient_address, r.rx_no, r.status]) },
    };
  }

  const v = await ops.stockValue(isoDate());
  return {
    body: (
      <section className="max-w-xl rounded-xl border border-line bg-card p-4">
        <Stat label={t("medicines")} value={String(v?.items ?? 0)} />
        <Stat label={t("batchesTitle")} value={String(v?.batches ?? 0)} />
        <Stat label={t("mrpValue")} value={formatPaise(v?.mrp_paise ?? 0)} />
        <Stat label={t("costValue")} value={formatPaise(v?.cost_paise ?? 0)} strong />
        <Stat label={t("expiredValue")} value={formatPaise(v?.expired_cost_paise ?? 0)} />
      </section>
    ),
    csv: { name: `stock-value-${isoDate()}.csv`, header: ["Item", "Value"],
      rows: [["Medicines", v?.items ?? 0], ["Batches", v?.batches ?? 0], ["At MRP", rs(v?.mrp_paise ?? 0)], ["At purchase rate", rs(v?.cost_paise ?? 0)], ["Expired (purchase rate)", rs(v?.expired_cost_paise ?? 0)]] },
  };
}
