//! Backup, restore and reset of the shop database.
//!
//! * Backups use SQLite `VACUUM INTO`: a complete, consistent copy, even while the app is in use.
//! * Restore and reset cannot replace a database file that is open, so they leave a "pending"
//!   file and restart the app; `apply_pending` swaps the files at startup, before anything opens them.
//! * Before a restore or reset, the current data is always backed up first.

use crate::batch::BatchDb;
use chrono::Local;
use serde::Serialize;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Row};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager, State};

const DB_FILE: &str = "medshop.db";
const RESTORE_PENDING: &str = "restore-pending.db";
const RESET_PENDING: &str = "reset-pending";
const KEEP: usize = 30;

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

/// Default backup folder: Documents\MedShop Backups (easy to find and to copy to a pen drive).
#[tauri::command]
pub fn default_backup_dir(app: AppHandle) -> Result<String, String> {
    let docs = app.path().document_dir().map_err(|e| e.to_string())?;
    Ok(docs.join("MedShop Backups").to_string_lossy().into_owned())
}

fn backup_dir(app: &AppHandle, dir: Option<String>) -> Result<PathBuf, String> {
    let d = match dir.filter(|d| !d.trim().is_empty()) {
        Some(d) => PathBuf::from(d),
        None => PathBuf::from(default_backup_dir(app.clone())?),
    };
    fs::create_dir_all(&d).map_err(|e| format!("cannot create {}: {e}", d.display()))?;
    Ok(d)
}

#[derive(Serialize)]
pub struct BackupInfo {
    path: String,
    name: String,
    size: u64,
    /// Seconds since the Unix epoch.
    modified: u64,
}

fn list(dir: &Path) -> Vec<(PathBuf, SystemTime, u64)> {
    let mut v: Vec<_> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let name = p.file_name()?.to_string_lossy().into_owned();
            if !(name.starts_with("MedShop-") && name.ends_with(".db")) {
                return None;
            }
            let m = e.metadata().ok()?;
            Some((p, m.modified().ok()?, m.len()))
        })
        .collect();
    v.sort_by(|a, b| b.1.cmp(&a.1)); // newest first
    v
}

async fn vacuum_into(app: &AppHandle, state: &BatchDb, dest: &Path) -> Result<(), String> {
    let pool = crate::batch::pool(app, state).await?;
    sqlx::query("VACUUM INTO $1")
        .bind(dest.to_string_lossy().into_owned())
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

async fn make_backup(app: &AppHandle, state: &BatchDb, dir: Option<String>, tag: &str) -> Result<BackupInfo, String> {
    let d = backup_dir(app, dir)?;
    let name = format!("MedShop-{}{}.db", Local::now().format("%Y%m%d-%H%M%S"), tag);
    let dest = d.join(&name);
    vacuum_into(app, state, &dest).await?;
    for (old, _, _) in list(&d).into_iter().skip(KEEP) {
        let _ = fs::remove_file(old);
    }
    let size = fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    Ok(BackupInfo { path: dest.to_string_lossy().into_owned(), name, size, modified: now_secs() })
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[tauri::command]
pub async fn backup_now(app: AppHandle, state: State<'_, BatchDb>, dir: Option<String>) -> Result<BackupInfo, String> {
    make_backup(&app, &state, dir, "").await
}

/// Called at startup: makes a backup if the newest one is older than 20 hours.
#[tauri::command]
pub async fn backup_auto(app: AppHandle, state: State<'_, BatchDb>, dir: Option<String>) -> Result<Option<BackupInfo>, String> {
    let d = backup_dir(&app, dir.clone())?;
    let fresh = list(&d)
        .first()
        .map(|(_, t, _)| t.elapsed().unwrap_or(Duration::MAX) < Duration::from_secs(20 * 3600))
        .unwrap_or(false);
    if fresh {
        return Ok(None);
    }
    make_backup(&app, &state, dir, "").await.map(Some)
}

#[tauri::command]
pub fn list_backups(app: AppHandle, dir: Option<String>) -> Result<Vec<BackupInfo>, String> {
    let d = backup_dir(&app, dir)?;
    Ok(list(&d)
        .into_iter()
        .map(|(p, t, size)| BackupInfo {
            name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            path: p.to_string_lossy().into_owned(),
            size,
            modified: t.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
        })
        .collect())
}

/// Check that a file really is a MedShop database before we put it in place.
async fn check_medshop_db(path: &Path) -> Result<(), String> {
    let mut head = [0u8; 16];
    use std::io::Read;
    fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut head))
        .map_err(|e| format!("cannot read file: {e}"))?;
    if &head != b"SQLite format 3\0" {
        return Err("NOT_A_BACKUP".into());
    }
    let mut conn = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .connect()
        .await
        .map_err(|e| e.to_string())?;
    let n: i64 = sqlx::query("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('items', 'batches', 'sales')")
        .fetch_one(&mut conn)
        .await
        .map_err(|e| e.to_string())?
        .get("n");
    if n < 3 {
        return Err("NOT_A_BACKUP".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn restore_backup(app: AppHandle, state: State<'_, BatchDb>, path: String, dir: Option<String>) -> Result<(), String> {
    let src = PathBuf::from(&path);
    check_medshop_db(&src).await?;
    make_backup(&app, &state, dir, "-before-restore").await?;
    fs::copy(&src, config_dir(&app)?.join(RESTORE_PENDING)).map_err(|e| e.to_string())?;
    app.restart();
}

#[tauri::command]
pub async fn reset_data(app: AppHandle, state: State<'_, BatchDb>, dir: Option<String>) -> Result<(), String> {
    make_backup(&app, &state, dir, "-before-reset").await?;
    fs::write(config_dir(&app)?.join(RESET_PENDING), b"1").map_err(|e| e.to_string())?;
    app.restart();
}

/// Runs in `setup`, before the frontend opens the database.
pub fn apply_pending(app: &AppHandle) -> Result<(), String> {
    let dir = config_dir(app)?;
    let db = dir.join(DB_FILE);
    let remove_db = || {
        for ext in ["", "-wal", "-shm"] {
            let _ = fs::remove_file(dir.join(format!("{DB_FILE}{ext}")));
        }
    };
    let reset = dir.join(RESET_PENDING);
    if reset.exists() {
        remove_db();
        let _ = fs::remove_file(&reset);
    }
    let pending = dir.join(RESTORE_PENDING);
    if pending.exists() {
        remove_db();
        fs::rename(&pending, &db).map_err(|e| e.to_string())?;
    }
    Ok(())
}
