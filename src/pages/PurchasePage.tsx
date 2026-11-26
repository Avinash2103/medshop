import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useT } from "../i18n/I18nProvider";
import type { StringKey } from "../i18n/strings";
import { hasDatabase } from "../db";
import { searchItems } from "../db/repo";
import { itemBasics, lastPurchase, latestBatch, supplierList, type SupplierLite } from "../db/ops";
import type { ItemSearchRow } from "../db/types";
import { dbErrorKey } from "../db/errors";
import { formatPaise } from "../lib/money";
import { isoDate } from "../lib/stock";
import { gstLabel, GST_RATES_BP } from "../lib/gst";
import { expiry as parseExpiry } from "../lib/importer/values";
import { checkPurchase, planPurchase, purchaseTotals, type PurchaseLine, type PurchaseProblem } from "../lib/ops/purchase";
import { setLeaveGuard } from "../hooks/leaveGuard";
import { SEARCH_EVENT } from "../hooks/useShortcuts";
import { Banner, Button, Field, PageHeader, Select, TextInput, inputCls } from "../components/Form";
import { SearchIcon } from "../components/Icons";
import { showDate } from "../components/ListTools";

/** One grid row as typed (text), turned into numbers for totals and saving. */
interface Row {
  key: string;
  itemId: number;
  name: string;
  packSize: number;
  gstBp: number;
  batch: string;
  exp: string;
  packs: string;
  free: string;
  rate: string;
  mrp: string;
  sale: string;
  disc: string;
  last: { rate_paise: number; mrp_paise: number; bill_date: string; supplier: string } | null;
}

const p100 = (s: string) => Math.round((Number(s.replace(/[^\d.]/g, "")) || 0) * 100);
const int = (s: string) => Math.floor(Number(s.replace(/\D/g, "")) || 0);

function toLine(r: Row): PurchaseLine {
  const e = parseExpiry(r.exp);
  const mrp = p100(r.mrp);
  return {
    key: r.key, itemId: r.itemId, name: r.name, packSize: r.packSize, gstBp: r.gstBp, batchNo: r.batch.trim(),
    expiry: e && "value" in e ? e.value : "", mrpPaise: mrp, ratePaise: p100(r.rate), salePaise: r.sale.trim() ? p100(r.sale) : mrp,
    qtyUnits: int(r.packs) * r.packSize, freeUnits: int(r.free) * r.packSize, discountBp: Math.round(Math.min(100, Number(r.disc) || 0) * 100),
  };
}

