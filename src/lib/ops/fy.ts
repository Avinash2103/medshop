// Indian financial year runs 1 April → 31 March. Bill numbers restart every year.

/** "2026-11-08" → "2026-27"; "2027-02-10" → "2026-27". */
export function financialYear(isoDate: string): string {
  const y = Number(isoDate.slice(0, 4));
  const m = Number(isoDate.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** "S" + "2026-11-08" → "S/2026-27/". The database appends a 6-digit running number. */
export function billPrefix(prefix: string, isoDate: string): string {
  const p = (prefix || "S").replace(/[^A-Za-z0-9-]/g, "").slice(0, 6) || "S";
  return `${p}/${financialYear(isoDate)}/`;
}

/** First and last day of the financial year that contains the date. */
export function fyRange(isoDate: string): { from: string; to: string } {
  const start = Number(financialYear(isoDate).slice(0, 4));
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` };
}

export function nowTime(d: Date = new Date()): string {
  return d.toTimeString().slice(0, 8);
}
