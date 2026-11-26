import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useT } from "../i18n/I18nProvider";
import type { StringKey } from "../i18n/strings";
import { hasDatabase } from "../db";
import { listSales, type SaleHeader } from "../db/ops";
import { formatPaise } from "../lib/money";
import { isoDate } from "../lib/stock";
import { downloadCsv, rs } from "../lib/csv";
import { SEARCH_EVENT } from "../hooks/useShortcuts";
import { Button, PageHeader, inputCls } from "../components/Form";
import { DateRange, Table, showDate, td, tdR } from "../components/ListTools";

export function BillsPage() {
  const { t } = useT();
  const navigate = useNavigate();
  const [from, setFrom] = useState(isoDate());
  const [to, setTo] = useState(isoDate());
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<SaleHeader[]>([]);

  useEffect(() => {
    if (!hasDatabase()) return;
    const h = setTimeout(() => listSales(from, to, q).then(setRows).catch(() => {}), q ? 150 : 0);
    return () => clearTimeout(h);
  }, [from, to, q]);

  useEffect(() => {
    const f = () => document.getElementById("bills-q")?.focus();
    window.addEventListener(SEARCH_EVENT, f);
    return () => window.removeEventListener(SEARCH_EVENT, f);
  }, []);

  const active = rows.filter((r) => r.status === "ACTIVE");
  const sum = active.reduce((s, r) => s + r.total_paise, 0);

  function exportCsv() {
    downloadCsv(`bills-${from}-to-${to}.csv`, ["Bill no", "Date", "Time", "Customer", "Phone", "Payment", "Taxable", "GST", "Discount", "Total", "Returned", "Status"],
      rows.map((r) => [r.bill_no, r.bill_date, r.bill_time, r.customer_name, r.customer_phone, r.payment_mode, rs(r.taxable_paise), rs(r.gst_paise), rs(r.discount_paise), rs(r.total_paise), rs(r.returned_paise), r.status]));
  }

  return (
    <div className="space-y-4">
      <PageHeader title={t("bills")} sub={`${active.length} · ${formatPaise(sum)}`}
        actions={<><Button onClick={exportCsv}>{t("exportCsv")}</Button><Button kind="primary" onClick={() => navigate("/bill")} kbd="F2">{t("newBill")}</Button></>} />
      <DateRange from={from} to={to} onChange={(f, tt) => { setFrom(f); setTo(tt); }}>
        <input id="bills-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("searchBills")} aria-label={t("searchBills")} className={inputCls + " w-72"} />
      </DateRange>
      <Table head={[t("colBillNo"), t("colDate"), t("colCustomer"), t("colMode"), t("colTotal"), ""]} rightCols={[4]} empty={rows.length ? undefined : t("noBills")}>
        {rows.map((r) => (
          <tr key={r.id} className={"cursor-pointer border-t border-line hover:bg-paper " + (r.status === "CANCELLED" ? "text-ink-soft line-through" : "")} onClick={() => navigate(`/bills/${r.id}`)}>
            <td className={td + " font-mono"}><Link to={`/bills/${r.id}`} className="text-brand no-underline">{r.bill_no}</Link></td>
            <td className={td + " num"}>{showDate(r.bill_date)} {r.bill_time.slice(0, 5)}</td>
            <td className={td}>{[r.customer_name, r.customer_phone].filter(Boolean).join(" · ")}</td>
            <td className={td}>{t(`pay${r.payment_mode}` as StringKey)}</td>
            <td className={tdR}>{formatPaise(r.total_paise)}</td>
            <td className={td + " text-sm no-underline"}>
              {r.status === "CANCELLED" && <span className="rounded bg-bad-soft px-2 py-0.5 text-bad">{t("statusCancelled")}</span>}
              {r.returned_paise > 0 && <span className="rounded bg-warn-soft px-2 py-0.5 text-warn">{t("returnedAmt", { amt: formatPaise(r.returned_paise) })}</span>}
            </td>
          </tr>
        ))}
      </Table>
    </div>
  );
}
