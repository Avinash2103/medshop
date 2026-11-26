import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type Paper = "80mm" | "58mm" | "A5" | "A4";

const PAGE: Record<Paper, string> = {
  "80mm": "@page { size: 80mm auto; margin: 3mm; }",
  "58mm": "@page { size: 58mm auto; margin: 2mm; }",
  A5: "@page { size: A5; margin: 8mm; }",
  A4: "@page { size: A4; margin: 10mm; }",
};

/**
 * Renders `children` into a print-only area and opens the print dialog.
 * The normal screen is hidden while printing (see index.css), so only this prints.
 * `onDone` runs after the dialog closes.
 */
export function PrintJob({ paper, children, onDone }: { paper: Paper; children: ReactNode; onDone: () => void }) {
  const [el] = useState(() => {
    const d = document.createElement("div");
    d.id = "print-root";
    d.dataset.paper = paper;
    return d;
  });

  useEffect(() => {
    document.body.appendChild(el);
    const style = document.createElement("style");
    style.textContent = PAGE[paper];
    document.head.appendChild(style);
    const after = () => onDone();
    window.addEventListener("afterprint", after, { once: true });
    // Let the content render, then print.
    const t = setTimeout(() => window.print(), 50);
    return () => {
      clearTimeout(t);
      window.removeEventListener("afterprint", after);
      style.remove();
      el.remove();
    };
  }, [el, paper, onDone]);

  return createPortal(children, el);
}

export function isThermal(p: Paper) {
  return p === "80mm" || p === "58mm";
}
