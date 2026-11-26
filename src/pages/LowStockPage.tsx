import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useT } from "../i18n/I18nProvider";
import { useSettings } from "../app/SettingsContext";
import { hasDatabase } from "../db";
import { lowStock, type LowStockRow } from "../db/ops";
import { formatQty, isoDate } from "../lib/stock";
import { downloadCsv } from "../lib/csv";
import { Button, PageHeader } from "../components/Form";
import { Table, td, tdR } from "../components/ListTools";
import { PrintJob } from "../components/Print";

/** Medicines below their reorder level: the shop's order list for distributors. */
export function LowStockPage() {
  const { t } = useT();
  const { settings } = useSettings();
  const [rows, setRows] = useState<LowStockRow[]>([]);
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    if (hasDatabase()) lowStock(isoDate()).then(setRows).catch(() => {});
  }, []);

  const toOrder = (r: LowStockRow) => Math.max(0, Math.ceil((r.reorder_level * 2 - r.stock_units) / Math.max(1, r.pack_size)));
  const table = (
    <Table head={[t("colMedicine"), t("colCompany"), t("colStock"), t("colReorder"), t("colStrips"), t("colLastSupplier")]} rightCols={[2, 3, 4]} empty={rows.length ? undefined : t("nothingHere")}>
      {rows.map((r) => (
        <tr key={r.id} className="border-t border-line">
          <td className={td + " font-medium"}><Link to={`/stock/items/${r.id}`} className="hover:underline">{r.name}</Link></td>
          <td className={td + " text-ink-soft"}>{r.company}</td>
          <td className={tdR + (r.stock_units === 0 ? " text-bad" : " text-warn")}>{formatQty(r.stock_units, r.pack_size, r.unit.toLowerCase())}</td>
          <td className={tdR}>{formatQty(r.reorder_level, r.pack_size, r.unit.toLowerCase())}</td>
          <td className={tdR + " font-semibold"}>{toOrder(r)}</td>
          <td className={td + " text-sm"}>{r.last_supplier}</td>
        </tr>
      ))}
    </Table>
  );

  return (
    <div className="space-y-4">
      <PageHeader title={t("lowStockTitle")} sub={t("hintReorder")} actions={<>
        <Button onClick={() => setPrinting(true)}>{t("print")}</Button>
        <Button onClick={() => downloadCsv(`order-list-${isoDate()}.csv`, ["Medicine", "Company", "Stock units", "Reorder units", "Packs to order", "Last supplier"],
          rows.map((r) => [r.name, r.company, r.stock_units, r.reorder_level, toOrder(r), r.last_supplier]))}>{t("exportCsv")}</Button>
      </>} />
      {table}
      {printing && (
        <PrintJob paper="A4" onDone={() => setPrinting(false)}>
          <h2 style={{ fontSize: 16, fontWeight: 700 }}>{settings.shop_name} — {t("lowStockTitle")} — {isoDate().split("-").reverse().join("/")}</h2>
          {table}
        </PrintJob>
      )}
    </div>
  );
}
