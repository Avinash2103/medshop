// Test helpers: a fresh in-memory database with the real migrations, and a runner
// that behaves like the Rust run_batch command (one transaction, all or nothing).
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Batch } from "../db/batch";

const root = new URL("../../", import.meta.url);
export const readRepoFile = (p: string) => readFileSync(new URL(p, root), "utf8");

export function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const dir = new URL("src-tauri/migrations/", root);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  return db;
}

const conv = (sql: string) => sql.replace(/\$(\d+)/g, "?$1");

export function runBatch(db: DatabaseSync, batch: Batch): { rows_affected: number[]; last_ids: number[] } {
  const rows_affected: number[] = [];
  const last_ids: number[] = [];
  db.exec("BEGIN");
  try {
    for (const { sql, params } of batch.toList()) {
      const r = db.prepare(conv(sql)).run(...params);
      rows_affected.push(Number(r.changes));
      last_ids.push(Number(r.lastInsertRowid));
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { rows_affected, last_ids };
}

export function get<T>(db: DatabaseSync, sql: string, ...params: (string | number | null)[]): T {
  return db.prepare(conv(sql)).get(...params) as T;
}

export function all<T>(db: DatabaseSync, sql: string, ...params: (string | number | null)[]): T[] {
  return db.prepare(conv(sql)).all(...params) as T[];
}
