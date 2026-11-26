import { useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "../i18n/I18nProvider";
import { nearDaysOf, useSettings } from "../app/SettingsContext";
import { hasDatabase } from "../db";
import { expiringBatches, supplierList, type StockBatchRow, type SupplierLite } from "../db/ops";
import { dbErrorKey } from "../db/errors";
import { formatPaise } from "../lib/money";
import { formatExpiry, formatQty, isoDate } from "../lib/stock";
import { outValue, planStockOut } from "../lib/ops/stockOps";
import { downloadCsv, rs } from "../lib/csv";
import { Banner, Button, PageHeader, Select, TextInput } from "../components/Form";
import { Table, td, tdR } from "../components/ListTools";
import { PrintJob } from "../components/Print";

export function ExpiryPage() {
  const { t } = useT();
  const { settings } = useSettings();
  const days = nearDaysOf(settings);
  const today = isoDate();
  const until = isoDate(new Date(Date.now() + days * 86_400_000));
  const [rows, setRows] = useState<StockBatchRow[]>([]);
  const [tab, setTab] = useState<"expired" | "near">("expired");
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [suppliers, setSuppliers] = useState<SupplierLite[]>([]);
  const [action, setAction] = useState<null | "EXPIRY_RETURN" | "BREAKAGE">(null);
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [claim, setClaim] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [printing, setPrinting] = useState(false);

  const load = useCallback(() => {
    if (!hasDatabase()) return;
    expiringBatches(until).then(setRows).catch(() => {});
    supplierList().then(setSuppliers).catch(() => {});
  }, [until]);
  useEffect(load, [load]);

  const expired = rows.filter((r) => r.expiry < today);
  const near = rows.filter((r) => r.expiry >= today);
  const shown = tab === "expired" ? expired : near;
  const chosen = useMemo(() => rows.filter((r) => sel.has(r.batch_id)), [rows, sel]);
  const value = (r: StockBatchRow) => outValue({ batchId: r.batch_id, qtyUnits: r.qty_units, ratePaise: r.purchase_rate_paise, packSize: r.pack_size });
  const chosenValue = chosen.reduce((s, r) => s + value(r), 0);

  function toggle(id: number) {
    const n = new Set(sel);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setSel(n);
  }

  function start(a: "EXPIRY_RETURN" | "BREAKAGE") {
    setAction(a);
    setClaim((chosenValue / 100).toFixed(2));
    // Suggest the supplier most of the selected batches came from.
    const counts = new Map<number, number>();
    for (const r of chosen) if (r.last_supplier_id) counts.set(r.last_supplier_id, (counts.get(r.last_supplier_id) ?? 0) + 1);
    setSupplierId([...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null);
  }

  async function confirm() {
    if (!action) return;
    try {
      await planStockOut({
        type: action, supplierId: action === "EXPIRY_RETURN" ? supplierId : null, note, today,
        claimPaise: action === "EXPIRY_RETURN" ? Math.round((Number(claim) || 0) * 100) : chosenValue,
        lines: chosen.map((r) => ({ batchId: r.batch_id, qtyUnits: r.qty_units, ratePaise: r.purchase_rate_paise, packSize: r.pack_size })),
      }).run();
      setMsg({ tone: "ok", text: t("stockOutSaved") });
      setSel(new Set());
      setAction(null);
      load();
    } catch (e) {
      const { key, raw } = dbErrorKey(e);
      setMsg({ tone: "bad", text: t(key, { msg: raw }) });
    }
  }

  const tabBtn = (k: "expired" | "near", label: string) => (
    <button type="button" role="tab" aria-selected={tab === k} onClick={() => { setTab(k); setSel(new Set()); }}
      className={"rounded-lg px-4 py-2 font-medium " + (tab === k ? "bg-brand text-white" : "border border-line bg-card hover:border-brand")}>
      {label}
    </button>
  );

  const table = (rowsToShow: StockBatchRow[], selectable: boolean) => (
    <Table head={[...(selectable ? [""] : []), t("colMedicine"), t("colBatch"), t("colExpiry"), t("colQty"), t("colMrp"), t("colValue"), t("colLastSupplier")]} rightCols={selectable ? [4, 5, 6] : [3, 4, 5]}
      empty={rowsToShow.length ? undefined : t("nothingHere")}>
      {rowsToShow.map((r) => (
        <tr key={r.batch_id} className="border-t border-line">
          {selectable && <td className="px-3"><input type="checkbox" aria-label={r.item_name} checked={sel.has(r.batch_id)} onChange={() => toggle(r.batch_id)} className="h-4 w-4" /></td>}
          <td className={td}><span className="font-medium">{r.item_name}</span> <span className="text-sm text-ink-soft">{r.company}</span></td>
          <td className={td + " font-mono"}>{r.batch_no}</td>
          <td className={td + " num " + (r.expiry < today ? "font-semibold text-bad" : "text-warn")}>{formatExpiry(r.expiry)}</td>
          <td className={tdR}>{formatQty(r.qty_units, r.pack_size, r.unit.toLowerCase())}</td>
          <td className={tdR}>{formatPaise(r.mrp_paise)}</td>
          <td className={tdR}>{formatPaise(value(r))}</td>
          <td className={td + " text-sm"}>{r.last_supplier ?? ""}</td>
        </tr>
      ))}
    </Table>
  );

  return (
    <div className="space-y-4">
      <PageHeader title={t("expiry")} actions={<>
        <Button onClick={() => setPrinting(true)}>{t("print")}</Button>
        <Button onClick={() => downloadCsv(`expiry-${today}.csv`, ["Medicine", "Company", "Batch", "Expiry", "Qty units", "MRP", "Value at cost", "Supplier"],
          shown.map((r) => [r.item_name, r.company, r.batch_no, r.expiry, r.qty_units, rs(r.mrp_paise), rs(value(r)), r.last_supplier]))}>{t("exportCsv")}</Button>
      </>} />
      <div className="flex gap-2" role="tablist">
        {tabBtn("expired", t("tabExpired", { n: expired.length }))}
        {tabBtn("near", t("tabNear", { d: days, n: near.length }))}
      </div>
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
      {chosen.length > 0 && (
        <section className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-card p-4">
          <span className="self-center font-medium">{t("selectedSummary", { n: chosen.length, amt: formatPaise(chosenValue) })}</span>
          {!action && <><Button kind="primary" onClick={() => start("EXPIRY_RETURN")}>{t("returnToSupplier")}</Button><Button onClick={() => start("BREAKAGE")}>{t("writeOff")}</Button></>}
          {action === "EXPIRY_RETURN" && (
            <>
              <label className="text-sm">{t("supplier")}
                <Select value={supplierId ?? ""} onChange={(e) => setSupplierId(Number(e.target.value) || null)} className="mt-1 w-64">
                  <option value="">{t("chooseSupplier")}</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </label>
              <label className="text-sm">{t("claimAmount")}
                <TextInput value={claim} onChange={(e) => setClaim(e.target.value.replace(/[^\d.]/g, ""))} className="mt-1 w-40" inputMode="decimal" />
              </label>
            </>
          )}
          {action && (
            <>
              <label className="text-sm">{t("note")}<TextInput value={note} onChange={(e) => setNote(e.target.value)} className="mt-1 w-56" /></label>
              <Button kind="primary" onClick={confirm} disabled={action === "EXPIRY_RETURN" && !supplierId}>{t("confirm")}</Button>
              <Button onClick={() => setAction(null)}>{t("close")}</Button>
            </>
          )}
        </section>
      )}
      {table(shown, true)}
      {printing && (
        <PrintJob paper="A4" onDone={() => setPrinting(false)}>
          <h2 style={{ fontSize: 16, fontWeight: 700 }}>{settings.shop_name} — {tab === "expired" ? t("tabExpired", { n: expired.length }) : t("tabNear", { d: days, n: near.length })}</h2>
          {table(shown, false)}
        </PrintJob>
      )}
    </div>
  );
}
