import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { useT } from "../i18n/I18nProvider";
import type { StringKey } from "../i18n/strings";
import { useSettings } from "../app/SettingsContext";
import { hasDatabase } from "../db";
import { searchItems } from "../db/repo";
import { findCustomers, getSale, itemBasics, quickAddCustomer, sellableBatches, type CustomerHit, type SellableBatch } from "../db/ops";
import type { ItemSearchRow } from "../db/types";
import { dbErrorKey } from "../db/errors";
import { formatPaise, rupeesToPaise } from "../lib/money";
import { formatExpiry, formatQty, isoDate, toPacks } from "../lib/stock";
import { nowTime } from "../lib/ops/fy";
import { cartTotals, checkSale, needsRegister, PAYMENT_MODES, planSale, type CartLine, type PaymentMode, type RxDetails, type SaleProblem } from "../lib/ops/sale";
import { setLeaveGuard } from "../hooks/leaveGuard";
import { SEARCH_EVENT } from "../hooks/useShortcuts";
import { Banner, Button, Field, TextInput, inputCls } from "../components/Form";
import { SearchIcon } from "../components/Icons";
import { ScheduleBadge } from "../components/ScheduleBadge";
import { PrintJob, type Paper } from "../components/Print";
import { BillPrint } from "../components/BillPrint";

const EMPTY_RX: RxDetails = { prescriberName: "", prescriberAddress: "", patientName: "", patientAddress: "", rxNo: "" };
const num = (s: string) => Math.max(0, Math.floor(Number(s.replace(/[^\d]/g, "")) || 0));

type PrintData = NonNullable<Awaited<ReturnType<typeof getSale>>>;

