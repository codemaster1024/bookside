import type { RunResult } from "better-sqlite3";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "../db/schema.ts";

/** 数据库或其中的事务；领域函数都接受它，以便组合进同一个事务。 */
export type Conn = BaseSQLiteDatabase<"sync", RunResult, typeof schema>;
