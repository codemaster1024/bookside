import { like } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Conn } from "./conn.ts";
import { DomainError, notFound } from "./errors.ts";

/** 列表里展示的短 id 长度。 */
export const SHORT_ID_LENGTH = 8;

export const shortId = (id: string) => id.slice(0, SHORT_ID_LENGTH);

/** 把完整 id 或唯一前缀解析为完整 id。 */
export function resolveId(conn: Conn, table: SQLiteTable & { id: SQLiteColumn }, what: string, idOrPrefix: string): string {
  const prefix = idOrPrefix.trim().toLowerCase();
  if (!/^[0-9a-f-]{4,}$/.test(prefix)) throw notFound(what, idOrPrefix);
  const rows = conn
    .select({ id: table.id })
    .from(table)
    .where(like(table.id, `${prefix}%`))
    .limit(2)
    .all() as { id: string }[];
  if (rows.length === 0) throw notFound(what, idOrPrefix);
  if (rows.length > 1) throw new DomainError("ambiguous_id", `${what} ${idOrPrefix} 对应多条记录，请多写几位`);
  return rows[0]!.id;
}