export function BillingPage() {
  const { t } = useT();
  const { settings } = useSettings();
  const searchRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLTableSectionElement>(null);

  const [lines, setLines] = useState<CartLine[]>([]);
  const [batchOptions, setBatchOptions] = useState<Record<string, SellableBatch[]>>({});
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ItemSearchRow[]>([]);
  const [hitIdx, setHitIdx] = useState(0);
  const [mode, setMode] = useState<PaymentMode>("CASH");
  const [customerQ, setCustomerQ] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const [customerHits, setCustomerHits] = useState<CustomerHit[]>([]);
  const [doctor, setDoctor] = useState("");
  const [rx, setRx] = useState<RxDetails>(EMPTY_RX);
  const [billDisc, setBillDisc] = useState("");
  const [receivedStr, setReceivedStr] = useState("");
  const [problems, setProblems] = useState<SaleProblem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastSaved, setLastSaved] = useState<{ id: number; no: string } | null>(null);
  const [printing, setPrinting] = useState<PrintData | null>(null);
  const [saving, setSaving] = useState(false);
  const [leaveWarn, setLeaveWarn] = useState(false);

  const today = isoDate();
  const totals = useMemo(() => cartTotals(lines), [lines]);
  const register = needsRegister(lines);
  const paper = (settings.paper || "80mm") as Paper;

  // ---------- focus & guards ----------
  useEffect(() => {
    const f = () => searchRef.current?.focus();
    f();
    window.addEventListener(SEARCH_EVENT, f);
    return () => window.removeEventListener(SEARCH_EVENT, f);
  }, []);

  useEffect(() => {
    setLeaveWarn(false);
    if (lines.length === 0) {
      setLeaveGuard(null);
      return;
    }
    let warned = false;
    setLeaveGuard(() => {
      if (warned) return true;
      warned = true;
      setLeaveWarn(true);
      return false;
    });
    return () => setLeaveGuard(null);
  }, [lines.length]);

  // ---------- medicine search ----------
  useEffect(() => {
    if (!hasDatabase() || !q.trim()) {
      setHits([]);
      return;
    }
    let stale = false;
    const h = setTimeout(() => {
      searchItems(q, 12).then((r) => {
        if (stale) return;
        setHits(r);
        setHitIdx(0);
      });
    }, 100);
    return () => {
      stale = true;
      clearTimeout(h);
    };
  }, [q]);

  // Focus a cart cell once its line is on screen (state updates render asynchronously).
  const pendingFocus = useRef<{ key: string; field: string } | null>(null);
  const focusLine = (key: string, field = "packs") => {
    pendingFocus.current = { key, field };
    setFocusTick((n) => n + 1);
  };
  const [focusTick, setFocusTick] = useState(0);
  useEffect(() => {
    const p = pendingFocus.current;
    const el = p ? tableRef.current?.querySelector<HTMLInputElement>(`[data-line="${p.key}"][data-field="${p.field}"]`) : null;
    if (el) {
      el.focus();
      el.select();
      pendingFocus.current = null;
    }
    if (!p && lines.length === 0 && !printing) searchRef.current?.focus();
  }, [lines, focusTick, printing]);

  async function addItem(hit: ItemSearchRow) {
    setNotice(null);
    const [item, batches] = await Promise.all([itemBasics(hit.id), sellableBatches(hit.id, today)]);
    if (!item || batches.length === 0) {
      setNotice(`${hit.name}: ${t("noSellable")}`);
      return;
    }
    const b = batches[0]; // earliest expiry first
    const existing = lines.find((l) => l.batchId === b.id);
    setQ("");
    setHits([]);
    if (existing) return focusLine(existing.key);
    const key = `${b.id}-${Date.now()}`;
    const discountBp = Math.round((Number(billDisc) || 0) * 100);
    setBatchOptions((o) => ({ ...o, [key]: batches }));
    setLines((ls) => [
      ...ls,
      {
        key, itemId: item.id, name: item.name, packSize: item.pack_size, unit: item.unit, schedule: item.schedule, gstBp: item.gst_rate_bp,
        hsn: item.hsn, batchId: b.id, batchNo: b.batch_no, expiry: b.expiry, mrpPaise: b.mrp_paise,
        ratePaise: Math.min(b.sale_rate_paise || b.mrp_paise, b.mrp_paise), qtyUnits: Math.min(item.pack_size, b.qty_units),
        discountBp, stockUnits: b.qty_units,
      },
    ]);
    focusLine(key);
  }

  function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHitIdx((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHitIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && hits[hitIdx]) {
      e.preventDefault();
      void addItem(hits[hitIdx]);
    } else if (e.key === "Escape" && q) {
      e.stopPropagation();
      setQ("");
    }
  }

  // ---------- cart editing ----------
  const update = (key: string, patch: Partial<CartLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const remove = (key: string) => {
    setLines((ls) => ls.filter((l) => l.key !== key));
    setTimeout(() => searchRef.current?.focus(), 0);
  };

  function setQty(l: CartLine, packs: number, loose: number) {
    update(l.key, { qtyUnits: packs * l.packSize + loose });
  }

  function changeBatch(l: CartLine, batchId: number) {
    const b = batchOptions[l.key]?.find((x) => x.id === batchId);
    if (!b) return;
    update(l.key, { batchId: b.id, batchNo: b.batch_no, expiry: b.expiry, mrpPaise: b.mrp_paise, ratePaise: Math.min(b.sale_rate_paise || b.mrp_paise, b.mrp_paise), stockUnits: b.qty_units });
  }

  function lineKey(e: KeyboardEvent<HTMLInputElement | HTMLSelectElement>, l: CartLine) {
    if (e.key === "Delete" && e.ctrlKey) {
      e.preventDefault();
      remove(l.key);
    } else if (e.key === "Enter") {
      e.preventDefault();
      searchRef.current?.focus();
    }
  }

  function applyBillDiscount() {
    const bp = Math.round(Math.min(100, Math.max(0, Number(billDisc) || 0)) * 100);
    setLines((ls) => ls.map((l) => ({ ...l, discountBp: bp })));
  }

  // ---------- customer ----------
  useEffect(() => {
    if (!hasDatabase() || customer || customerQ.trim().length < 2) {
      setCustomerHits([]);
      return;
    }
    const h = setTimeout(() => findCustomers(customerQ).then(setCustomerHits).catch(() => {}), 150);
    return () => clearTimeout(h);
  }, [customerQ, customer]);

  function pickCustomer(c: CustomerHit) {
    setCustomer(c);
    setCustomerQ(c.name);
    setCustomerPhone(c.phone ?? "");
    setCustomerHits([]);
    if (!rx.patientName) setRx((r) => ({ ...r, patientName: c.name }));
  }

  async function saveCustomer() {
    if (!customerQ.trim()) return;
    try {
      const id = await quickAddCustomer(customerQ, customerPhone);
      setCustomer({ id, name: customerQ.trim(), phone: customerPhone || null, balance: 0 });
    } catch (e) {
      setError(t(dbErrorKey(e).key, { msg: String(e) }));
    }
  }

  // ---------- save ----------
  const reset = useCallback(() => {
    setLines([]);
    setBatchOptions({});
    setCustomer(null);
    setCustomerQ("");
    setCustomerPhone("");
    setDoctor("");
    setRx(EMPTY_RX);
    setBillDisc("");
    setReceivedStr("");
    setMode("CASH");
    setProblems([]);
    setLeaveGuard(null);
    setTimeout(() => searchRef.current?.focus(), 0);
  }, []);

  async function save(print: boolean) {
    if (saving || !hasDatabase()) return;
    setError(null);
    setNotice(null);
    const input = {
      lines, billDate: today, billTime: nowTime(), billPrefix: settings.bill_prefix || "S", paymentMode: mode,
      customerId: customer?.id ?? null, customerName: customer ? "" : customerQ, customerPhone, doctorName: doctor, rx, today,
    };
    const p = checkSale(input);
    setProblems(p);
    if (p.length) return;
    setSaving(true);
    try {
      const res = await planSale(input).run();
      const saleId = res.last_ids[0];
      const bill = await getSale(saleId);
      setLastSaved({ id: saleId, no: bill?.header.bill_no ?? "" });
      reset();
      if (bill && print) setPrinting(bill);
    } catch (e) {
      const { key, raw } = dbErrorKey(e);
      setError(t(key, { msg: raw }));
    } finally {
      setSaving(false);
    }
  }

  const printAfter = settings.print_after_save !== "0";
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "F10") {
        e.preventDefault();
        void save(true);
      } else if (e.ctrlKey && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        void save(printAfter);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const received = rupeesToPaiseSafe(receivedStr);
  const changeAmt = received > 0 ? received - totals.payable : 0;
  const problemText = (p: SaleProblem) => {
    const l = "key" in p ? lines.find((x) => x.key === p.key) : undefined;
    return t(`prob${p.code}` as StringKey, { name: l?.name ?? "", stock: l ? formatQty(l.stockUnits, l.packSize, l.unit.toLowerCase()) : "" });
  };
  const badKeys = new Set(problems.flatMap((p) => ("key" in p ? [p.key] : [])));

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_340px]">
      <section className="min-w-0 space-y-3">
        <div className="flex items-baseline justify-between">
          <h1 className="text-2xl font-semibold">{t("newBill")}</h1>
          <Link to="/bills" className="text-brand hover:underline">{t("bills")} →</Link>
        </div>
        {leaveWarn && <Banner tone="warn">{t("unsavedBill")}</Banner>}
        {lastSaved && (
          <Banner tone="ok">
            {t("billSaved", { no: lastSaved.no })} ·{" "}
            <button type="button" className="underline" onClick={async () => setPrinting(await getSale(lastSaved.id))}>{t("print")}</button> ·{" "}
            <Link className="underline" to={`/bills/${lastSaved.id}`}>{t("bills")}</Link>
          </Banner>
        )}
        {notice && <Banner tone="warn">{notice}</Banner>}
        {error && <Banner tone="bad">{error}</Banner>}

        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-5 w-5 -translate-y-1/2 text-ink-soft" />
          <input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder={t("billSearch")}
            aria-label={t("billSearch")}
            className={inputCls + " h-12 pl-10 text-lg"}
            spellCheck={false}
            autoComplete="off"
          />
          {hits.length > 0 && (
            <ul className="absolute z-20 mt-1 max-h-96 w-full overflow-auto rounded-xl border border-line bg-card shadow-lg" role="listbox">
              {hits.map((h, i) => (
                <li
                  key={h.id}
                  role="option"
                  aria-selected={i === hitIdx}
                  onMouseEnter={() => setHitIdx(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    void addItem(h);
                  }}
                  className={"flex cursor-pointer items-center justify-between gap-3 px-4 py-2 " + (i === hitIdx ? "bg-brand-soft" : "")}
                >
                  <span>
                    <span className="font-medium">{h.name}</span>
                    <ScheduleBadge schedule={h.schedule} />
                    <span className="block text-sm text-ink-soft">{[h.salt, h.company, h.rack && `Rack ${h.rack}`].filter(Boolean).join(" · ")}</span>
                  </span>
                  <span className={"num text-right text-sm " + (h.stock_units > 0 ? "" : "text-bad")}>
                    {h.stock_units > 0 ? formatQty(h.stock_units, h.pack_size, h.unit.toLowerCase()) : t("outOfStock")}
                    {h.mrp_paise != null && <span className="block text-ink-soft">{formatPaise(h.mrp_paise)}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="overflow-x-auto rounded-xl border border-line bg-card">
          <table className="w-full min-w-[760px] text-left">
            <thead className="bg-paper text-sm text-ink-soft">
              <tr>
                <th className="min-w-[220px] px-3 py-2 font-medium">{t("colMedicine")}</th>
                <th className="px-3 py-2 font-medium">{t("colBatchExp")}</th>
                <th className="w-20 px-2 py-2 text-right font-medium">{t("colStrips")}</th>
                <th className="w-20 px-2 py-2 text-right font-medium">{t("colLoose")}</th>
                <th className="w-24 px-2 py-2 text-right font-medium">{t("rate")}</th>
                <th className="w-20 px-2 py-2 text-right font-medium">{t("colDisc")}</th>
                <th className="w-28 px-3 py-2 text-right font-medium">{t("colAmount")}</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody ref={tableRef}>
              {lines.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-ink-soft">{t("emptyCart")}</td>
                </tr>
              )}
              {lines.map((l, i) => {
                const { packs, loose } = toPacks(l.qtyUnits, l.packSize);
                const opts = batchOptions[l.key] ?? [];
                return (
                  <tr key={l.key} className={"border-t border-line " + (badKeys.has(l.key) ? "bg-bad-soft" : "")}>
                    <td className="px-3 py-1.5">
                      <div className="font-medium">
                        {l.name}
                        <ScheduleBadge schedule={l.schedule} />
                      </div>
                      <div className="text-xs text-ink-soft">
                        MRP {formatPaise(l.mrpPaise)} · {l.packSize > 1 ? `${l.packSize} ${l.unit.toLowerCase()}` : l.unit.toLowerCase()} · {t("stockLeft", { n: formatQty(l.stockUnits, l.packSize, l.unit.toLowerCase()) })}
                      </div>
                    </td>
                    <td className="px-3 py-1.5">
                      <select
                        aria-label={t("colBatchExp")}
                        value={l.batchId}
                        onChange={(e) => changeBatch(l, Number(e.target.value))}
                        className="h-9 rounded-md border border-line bg-card px-2 text-sm"
                        tabIndex={opts.length > 1 ? 0 : -1}
                      >
                        {opts.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.batch_no} · {formatExpiry(b.expiry)} · {formatPaise(b.mrp_paise)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-1.5">
                      <input data-line={l.key} data-field="packs" aria-label={`${t("colStrips")} ${i + 1}`} inputMode="numeric" value={String(packs)}
                        onChange={(e) => setQty(l, num(e.target.value), loose)} onKeyDown={(e) => lineKey(e, l)}
                        className="h-9 w-full rounded-md border border-line px-2 text-right num focus:border-brand outline-none" />
                    </td>
                    <td className="px-2 py-1.5">
                      {l.packSize > 1 ? (
                        <input data-line={l.key} data-field="loose" aria-label={`${t("colLoose")} ${i + 1}`} inputMode="numeric" value={String(loose)}
                          onChange={(e) => setQty(l, packs, Math.min(num(e.target.value), l.packSize - 1))} onKeyDown={(e) => lineKey(e, l)}
                          className="h-9 w-full rounded-md border border-line px-2 text-right num focus:border-brand outline-none" />
                      ) : (
                        <span className="block text-center text-ink-soft">—</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <RateInput value={l.ratePaise} max={l.mrpPaise} onChange={(v) => update(l.key, { ratePaise: v })} label={`${t("rate")} ${i + 1}`} />
                    </td>
                    <td className="px-2 py-1.5">
                      <input data-line={l.key} data-field="disc" aria-label={`${t("colDisc")} ${i + 1}`} inputMode="decimal" value={l.discountBp ? String(l.discountBp / 100) : ""}
                        onChange={(e) => update(l.key, { discountBp: Math.round(Math.min(100, Number(e.target.value.replace(/[^\d.]/g, "")) || 0) * 100) })}
                        onKeyDown={(e) => lineKey(e, l)}
                        className="h-9 w-full rounded-md border border-line px-2 text-right num focus:border-brand outline-none" />
                    </td>
                    <td className="num px-3 py-1.5 text-right font-medium">{formatPaise(totals.lines[i].amount)}</td>
                    <td className="px-1">
                      <button type="button" onClick={() => remove(l.key)} aria-label={`${t("removeLine")} ${l.name}`} className="h-8 w-8 rounded-md text-ink-soft hover:bg-bad-soft hover:text-bad" tabIndex={-1}>
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-sm text-ink-soft">{t("keysHelp")}</p>

        {register && (
          <section className="rounded-xl border border-bad/30 bg-card p-4">
            <h2 className="font-semibold text-bad">{t("rxTitle")}</h2>
            <p className="mb-3 text-sm text-ink-soft">{t("rxHint")}</p>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label={t("fPrescriber")} htmlFor="rx-dr" required>
                <TextInput id="rx-dr" value={rx.prescriberName} onChange={(e) => setRx({ ...rx, prescriberName: e.target.value })} />
              </Field>
              <Field label={t("fPrescriberAddr")} htmlFor="rx-dra" required>
                <TextInput id="rx-dra" value={rx.prescriberAddress} onChange={(e) => setRx({ ...rx, prescriberAddress: e.target.value })} />
              </Field>
              <Field label={t("fPatient")} htmlFor="rx-pt" required>
                <TextInput id="rx-pt" value={rx.patientName} onChange={(e) => setRx({ ...rx, patientName: e.target.value })} />
              </Field>
              <Field label={t("fPatientAddr")} htmlFor="rx-pta" required>
                <TextInput id="rx-pta" value={rx.patientAddress} onChange={(e) => setRx({ ...rx, patientAddress: e.target.value })} />
              </Field>
              <Field label={t("fRxNo")} htmlFor="rx-no">
                <TextInput id="rx-no" value={rx.rxNo} onChange={(e) => setRx({ ...rx, rxNo: e.target.value })} />
              </Field>
            </div>
          </section>
        )}
      </section>

      <aside className="space-y-4">
        <section className="space-y-3 rounded-xl border border-line bg-card p-4">
          <div className="relative">
            <Field label={t("customer")} htmlFor="cust">
              <TextInput id="cust" value={customerQ} placeholder={t("customerPh")}
                onChange={(e) => {
                  setCustomerQ(e.target.value);
                  if (customer) setCustomer(null);
                }} />
            </Field>
            {customerHits.length > 0 && (
              <ul className="absolute z-20 mt-1 w-full rounded-lg border border-line bg-card shadow-lg">
                {customerHits.map((c) => (
                  <li key={c.id}>
                    <button type="button" onClick={() => pickCustomer(c)} className="flex w-full justify-between px-3 py-2 text-left hover:bg-brand-soft">
                      <span>{c.name} <span className="text-sm text-ink-soft">{c.phone}</span></span>
                      {c.balance > 0 && <span className="text-sm text-warn">{formatPaise(c.balance)}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {customer ? (
            customer.balance > 0 && <p className="text-sm text-warn">{t("pendingAmt", { amt: formatPaise(customer.balance) })}</p>
          ) : (
            <>
              <Field label={t("mobile")} htmlFor="cust-ph">
                <TextInput id="cust-ph" inputMode="tel" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value.replace(/[^\d+ ]/g, ""))} />
              </Field>
              {customerQ.trim() && (
                <button type="button" onClick={saveCustomer} className="text-sm text-brand underline">{t("saveAsCustomer")}</button>
              )}
            </>
          )}
          <Field label={t("doctor")} htmlFor="doc">
            <TextInput id="doc" value={doctor} onChange={(e) => {
              setDoctor(e.target.value);
              if (!rx.prescriberName || rx.prescriberName === doctor) setRx((r) => ({ ...r, prescriberName: e.target.value }));
            }} />
          </Field>
          <div>
            <div className="mb-1 text-sm font-medium">{t("payMode")}</div>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t("payMode")}>
              {PAYMENT_MODES.map((m) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}
                  className={"h-10 rounded-lg border font-medium " + (mode === m ? "border-brand bg-brand text-white" : "border-line hover:border-brand")}>
                  {t(`pay${m}` as StringKey)}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-end gap-2">
            <Field label={t("billDiscount")} htmlFor="bdisc" className="flex-1">
              <TextInput id="bdisc" inputMode="decimal" value={billDisc} onChange={(e) => setBillDisc(e.target.value.replace(/[^\d.]/g, ""))}
                onKeyDown={(e) => e.key === "Enter" && applyBillDiscount()} />
            </Field>
            <Button onClick={applyBillDiscount}>{t("apply")}</Button>
          </div>
        </section>

        <section className="rounded-xl border border-line bg-card p-4">
          <dl className="num space-y-1">
            <Line label={`${lines.length} ${t("items")}`} value={formatPaise(totals.gross)} />
            {totals.discount > 0 && <Line label={t("discountL")} value={`− ${formatPaise(totals.discount)}`} />}
            <Line label={t("gstIncluded")} value={formatPaise(totals.gst)} quiet />
            {totals.roundOff !== 0 && <Line label={t("roundOff")} value={formatPaise(totals.roundOff)} quiet />}
          </dl>
          <div className="mt-2 flex items-baseline justify-between border-t border-line pt-2">
            <span className="text-lg font-medium">{t("netPay")}</span>
            <span className="num text-3xl font-bold text-brand-ink">{formatPaise(totals.payable)}</span>
          </div>
          {mode === "CASH" && (
            <div className="mt-3 flex items-center gap-3">
              <label htmlFor="recv" className="text-sm">{t("received")}</label>
              <input id="recv" inputMode="decimal" value={receivedStr} onChange={(e) => setReceivedStr(e.target.value.replace(/[^\d.]/g, ""))}
                className="h-9 w-28 rounded-md border border-line px-2 text-right num" />
              {changeAmt > 0 && <span className="num font-semibold text-ok">{t("changeBack", { amt: (changeAmt / 100).toFixed(2) })}</span>}
            </div>
          )}
          {problems.length > 0 && (
            <ul className="mt-3 space-y-1 rounded-lg bg-bad-soft p-3 text-sm text-bad" role="alert">
              {problems.map((p, i) => <li key={i}>{problemText(p)}</li>)}
            </ul>
          )}
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Button onClick={() => save(printAfter)} disabled={saving || lines.length === 0} kbd="Ctrl+S">{t("saveBill")}</Button>
            <Button kind="primary" onClick={() => save(true)} disabled={saving || lines.length === 0} kbd="F10">{t("savePrint")}</Button>
          </div>
        </section>
      </aside>

      {printing && (
        <PrintJob paper={paper} onDone={() => { setPrinting(null); setFocusTick((n) => n + 1); }}>
          <BillPrint header={printing.header} lines={printing.lines} rx={printing.rx} settings={settings} paper={paper} />
        </PrintJob>
      )}
    </div>
  );
}

function rupeesToPaiseSafe(s: string): number {
  try {
    return s ? rupeesToPaise(s) : 0;
  } catch {
    return 0;
  }
}

function Line({ label, value, quiet }: { label: string; value: string; quiet?: boolean }) {
  return (
    <div className={"flex justify-between " + (quiet ? "text-sm text-ink-soft" : "")}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** Rupee input that keeps its own text while typing and never goes above MRP. */
function RateInput({ value, max, onChange, label }: { value: number; max: number; onChange: (v: number) => void; label: string }) {
  const [text, setText] = useState((value / 100).toFixed(2));
  useEffect(() => setText((value / 100).toFixed(2)), [value]);
  return (
    <input
      aria-label={label}
      inputMode="decimal"
      value={text}
      onChange={(e) => setText(e.target.value.replace(/[^\d.]/g, ""))}
      onBlur={() => {
        const p = Math.min(max, Math.round((Number(text) || 0) * 100));
        onChange(p);
        setText((p / 100).toFixed(2));
      }}
      className="h-9 w-full rounded-md border border-line px-2 text-right num outline-none focus:border-brand"
    />
  );
}
