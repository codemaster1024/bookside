import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openDb } from "./client.ts";

describe("openDb", () => {
  it("opens an in-memory database with foreign keys on", () => {
    const db = openDb(":memory:");
    const row = db.get<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`);
    expect(row.foreign_keys).toBe(1);
  });
});