export function PurchasePage() {
  const { t } = useT();
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLTableSectionElement>(null);
  const [suppliers, setSuppliers] = useState<SupplierLite[]>([]);
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [billNo, setBillNo] = useState("");
  const [billDate, setBillDate] = useState(isoDate());
  const [note, setNote] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ItemSearchRow[]>([]);
  const [hitIdx, setHitIdx] = useState(0);
  const [problems, setProblems] = useState<PurchaseProblem[]>([]);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad" | "warn"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (hasDatabase()) supplierList().then(setSuppliers).catch(() => {});
    const f = () => searchRef.current?.focus();
    window.addEventListener(SEARCH_EVENT, f);
    return () => window.removeEventListener(SEARCH_EVENT, f);
  }, []);

  useEffect(() => {
    if (rows.length === 0) return setLeaveGuard(null);
    let warned = false;
    setLeaveGuard(() => {
      if (warned) return true;
      warned = true;
      setMsg({ tone: "warn", text: t("unsavedWarn") });
      return false;
    });
    return () => setLeaveGuard(null);
  }, [rows.length, t]);

  useEffect(() => {
    if (!hasDatabase() || !q.trim()) return setHits([]);
    const h = setTimeout(() => searchItems(q, 12).then((r) => { setHits(r); setHitIdx(0); }), 100);
    return () => clearTimeout(h);
  }, [q]);

  const lines = useMemo(() => rows.map(toLine), [rows]);
  const totals = useMemo(() => purchaseTotals(lines), [lines]);

  // Focus a grid cell once its row is on screen.
  const pendingFocus = useRef<{ key: string; f: string } | null>(null);
  useEffect(() => {
    const p = pendingFocus.current;
    if (!p) return;
    const el = gridRef.current?.querySelector<HTMLInputElement>(`[data-row="${p.key}"][data-f="${p.f}"]`);
    if (el) {
      el.focus();
      pendingFocus.current = null;
    }
  }, [rows]);

  async function add(hit: ItemSearchRow) {
    const [item, last, latest] = await Promise.all([itemBasics(hit.id), lastPurchase(hit.id), latestBatch(hit.id)]);
    if (!item) return;
    const key = `${hit.id}-${Date.now()}`;
    const rate = last?.rate_paise ?? latest?.purchase_rate_paise ?? 0;
    const mrp = last?.mrp_paise ?? latest?.mrp_paise ?? 0;
    pendingFocus.current = { key, f: "batch" };
    setRows((rs) => [...rs, {
      key, itemId: item.id, name: item.name, packSize: item.pack_size, gstBp: item.gst_rate_bp, batch: "", exp: "", packs: "", free: "",
      rate: rate ? (rate / 100).toFixed(2) : "", mrp: mrp ? (mrp / 100).toFixed(2) : "", sale: "", disc: "", last,
    }]);
    setQ("");
    setHits([]);
  }

  const set = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  function cellKey(e: KeyboardEvent<HTMLInputElement | HTMLSelectElement>, r: Row, field: string) {
    if (e.key === "Delete" && e.ctrlKey) {
      e.preventDefault();
      setRows((rs) => rs.filter((x) => x.key !== r.key));
      searchRef.current?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const order = ["batch", "exp", "packs", "free", "rate", "mrp", "sale", "disc"];
      const next = order[order.indexOf(field) + 1];
      const el = next ? gridRef.current?.querySelector<HTMLInputElement>(`[data-row="${r.key}"][data-f="${next}"]`) : null;
      if (el) {
        el.focus();
        el.select();
      }
      if (!next) searchRef.current?.focus();
    }
  }

  function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") { e.preventDefault(); setHitIdx((i) => Math.min(i + 1, hits.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHitIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && hits[hitIdx]) { e.preventDefault(); void add(hits[hitIdx]); }
    else if (e.key === "Escape" && q) { e.stopPropagation(); setQ(""); }
  }

  async function save() {
    if (saving || !hasDatabase()) return;
    const input = { supplierId, supplierBillNo: billNo, billDate, note, lines, today: isoDate() };
    const p = checkPurchase(input);
    setProblems(p);
    if (p.length) return;
    setSaving(true);
    setMsg(null);
    try {
      await planPurchase(input).run();
      setLeaveGuard(null);
      setRows([]);
      setBillNo("");
      setNote("");
      setProblems([]);
      setMsg({ tone: "ok", text: t("purchaseSaved") });
    } catch (e) {
      const { key, raw } = dbErrorKey(e);
      setMsg({ tone: "bad", text: t(key, { msg: raw }) });
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey && (e.key === "s" || e.key === "S")) || e.key === "F10") { e.preventDefault(); void save(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const bad = new Set(problems.flatMap((p) => ("key" in p ? [p.key] : [])));
  const cls = "h-9 w-full rounded-md border border-line px-2 num outline-none focus:border-brand";

  return (
    <div className="space-y-4">
      <PageHeader title={t("purchase")} actions={<><Link to="/purchases" className="self-center text-brand hover:underline">{t("purchases")} →</Link><Button kind="primary" onClick={save} disabled={saving || rows.length === 0} kbd="Ctrl+S">{t("savePurchase")}</Button></>} />
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

      <section className="grid grid-cols-1 gap-3 rounded-xl border border-line bg-card p-4 md:grid-cols-4">
        <Field label={t("supplier")} htmlFor="sup" required>
          <Select id="sup" value={supplierId ?? ""} onChange={(e) => setSupplierId(Number(e.target.value) || null)}>
            <option value="">{t("chooseSupplier")}</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
          {suppliers.length === 0 && <Link to="/suppliers" className="mt-1 block text-sm text-brand underline">{t("noSuppliersYet")}</Link>}
        </Field>
        <Field label={t("supplierBillNo")} htmlFor="sbn" required>
          <TextInput id="sbn" value={billNo} onChange={(e) => setBillNo(e.target.value.toUpperCase())} maxLength={40} />
        </Field>
        <Field label={t("billDate")} htmlFor="sbd">
          <input id="sbd" type="date" value={billDate} max={isoDate()} onChange={(e) => setBillDate(e.target.value)} className={inputCls} />
        </Field>
        <Field label={t("note")} htmlFor="snote">
          <TextInput id="snote" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </section>

      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-5 w-5 -translate-y-1/2 text-ink-soft" />
          <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onSearchKey} placeholder={t("purchaseSearch")} aria-label={t("purchaseSearch")}
            className={inputCls + " h-11 pl-10"} spellCheck={false} autoComplete="off" />
          {hits.length > 0 && (
            <ul className="absolute z-20 mt-1 max-h-80 w-full overflow-auto rounded-xl border border-line bg-card shadow-lg" role="listbox">
              {hits.map((h, i) => (
                <li key={h.id} role="option" aria-selected={i === hitIdx} onMouseEnter={() => setHitIdx(i)} onMouseDown={(e) => { e.preventDefault(); void add(h); }}
                  className={"cursor-pointer px-4 py-2 " + (i === hitIdx ? "bg-brand-soft" : "")}>
                  <span className="font-medium">{h.name}</span> <span className="text-sm text-ink-soft">{[h.company, `${h.pack_size} ${h.unit.toLowerCase()}`].filter(Boolean).join(" · ")}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Button onClick={() => navigate("/stock/items/new")} kbd="">{t("createMedicine")}</Button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-line bg-card">
        <table className="w-full min-w-[1100px] text-left text-sm">
          <thead className="bg-paper text-ink-soft">
            <tr>
              {[t("colMedicine"), t("fBatch"), t("fExpiry"), t("colStrips"), t("colFree"), t("colPRate"), t("colMrp"), t("colSaleRate"), t("colDisc"), t("colGst"), t("colAmount"), ""].map((h, i) => (
                <th key={i} className="px-2 py-2 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody ref={gridRef}>
            {rows.length === 0 && <tr><td colSpan={12} className="px-4 py-8 text-center text-ink-soft">{t("purchaseSearch")}</td></tr>}
            {rows.map((r, i) => {
              const l = lines[i];
              const a = totals.lines[i];
              const expOk = !r.exp || !!l.expiry;
              const diff = r.last && l.ratePaise > 0 ? Math.round(((l.ratePaise - r.last.rate_paise) / r.last.rate_paise) * 100) : 0;
              const inp = (f: keyof Row, extra = "") => (
                <input data-row={r.key} data-f={f} aria-label={`${f} ${i + 1}`} value={r[f] as string}
                  onChange={(e) => set(r.key, { [f]: f === "batch" ? e.target.value.toUpperCase() : e.target.value } as Partial<Row>)}
                  onKeyDown={(e) => cellKey(e, r, f)} className={cls + " " + extra} />
              );
              return (
                <tr key={r.key} className={"border-t border-line align-top " + (bad.has(r.key) ? "bg-bad-soft" : "")}>
                  <td className="px-2 py-1.5">
                    <div className="font-medium">{r.name}</div>
                    <div className="text-xs text-ink-soft">{r.packSize} / pack</div>
                    {r.last && <div className="text-xs text-ink-soft">{t("lastRate", { rate: formatPaise(r.last.rate_paise), date: showDate(r.last.bill_date), supplier: r.last.supplier })}</div>}
                    {Math.abs(diff) >= 10 && <div className="text-xs font-medium text-warn">{t("rateChanged", { pct: diff > 0 ? `+${diff}` : diff })}</div>}
                  </td>
                  <td className="w-28 px-1 py-1.5">{inp("batch")}</td>
                  <td className="w-24 px-1 py-1.5">{inp("exp", expOk ? "" : "border-bad")}<div className="text-xs text-ink-soft">{t("expiryPh")}</div></td>
                  <td className="w-16 px-1 py-1.5">{inp("packs", "text-right")}</td>
                  <td className="w-16 px-1 py-1.5">{inp("free", "text-right")}</td>
                  <td className="w-24 px-1 py-1.5">{inp("rate", "text-right")}</td>
                  <td className="w-24 px-1 py-1.5">{inp("mrp", "text-right")}</td>
                  <td className="w-24 px-1 py-1.5">{inp("sale", "text-right")}</td>
                  <td className="w-16 px-1 py-1.5">{inp("disc", "text-right")}</td>
                  <td className="w-20 px-1 py-1.5">
                    <select aria-label={`GST ${i + 1}`} value={r.gstBp} onChange={(e) => set(r.key, { gstBp: Number(e.target.value) })} className="h-9 rounded-md border border-line bg-card px-1">
                      {GST_RATES_BP.map((g) => <option key={g} value={g}>{gstLabel(g)}</option>)}
                    </select>
                  </td>
                  <td className="num w-28 px-2 py-1.5 text-right font-medium">{formatPaise(a.total)}</td>
                  <td className="px-1 py-1.5">
                    <button type="button" tabIndex={-1} aria-label={`${t("removeLine")} ${r.name}`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} className="h-8 w-8 rounded-md text-ink-soft hover:bg-bad-soft hover:text-bad">✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          {problems.length > 0 && (
            <ul className="space-y-1 rounded-lg bg-bad-soft p-3 text-sm text-bad" role="alert">
              {problems.map((p, i) => <li key={i}>{t(`prob${p.code}` as StringKey, { name: "key" in p ? rows.find((r) => r.key === p.key)?.name ?? "" : "" })}</li>)}
            </ul>
          )}
        </div>
        <dl className="num min-w-72 space-y-1 rounded-xl border border-line bg-card p-4">
          <div className="flex justify-between"><dt>{t("taxable")}</dt><dd>{formatPaise(totals.taxable)}</dd></div>
          {totals.discount > 0 && <div className="flex justify-between text-sm text-ink-soft"><dt>{t("discountL")}</dt><dd>− {formatPaise(totals.discount)}</dd></div>}
          <div className="flex justify-between"><dt>{t("gstAmount")}</dt><dd>{formatPaise(totals.gst)}</dd></div>
          <div className="flex justify-between border-t border-line pt-1 text-xl font-bold"><dt>{t("total")}</dt><dd>{formatPaise(totals.total)}</dd></div>
        </dl>
      </div>
    </div>
  );
}
