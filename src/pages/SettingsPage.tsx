import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useT } from "../i18n/I18nProvider";
import { LANGS, type Lang } from "../i18n/strings";
import { useSettings } from "../app/SettingsContext";
import { hasDatabase } from "../db";
import { saveSettings } from "../db/ops";
import { dbErrorKey } from "../db/errors";
import { gstin as checkGstin } from "../lib/importer/values";
import { Banner, Button, Field, PageHeader, Select, TextInput } from "../components/Form";

interface BackupInfo {
  path: string;
  name: string;
  size: number;
  modified: number;
}

const KEYS = ["shop_name", "shop_address", "shop_phone", "gstin", "dl_no_20", "dl_no_21", "pharmacist_name", "bill_prefix", "paper", "print_after_save", "bill_footer", "near_expiry_days", "backup_dir"] as const;
type Key = (typeof KEYS)[number];

export function SettingsPage() {
  const { t, lang, setLang } = useT();
  const { settings, reload } = useSettings();
  const [form, setForm] = useState<Record<Key, string>>(() => Object.fromEntries(KEYS.map((k) => [k, settings[k] ?? ""])) as Record<Key, string>);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [defaultDir, setDefaultDir] = useState("");
  const [restoring, setRestoring] = useState<BackupInfo | { path: string; name: string } | null>(null);
  const [resetText, setResetText] = useState("");
  const desktop = hasDatabase();

  const dir = form.backup_dir.trim() || null;
  const refreshBackups = () => {
    if (!desktop) return;
    invoke<BackupInfo[]>("list_backups", { dir }).then(setBackups).catch(() => setBackups([]));
  };
  useEffect(() => {
    if (desktop) invoke<string>("default_backup_dir").then(setDefaultDir).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(refreshBackups, [dir, desktop]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: Key, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const g = checkGstin(form.gstin);
  const gstinBad = g !== null && "error" in g;

  async function save() {
    if (gstinBad) return;
    try {
      await saveSettings({ ...form, setup_done: form.shop_name.trim() ? "1" : "0", near_expiry_days: String(Math.min(365, Math.max(7, Number(form.near_expiry_days) || 90))) });
      await reload();
      setMsg({ tone: "ok", text: t("settingsSaved") });
    } catch (e) {
      const { key, raw } = dbErrorKey(e);
      setMsg({ tone: "bad", text: t(key, { msg: raw }) });
    }
  }

  async function wrap(fn: () => Promise<unknown>, ok?: (r: unknown) => string) {
    setMsg(null);
    try {
      const r = await fn();
      if (ok) setMsg({ tone: "ok", text: ok(r) });
    } catch (e) {
      const { key, raw } = dbErrorKey(e);
      setMsg({ tone: "bad", text: t(key, { msg: raw }) });
    }
  }

  async function chooseFolder() {
    const picked = await open({ directory: true, multiple: false, defaultPath: dir ?? defaultDir });
    if (typeof picked === "string") set("backup_dir", picked);
  }

  async function chooseFile() {
    const picked = await open({ multiple: false, directory: false, defaultPath: dir ?? defaultDir, filters: [{ name: "MedShop backup", extensions: ["db"] }] });
    if (typeof picked === "string") setRestoring({ path: picked, name: picked.split(/[\\/]/).pop() ?? picked });
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const when = (s: number) => new Date(s * 1000).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

  return (
    <div className="space-y-5">
      <PageHeader title={t("settings")} actions={<Button kind="primary" onClick={save} kbd="Ctrl+S">{t("saveSettings")}</Button>} />
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}

      <section className="grid grid-cols-1 gap-4 rounded-xl border border-line bg-card p-5 md:grid-cols-2">
        <h2 className="font-semibold md:col-span-2">{t("secShop")}</h2>
        <Field label={t("fShopName")} htmlFor="s-name" required><TextInput id="s-name" value={form.shop_name} onChange={(e) => set("shop_name", e.target.value)} maxLength={80} /></Field>
        <Field label={t("fShopPhone")} htmlFor="s-ph"><TextInput id="s-ph" value={form.shop_phone} onChange={(e) => set("shop_phone", e.target.value)} maxLength={40} /></Field>
        <Field label={t("fShopAddress")} htmlFor="s-addr" className="md:col-span-2"><TextInput id="s-addr" value={form.shop_address} onChange={(e) => set("shop_address", e.target.value)} maxLength={200} /></Field>
        <Field label={t("fShopGstin")} htmlFor="s-gst" error={gstinBad ? t("gstinInvalid") : null}><TextInput id="s-gst" value={form.gstin} onChange={(e) => set("gstin", e.target.value.toUpperCase().replace(/\s/g, ""))} maxLength={15} /></Field>
        <Field label={t("fPharmacist")} htmlFor="s-ph2"><TextInput id="s-ph2" value={form.pharmacist_name} onChange={(e) => set("pharmacist_name", e.target.value)} maxLength={80} /></Field>
        <Field label={t("fDl20")} htmlFor="s-dl20"><TextInput id="s-dl20" value={form.dl_no_20} onChange={(e) => set("dl_no_20", e.target.value.toUpperCase())} maxLength={60} /></Field>
        <Field label={t("fDl21")} htmlFor="s-dl21"><TextInput id="s-dl21" value={form.dl_no_21} onChange={(e) => set("dl_no_21", e.target.value.toUpperCase())} maxLength={60} /></Field>
      </section>

      <section className="grid grid-cols-1 gap-4 rounded-xl border border-line bg-card p-5 md:grid-cols-2">
        <h2 className="font-semibold md:col-span-2">{t("secBill")}</h2>
        <Field label={t("fBillPrefix")} htmlFor="s-pre" hint={t("hintBillPrefix")}><TextInput id="s-pre" value={form.bill_prefix} onChange={(e) => set("bill_prefix", e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 6))} /></Field>
        <Field label={t("fPaper")} htmlFor="s-paper">
          <Select id="s-paper" value={form.paper || "80mm"} onChange={(e) => set("paper", e.target.value)}>
            <option value="80mm">{t("paper80mm")}</option>
            <option value="58mm">{t("paper58mm")}</option>
            <option value="A5">{t("paperA5")}</option>
            <option value="A4">{t("paperA4")}</option>
          </Select>
        </Field>
        <Field label={t("fFooter")} htmlFor="s-foot" className="md:col-span-2"><TextInput id="s-foot" value={form.bill_footer} onChange={(e) => set("bill_footer", e.target.value)} maxLength={160} /></Field>
        <label className="flex items-center gap-2 md:col-span-2">
          <input type="checkbox" checked={form.print_after_save !== "0"} onChange={(e) => set("print_after_save", e.target.checked ? "1" : "0")} className="h-4 w-4" />
          {t("fPrintAfter")}
        </label>
        <Field label={t("fNearDays")} htmlFor="s-near"><TextInput id="s-near" inputMode="numeric" value={form.near_expiry_days} onChange={(e) => set("near_expiry_days", e.target.value.replace(/\D/g, ""))} /></Field>
        <Field label={t("language")} htmlFor="s-lang">
          <Select id="s-lang" value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
            {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </Select>
        </Field>
      </section>

      <section className="space-y-3 rounded-xl border border-line bg-card p-5">
        <h2 className="font-semibold">{t("secBackup")}</h2>
        <p className="text-sm text-ink-soft">{t("backupHint")}</p>
        {!desktop && <Banner tone="warn">{t("desktopOnly")}</Banner>}
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t("fBackupDir")} htmlFor="s-bdir" className="min-w-96 flex-1">
            <TextInput id="s-bdir" value={form.backup_dir} placeholder={defaultDir} onChange={(e) => set("backup_dir", e.target.value)} />
          </Field>
          <Button onClick={chooseFolder} disabled={!desktop}>{t("chooseFolder")}</Button>
          <Button kind="primary" disabled={!desktop} onClick={() => wrap(() => invoke<BackupInfo>("backup_now", { dir }), (r) => { refreshBackups(); return t("backupDone", { name: (r as BackupInfo).name }); })}>
            {t("backupNow")}
          </Button>
        </div>
        <h3 className="pt-2 text-sm font-semibold text-ink-soft">{t("recentBackups")}</h3>
        {backups.length === 0 ? <p className="text-sm text-ink-soft">{t("noBackupsYet")}</p> : (
          <ul className="max-h-60 divide-y divide-line overflow-auto rounded-lg border border-line text-sm">
            {backups.map((b) => (
              <li key={b.path} className="flex items-center justify-between px-3 py-1.5">
                <span><span className="font-mono">{b.name}</span> <span className="text-ink-soft">· {when(b.modified)} · {(b.size / 1024 / 1024).toFixed(1)} MB</span></span>
                <button type="button" className="text-brand hover:underline" onClick={() => setRestoring(b)}>{t("restoreBtn")}</button>
              </li>
            ))}
          </ul>
        )}
        <Button onClick={chooseFile} disabled={!desktop}>{t("restoreFromFile")}</Button>
        {restoring && (
          <Banner tone="warn">
            <p>{t("restoreConfirm", { name: restoring.name })}</p>
            <div className="mt-2 flex gap-2">
              <Button kind="primary" onClick={() => wrap(() => invoke("restore_backup", { path: restoring.path, dir }))}>{t("restoreBtn")}</Button>
              <Button onClick={() => setRestoring(null)}>{t("close")}</Button>
            </div>
          </Banner>
        )}
      </section>

      <section className="space-y-3 rounded-xl border border-bad/30 bg-card p-5">
        <h2 className="font-semibold text-bad">{t("secReset")}</h2>
        <p className="text-sm text-ink-soft">{t("resetHint")}</p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t("resetType")} htmlFor="s-reset"><TextInput id="s-reset" value={resetText} onChange={(e) => setResetText(e.target.value)} className="w-48" /></Field>
          <Button disabled={!desktop || resetText !== "DELETE"} onClick={() => wrap(() => invoke("reset_data", { dir }))}>{t("resetBtn")}</Button>
        </div>
      </section>
    </div>
  );
}
