import type { AppSettings } from "../app/SettingsContext";
import type { RegisterEntry, SaleHeader, SaleLineFull } from "../db/ops";
import { useT } from "../i18n/I18nProvider";
import type { StringKey } from "../i18n/strings";
import { formatPaise, splitCgstSgst } from "../lib/money";
import { formatExpiry, formatQty } from "../lib/stock";
import { isThermal, type Paper } from "./Print";

const money = (p: number) => formatPaise(p).replace("₹", "");
const noDr = (n: string) => n.replace(/^\s*dr\.?\s+/i, "");

/** The bill as printed: thermal roll (58/80 mm) or a sheet (A5/A4). */
export function BillPrint(props: { header: SaleHeader; lines: SaleLineFull[]; rx: RegisterEntry | null; settings: AppSettings; paper: Paper }) {
  const { t } = useT();
  const { header: h, lines, rx, settings: s, paper } = props;
  const thermal = isThermal(paper);
  const mrpTotal = lines.reduce((sum, l) => sum + Math.round((l.mrp_paise * l.qty_units) / l.pack_size), 0);
  const saved = mrpTotal - h.total_paise + h.round_off_paise;

  // GST split per rate for the tax table.
  const rates = new Map<number, { taxable: number; gst: number }>();
  for (const l of lines) {
    const r = rates.get(l.gst_rate_bp) ?? { taxable: 0, gst: 0 };
    r.taxable += l.taxable_paise;
    r.gst += l.gst_paise;
    rates.set(l.gst_rate_bp, r);
  }

  const cell = { padding: thermal ? "1px 2px" : "3px 4px", verticalAlign: "top" as const };
  const rule = { borderTop: "1px dashed #000" };
  const right = { ...cell, textAlign: "right" as const };

  return (
    <div style={{ width: thermal ? "100%" : undefined, position: "relative" }}>
      {h.status === "CANCELLED" && (
        <div style={{ position: "absolute", top: "30%", left: 0, right: 0, textAlign: "center", fontSize: thermal ? 28 : 56, fontWeight: 700, opacity: 0.25, transform: "rotate(-15deg)" }}>
          {t("cancelledStamp")}
        </div>
      )}
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: thermal ? 15 : 20, fontWeight: 700 }}>{s.shop_name || "MedShop"}</div>
        {s.shop_address && <div>{s.shop_address}</div>}
        {s.shop_phone && <div>{s.shop_phone}</div>}
        {s.gstin && <div>GSTIN: {s.gstin}</div>}
        {(s.dl_no_20 || s.dl_no_21) && (
          <div>
            {t("dlShort")}: {[s.dl_no_20, s.dl_no_21].filter(Boolean).join(", ")}
          </div>
        )}
        <div style={{ marginTop: 4, fontWeight: 700 }}>{t("taxInvoice")}</div>
      </div>

      <table style={{ marginTop: 4, ...rule }}>
        <tbody>
          <tr>
            <td style={cell}>
              {t("billNo")} <b>{h.bill_no}</b>
            </td>
            <td style={right}>
              {h.bill_date.split("-").reverse().join("/")} {h.bill_time.slice(0, 5)}
            </td>
          </tr>
          {(h.customer_name || h.customer_phone) && (
            <tr>
              <td style={cell} colSpan={2}>
                {t("patientOrCustomer")}: {[h.customer_name, h.customer_phone].filter(Boolean).join(" · ")}
                {h.customer_gstin ? ` · GSTIN ${h.customer_gstin}` : ""}
              </td>
            </tr>
          )}
          {h.doctor_name && (
            <tr>
              <td style={cell} colSpan={2}>
                {t("drShort")} {noDr(h.doctor_name)}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <table style={{ ...rule, marginTop: 2 }}>
        <thead>
          <tr style={{ borderBottom: "1px dashed #000" }}>
            <th style={{ ...cell, textAlign: "left" }}>{t("colMedicine")}</th>
            <th style={right}>{t("qty")}</th>
            {!thermal && <th style={right}>{t("colMrp")}</th>}
            {!thermal && <th style={right}>{t("colDisc")}</th>}
            {!thermal && <th style={right}>{t("colGst")}</th>}
            <th style={right}>{t("colAmount")}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id}>
              <td style={cell}>
                <div style={{ fontWeight: 600 }}>{l.item_name}</div>
                <div style={{ fontSize: "0.9em" }}>
                  {l.batch_no} · {t("expShort")} {formatExpiry(l.expiry)}
                  {thermal ? ` · MRP ${money(l.mrp_paise)}` : ""}
                  {!thermal && l.hsn ? ` · ${t("hsn")} ${l.hsn}` : ""}
                  {l.schedule !== "OTC" ? ` · Sch ${l.schedule}` : ""}
                </div>
              </td>
              <td style={right}>{formatQty(l.qty_units, l.pack_size, l.unit.toLowerCase())}</td>
              {!thermal && <td style={right}>{money(l.mrp_paise)}</td>}
              {!thermal && <td style={right}>{l.discount_bp ? `${l.discount_bp / 100}%` : ""}</td>}
              {!thermal && <td style={right}>{l.gst_rate_bp / 100}%</td>}
              <td style={right}>{money(l.amount_paise)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <table style={{ ...rule, marginTop: 2 }}>
        <tbody>
          {h.discount_paise > 0 && <Row label={t("discountL")} value={`− ${money(h.discount_paise)}`} cell={cell} right={right} />}
          {h.round_off_paise !== 0 && <Row label={t("roundOff")} value={money(h.round_off_paise)} cell={cell} right={right} />}
          <tr style={{ fontSize: thermal ? 14 : 16, fontWeight: 700 }}>
            <td style={cell}>{t("total")}</td>
            <td style={right}>{formatPaise(h.total_paise)}</td>
          </tr>
          <Row label={t("paidBy")} value={t(`pay${h.payment_mode}` as StringKey)} cell={cell} right={right} />
        </tbody>
      </table>

      <table style={{ ...rule, marginTop: 2, fontSize: "0.9em" }}>
        <thead>
          <tr>
            <th style={{ ...cell, textAlign: "left" }}>GST</th>
            <th style={right}>{t("taxable")}</th>
            <th style={right}>{t("cgst")}</th>
            <th style={right}>{t("sgst")}</th>
          </tr>
        </thead>
        <tbody>
          {[...rates.entries()].sort((a, b) => a[0] - b[0]).map(([bp, r]) => {
            const { cgst, sgst } = splitCgstSgst(r.gst);
            return (
              <tr key={bp}>
                <td style={cell}>{bp / 100}%</td>
                <td style={right}>{money(r.taxable)}</td>
                <td style={right}>{money(cgst)}</td>
                <td style={right}>{money(sgst)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {rx && (
        <div style={{ ...rule, marginTop: 2, paddingTop: 2, fontSize: "0.9em" }}>
          Rx ({rx.schedule}): {t("drShort")} {noDr(rx.prescriber_name)}, {rx.prescriber_address} · {rx.patient_name}, {rx.patient_address}
          {rx.rx_no ? ` · #${rx.rx_no}` : ""}
        </div>
      )}

      <div style={{ ...rule, marginTop: 4, paddingTop: 4, textAlign: "center" }}>
        {saved > 0 && <div style={{ fontWeight: 600 }}>{t("youSaved", { amt: formatPaise(saved) })}</div>}
        {s.bill_footer && <div>{s.bill_footer}</div>}
        <div style={{ marginTop: thermal ? 14 : 28, textAlign: "right" }}>
          {s.pharmacist_name ? `${s.pharmacist_name} · ` : ""}
          {t("pharmacistSign")}
        </div>
      </div>
    </div>
  );
}

function Row(p: { label: string; value: string; cell: React.CSSProperties; right: React.CSSProperties }) {
  return (
    <tr>
      <td style={p.cell}>{p.label}</td>
      <td style={p.right}>{p.value}</td>
    </tr>
  );
}
