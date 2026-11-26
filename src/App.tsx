import { useEffect, useState } from "react";
import { HashRouter, Route, Routes } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { I18nProvider } from "./i18n/I18nProvider";
import type { Lang } from "./i18n/strings";
import { SettingsProvider, nearDaysOf, useSettings, type AppSettings } from "./app/SettingsContext";
import { AppShell } from "./components/AppShell";
import { Home } from "./pages/Home";
import { ItemsPage } from "./pages/ItemsPage";
import { ItemEditPage } from "./pages/ItemEditPage";
import { PartiesPage } from "./pages/PartiesPage";
import { ImportPage } from "./pages/ImportPage";
import { BillingPage } from "./pages/BillingPage";
import { BillsPage } from "./pages/BillsPage";
import { BillViewPage } from "./pages/BillViewPage";
import { PurchasePage } from "./pages/PurchasePage";
import { PurchasesPage, PurchaseViewPage } from "./pages/PurchasesPage";
import { ExpiryPage } from "./pages/ExpiryPage";
import { LowStockPage } from "./pages/LowStockPage";
import { ReportsPage } from "./pages/ReportsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { hasDatabase } from "./db";
import { getSettings } from "./db/repo";

type Boot = { status: "loading" } | { status: "ready"; settings: AppSettings } | { status: "error"; msg: string };

export default function App() {
  const [boot, setBoot] = useState<Boot>({ status: "loading" });

  useEffect(() => {
    if (!hasDatabase()) {
      setBoot({ status: "ready", settings: {} });
      return;
    }
    // First open runs the migrations, so this also creates or upgrades the database.
    getSettings()
      .then((settings) => setBoot({ status: "ready", settings: settings as AppSettings }))
      .catch((e) => setBoot({ status: "error", msg: String(e) }));
  }, []);

  if (boot.status === "loading") {
    return <div className="grid min-h-screen place-items-center text-ink-soft">MedShop…</div>;
  }
  if (boot.status === "error") {
    return (
      <div role="alert" className="m-10 rounded-xl bg-bad-soft p-6 text-bad">
        Database error: {boot.msg}
      </div>
    );
  }

  const lang = (["en", "hi", "mr"].includes(boot.settings.language ?? "") ? boot.settings.language : "hi") as Lang;
  return (
    <SettingsProvider initial={boot.settings}>
      <I18nProvider initial={lang}>
        <HashRouter>
          <AppRoutes />
        </HashRouter>
      </I18nProvider>
    </SettingsProvider>
  );
}

function AppRoutes() {
  const { settings } = useSettings();
  const nearDays = nearDaysOf(settings);

  // Daily safety copy. Runs in the background; a failure never blocks the counter.
  useEffect(() => {
    if (hasDatabase()) invoke("backup_auto", { dir: settings.backup_dir?.trim() || null }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Routes>
      <Route element={<AppShell shopName={settings.shop_name ?? ""} />}>
        <Route index element={<Home nearDays={nearDays} />} />
        <Route path="bill" element={<BillingPage />} />
        <Route path="bills" element={<BillsPage />} />
        <Route path="bills/:id" element={<BillViewPage />} />
        <Route path="purchase" element={<PurchasePage />} />
        <Route path="purchases" element={<PurchasesPage />} />
        <Route path="purchases/:id" element={<PurchaseViewPage />} />
        <Route path="stock" element={<ItemsPage />} />
        <Route path="stock/items/:id" element={<ItemEditPage />} />
        <Route path="low-stock" element={<LowStockPage />} />
        <Route path="suppliers" element={<PartiesPage table="suppliers" />} />
        <Route path="customers" element={<PartiesPage table="customers" />} />
        <Route path="import" element={<ImportPage />} />
        <Route path="expiry" element={<ExpiryPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Home nearDays={nearDays} />} />
      </Route>
    </Routes>
  );
}
