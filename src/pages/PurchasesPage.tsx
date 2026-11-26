import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useT } from "../i18n/I18nProvider";
import { hasDatabase } from "../db";
import { getPurchase, listPurchases, type PurchaseHeader } from "../db/ops";
import { dbErrorKey } from "../db/errors";
import { formatPaise } from "../lib/money";
import { formatExpiry, isoDate } from "../lib/stock";
import { fyRange } from "../lib/ops/fy";
import { downloadCsv, rs } from "../lib/csv";
import { planCancelPurchase } from "../lib/ops/purchase";
import { Banner, Button, PageHeader, TextInput, inputCls } from "../components/Form";
import { DateRange, Table, showDate, td, tdR } from "../components/ListTools";

export function PurchasesPage() {
  const { t } = useT();
  const navigate = useNavigate();
  const [from, setFrom] = useState(() => isoDate(new Date(Date.now() - 30 * 86_400_000)));
  const [to, setTo] = useState(isoDate());
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<PurchaseHeader[]>([]);

  useEffect(() => {
    if (!hasDatabase()) return;
    const h = setTimeout(() => listPurchases(from, to, q).then(setRows).catch(() => {}), q ? 150 : 0);
    return () => clearTimeout(h);
  }, [from, to, q]);

  const active = rows.filter((r) => r.status === "ACTIVE");
  return (
    <div className="space-y-4">
      <PageHeader title={t("purchases")} sub={`${active.length} · ${formatPaise(active.reduce((s, r) => s + r.total_paise, 0))}`}
        actions={<>
          <Button onClick={() => downloadCsv(`purchases-${from}-to-${to}.csv`, ["Supplier", "Bill no", "Bill date", "Taxable", "GST", "Total", "Status"], rows.map((r) => [r.supplier_name, r.supplier_bill_no, r.bill_date, rs(r.taxable_paise), rs(r.gst_paise), rs(r.total_paise), r.status]))}>{t("exportCsv")}</Button>
          <Button kind="primary" onClick={() => navigate("/purchase")} kbd="F3">{t("purchase")}</Button>
        </>} />
      <DateRange from={from} to={to} onChange={(f, tt) => { setFrom(f); setTo(tt); }}>
        <button type="button" className="h-10 rounded-lg border border-line px-3 text-sm hover:border-brand" onClick={() => { const r = fyRange(isoDate()); setFrom(r.from); setTo(r.to); }}>FY</button>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`${t("supplier")} / ${t("colSupplierBill")}`} aria-label={t("supplier")} className={inputCls + " w-64"} />
      </DateRange>
      <Table head={[t("colDate"), t("supplier"), t("colSupplierBill"), t("taxable"), t("gstAmount"), t("total"), ""]} rightCols={[3, 4, 5]} empty={rows.length ? undefined : t("noPurchases")}>
        {rows.map((r) => (
          <tr key={r.id} onClick={() => navigate(`/purchases/${r.id}`)} className={"cursor-pointer border-t border-line hover:bg-paper " + (r.status === "CANCELLED" ? "text-ink-soft line-through" : "")}>
            <td className={td + " num"}>{showDate(r.bill_date)}</td>
            <td className={td}>{r.supplier_name}</td>
            <td className={td + " font-mono"}>{r.supplier_bill_no}</td>
            <td className={tdR}>{formatPaise(r.taxable_paise)}</td>
            <td className={tdR}>{formatPaise(r.gst_paise)}</td>
            <td className={tdR + " font-medium"}>{formatPaise(r.total_paise)}</td>
            <td className={td + " text-sm"}>{r.status === "CANCELLED" && <span className="rounded bg-bad-soft px-2 py-0.5 text-bad no-underline">{t("statusCancelled")}</span>}</td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

type P = NonNullable<Awaited<ReturnType<typeof getPurchase>>>;

export function PurchaseViewPage() {
  const { t } = useT();
  const { id } = useParams();
  const pid = Number(id);
  const [data, setData] = useState<P | null | undefined>(undefined);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const load = useCallback(() => {
    if (hasDatabase()) getPurchase(pid).then(setData).catch(() => setData(null));
  }, [pid]);
  useEffect(load, [load]);

  if (data === undefined) return <p className="text-ink-soft">{t("loading")}</p>;
  if (data === null) return <p>{t("notFound")}</p>;
  const h = data.header;

  async function cancel() {
    try {
      await planCancelPurchase({ purchaseId: pid, reason, today: isoDate() }).run();
      setMsg({ tone: "ok", text: t("done") });
      setCancelling(false);
      load();
    } catch (e) {
      const { key, raw } = dbErrorKey(e);
      setMsg({ tone: "bad", text: key === "errStockNegative" ? t("errStockSold") : t(key, { msg: raw }) });
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader title={`${h.supplier_name} · ${h.supplier_bill_no}`} sub={`${showDate(h.bill_date)}${h.note ? " · " + h.note : ""}`}
        actions={h.status === "ACTIVE" ? <Button onClick={() => setCancelling(!cancelling)}>{t("cancelPurchase")}</Button> : undefined} />
      {h.status === "CANCELLED" && <Banner tone="bad">{t("statusCancelled")}{h.cancel_reason ? ` — ${h.cancel_reason}` : ""}</Banner>}
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
      {cancelling && (
        <section className="space-y-3 rounded-xl border border-bad/30 bg-card p-4">
          <p>{t("cancelPurchaseConfirm")}</p>
          <TextInput aria-label={t("reason")} placeholder={t("reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex gap-2"><Button kind="primary" onClick={cancel}>{t("yesCancel")}</Button><Button onClick={() => setCancelling(false)}>{t("close")}</Button></div>
        </section>
      )}
      <Table head={[t("colMedicine"), t("fBatch"), t("fExpiry"), t("colStrips"), t("colFree"), t("colPRate"), t("colMrp"), t("colDisc"), t("colGst"), t("taxable")]} rightCols={[3, 4, 5, 6, 7, 8, 9]}>
        {data.lines.map((l, i) => (
          <tr key={i} className="border-t border-line">
            <td className={td + " font-medium"}>{l.item_name}</td>
            <td className={td + " font-mono"}>{l.batch_no}</td>
            <td className={td + " num"}>{formatExpiry(l.expiry)}</td>
            <td className={tdR}>{l.qty_units / l.pack_size}</td>
            <td className={tdR}>{l.free_units ? l.free_units / l.pack_size : ""}</td>
            <td className={tdR}>{formatPaise(l.rate_paise)}</td>
            <td className={tdR}>{formatPaise(l.mrp_paise)}</td>
            <td className={tdR}>{l.discount_bp ? `${l.discount_bp / 100}%` : ""}</td>
            <td className={tdR}>{l.gst_rate_bp / 100}%</td>
            <td className={tdR}>{formatPaise(l.taxable_paise)}</td>
          </tr>
        ))}
      </Table>
      <dl className="num ml-auto w-72 space-y-1 rounded-xl border border-line bg-card p-4">
        <div className="flex justify-between"><dt>{t("taxable")}</dt><dd>{formatPaise(h.taxable_paise)}</dd></div>
        <div className="flex justify-between"><dt>{t("gstAmount")}</dt><dd>{formatPaise(h.gst_paise)}</dd></div>
        <div className="flex justify-between text-lg font-bold"><dt>{t("total")}</dt><dd>{formatPaise(h.total_paise)}</dd></div>
      </dl>
    </div>
  );
}
