// Export a table as CSV that Excel opens correctly (UTF-8 with BOM, so Hindi/₹ show properly).

export type CsvValue = string | number | null | undefined;

export function toCsv(header: string[], rows: CsvValue[][]): string {
  const esc = (v: CsvValue) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
}

export function downloadCsv(fileName: string, header: string[], rows: CsvValue[][]) {
  const url = URL.createObjectURL(new Blob(["﻿" + toCsv(header, rows)], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Paise → "1234.50" for spreadsheets (no ₹ sign, no grouping, so Excel treats it as a number). */
export const rs = (paise: number) => (paise / 100).toFixed(2);
