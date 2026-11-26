import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useT } from "../i18n/I18nProvider";
import type { StringKey } from "../i18n/strings";
import { useSettings } from "../app/SettingsContext";
import { hasDatabase } from "../db";
import { getSale } from "../db/ops";
import { dbErrorKey } from "../db/errors";
import { formatPaise } from "../lib/money";
import { formatExpiry, formatQty, isoDate } from "../lib/stock";
import { planCancelSale, planSaleReturn, refundFor, type PaymentMode } from "../lib/ops/sale";
import { Banner, Button, PageHeader, Select, TextInput } from "../components/Form";
import { Table, showDate, td, tdR } from "../components/ListTools";
import { PrintJob, type Paper } from "../components/Print";
import { BillPrint } from "../components/BillPrint";
import { ScheduleBadge } from "../components/ScheduleBadge";

type Bill = NonNullable<Awaited<ReturnType<typeof getSale>>>;

export function BillViewPage() {
  const { t } = useT();
  const { settings } = useSettings();
  const { id } = useParams();
  const saleId = Number(id);
  const [bill, setBill] = useState<Bill | null | undefined>(undefined);
  const [printing, setPrinting] = useState(false);
  const [mode, setMode] = useState<"view" | "cancel" | "return">("view");
  const [reason, setReason] = useState("");
  const [retQty, setRetQty] = useState<Record<number, number>>({});
  const [refundMode, setRefundMode] = useState<PaymentMode>("CASH");
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const paper = (settings.paper || "80mm") as Paper;

  const load = useCallback(() => {
    if (hasDatabase()) getSale(saleId).then(setBill).catch(() => setBill(null));
  }, [saleId]);
  useEffect(load, [load]);

  if (bill === undefined) return <p className="text-ink-soft">{t("loading")}</p>;
  if (bill === null) return <p>{t("notFound")}</p>;
  const h = bill.header;
  const active = h.status === "ACTIVE";
  const hasReturns = h.returned_paise > 0;

  async function run(batch: { run: () => Promise<unknown> }, ok: string) {
    setMsg(null);
    try {
      await batch.run();
      setMsg({ tone: "ok", text: ok });
      setMode("view");
      setRetQty({});
      load();
    } catch (e) {
      const { key, raw } = dbErrorKey(e);
      setMsg({ tone: "bad", text: t(key, { msg: raw }) });
    }
  }

  const retLines = bill.lines
    .filter((l) => (retQty[l.id] ?? 0) > 0)
    .map((l) => ({ batchId: l.batch_id, qtyUnits: retQty[l.id], ratePaise: l.rate_paise, amountPaise: refundFor(l.qty_units, l.amount_paise, retQty[l.id]) }));
  const refundTotal = retLines.reduce((s, l) => s + l.amountPaise, 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title={`${t("billNo")} ${h.bill_no}`}
        sub={`${showDate(h.bill_date)} ${h.bill_time.slice(0, 5)} · ${t(`pay${h.payment_mode}` as StringKey)}${h.customer_name ? " · " + h.customer_name : ""}`}
        actions={
          <>
            <Button onClick={() => setPrinting(true)}>{t("print")}</Button>
            {active && <Button onClick={() => setMode(mode === "return" ? "view" : "return")}>{t("returnItems")}</Button>}
            {active && <Button onClick={() => setMode(mode === "cancel" ? "view" : "cancel")}>{t("cancelBill")}</Button>}
          </>
        }
      />
      {!active && <Banner tone="bad">{t("statusCancelled")}{h.cancel_reason ? ` — ${h.cancel_reason}` : ""}</Banner>}
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

      {mode === "cancel" && (
        <section className="space-y-3 rounded-xl border border-bad/30 bg-card p-4">
          {hasReturns ? (
            <p className="text-bad">{t("cancelNotAllowed")}</p>
          ) : (
            <>
              <p>{t("cancelConfirm")}</p>
              <TextInput aria-label={t("reason")} placeholder={t("reason")} value={reason} onChange={(e) => setReason(e.target.value)} />
              <div className="flex gap-2">
                <Button kind="primary" onClick={() => run(planCancelSale({ saleId, reason, today: isoDate(), creditCustomerId: h.payment_mode === "CREDIT" ? h.customer_id : null, totalPaise: h.total_paise }), t("done"))}>
                  {t("yesCancel")}
                </Button>
                <Button onClick={() => setMode("view")}>{t("close")}</Button>
              </div>
            </>
          )}
        </section>
      )}

      <Table head={[t("colMedicine"), t("colBatchExp"), mode === "return" ? t("soldUnits") : t("qty"), t("colMrp"), t("colDisc"), t("colAmount"), ...(mode === "return" ? [t("returnQty")] : [])]} rightCols={[2, 3, 4, 5]}>
        {bill.lines.map((l) => {
          const left = l.qty_units - l.returned_units;
          return (
            <tr key={l.id} className="border-t border-line">
              <td className={td}>
                <span className="font-medium">{l.item_name}</span>
                <ScheduleBadge schedule={l.schedule} />
                {l.returned_units > 0 && <span className="ml-2 text-sm text-warn">{t("alreadyReturned", { n: formatQty(l.returned_units, l.pack_size, l.unit.toLowerCase()) })}</span>}
              </td>
              <td className={td + " num"}>{l.batch_no} · {formatExpiry(l.expiry)}</td>
              <td className={tdR}>{mode === "return" ? `${l.qty_units} ${l.unit.toLowerCase()}` : formatQty(l.qty_units, l.pack_size, l.unit.toLowerCase())}</td>
              <td className={tdR}>{formatPaise(l.mrp_paise)}</td>
              <td className={tdR}>{l.discount_bp ? `${l.discount_bp / 100}%` : ""}</td>
              <td className={tdR}>{formatPaise(l.amount_paise)}</td>
              {mode === "return" && (
                <td className="px-3 py-1.5">
                  <input aria-label={`${t("returnQty")} ${l.item_name}`} inputMode="numeric" disabled={left <= 0} value={retQty[l.id] ?? ""}
                    onChange={(e) => setRetQty({ ...retQty, [l.id]: Math.min(left, Math.max(0, Number(e.target.value.replace(/\D/g, "")) || 0)) })}
                    className="h-9 w-24 rounded-md border border-line px-2 text-right num disabled:bg-paper" placeholder={`≤ ${left}`} />
                </td>
              )}
            </tr>
          );
        })}
      </Table>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <dl className="num min-w-64 rounded-xl border border-line bg-card p-4">
          {h.discount_paise > 0 && <div className="flex justify-between"><dt>{t("discountL")}</dt><dd>− {formatPaise(h.discount_paise)}</dd></div>}
          <div className="flex justify-between text-sm text-ink-soft"><dt>{t("gstIncluded")}</dt><dd>{formatPaise(h.gst_paise)}</dd></div>
          <div className="flex justify-between text-lg font-bold"><dt>{t("total")}</dt><dd>{formatPaise(h.total_paise)}</dd></div>
          {hasReturns && <div className="flex justify-between text-warn"><dt>{t("returnsL")}</dt><dd>− {formatPaise(h.returned_paise)}</dd></div>}
        </dl>
        {bill.rx && (
          <div className="rounded-xl border border-line bg-card p-4 text-sm">
            <div className="font-semibold">Rx · {bill.rx.schedule}</div>
            <div>{t("fPrescriber")}: {bill.rx.prescriber_name}, {bill.rx.prescriber_address}</div>
            <div>{t("fPatient")}: {bill.rx.patient_name}, {bill.rx.patient_address}</div>
          </div>
        )}
        {mode === "return" && (
          <section className="space-y-3 rounded-xl border border-warn/30 bg-card p-4">
            <label className="flex items-center gap-2 text-sm">
              {t("refundMode")}
              <Select value={refundMode} onChange={(e) => setRefundMode(e.target.value as PaymentMode)} className="w-64">
                <option value="CASH">{t("payCASH")}</option>
                <option value="UPI">{t("payUPI")}</option>
                {h.customer_id && <option value="CREDIT">{t("refundCredit")}</option>}
              </Select>
            </label>
            <Button kind="primary" disabled={retLines.length === 0}
              onClick={() => run(planSaleReturn({ saleId, customerId: h.customer_id, lines: retLines, refundMode, note: "", today: isoDate() }), t("returnSaved"))}>
              {t("doReturn", { amt: formatPaise(refundTotal) })}
            </Button>
          </section>
        )}
      </div>

      {printing && (
        <PrintJob paper={paper} onDone={() => setPrinting(false)}>
          <BillPrint header={h} lines={bill.lines} rx={bill.rx} settings={settings} paper={paper} />
        </PrintJob>
      )}
    </div>
  );
}
