import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { hasDatabase } from "../db";
import { getSettings } from "../db/repo";

/** All shop settings as plain strings (the settings table is key → value). */
export type AppSettings = Record<string, string>;

interface Ctx {
  settings: AppSettings;
  reload: () => Promise<void>;
}

const SettingsCtx = createContext<Ctx | null>(null);

export function SettingsProvider({ initial, children }: { initial: AppSettings; children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(initial);
  const reload = useCallback(async () => {
    if (!hasDatabase()) return;
    setSettings((await getSettings()) as AppSettings);
  }, []);
  return <SettingsCtx.Provider value={{ settings, reload }}>{children}</SettingsCtx.Provider>;
}

export function useSettings() {
  const c = useContext(SettingsCtx);
  if (!c) throw new Error("useSettings outside SettingsProvider");
  return c;
}

export function nearDaysOf(s: AppSettings): number {
  return Number(s.near_expiry_days) || 90;
}
