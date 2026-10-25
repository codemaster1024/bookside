import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.ts";

// 从源码运行时在 packages/core/migrations；打包进 npm 包后在包根目录的 migrations（与 dist 同级）。
const MIGRATIONS = [join(import.meta.dirname, "../../migrations"), join(import.meta.dirname, "../migrations")].find((p) => existsSync(p))!;

export type Db = ReturnType<typeof openDb>;

/** 打开（必要时创建）SQLite 数据库并迁移到最新结构；传 ":memory:" 用于测试。 */
export function openDb(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}
