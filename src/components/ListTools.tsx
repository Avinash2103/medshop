// Small shared pieces for list and report screens.
import type { ReactNode } from "react";
import { useT } from "../i18n/I18nProvider";
import { isoDate } from "../lib/stock";
import { inputCls } from "./Form";

export function DateRange(props: { from: string; to: string; onChange: (from: string, to: string) => void; children?: ReactNode }) {
  const { t } = useT();
  const today = isoDate();
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-sm">
        <span className="mb-1 block font-medium">{t("from")}</span>
        <input type="date" value={props.from} max={props.to} onChange={(e) => props.onChange(e.target.value, props.to)} className={inputCls + " w-40"} />
      </label>
      <label className="text-sm">
        <span className="mb-1 block font-medium">{t("to")}</span>
        <input type="date" value={props.to} min={props.from} onChange={(e) => props.onChange(props.from, e.target.value)} className={inputCls + " w-40"} />
      </label>
      <button type="button" onClick={() => props.onChange(today, today)} className="h-10 rounded-lg border border-line px-3 text-sm hover:border-brand">
        {t("today")}
      </button>
      {props.children}
    </div>
  );
}

export function Table(props: { head: ReactNode[]; children: ReactNode; empty?: string; rightCols?: number[]; foot?: ReactNode }) {
  const right = new Set(props.rightCols ?? []);
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-card">
      <table className="w-full text-left">
        <thead className="bg-paper text-sm text-ink-soft">
          <tr>
            {props.head.map((h, i) => (
              <th key={i} className={"px-3 py-2 font-medium " + (right.has(i) ? "text-right" : "")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{props.children}</tbody>
        {props.foot && <tfoot className="border-t-2 border-line font-semibold">{props.foot}</tfoot>}
      </table>
      {props.empty && <p className="px-4 py-8 text-center text-ink-soft">{props.empty}</p>}
    </div>
  );
}

export const td = "px-3 py-2";
export const tdR = "num px-3 py-2 text-right";

/** dd/mm/yyyy, the way Indian shops write dates. */
export function showDate(iso: string): string {
  return iso ? iso.slice(0, 10).split("-").reverse().join("/") : "";
}
