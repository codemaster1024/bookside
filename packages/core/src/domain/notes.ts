import { eq } from "drizzle-orm";
import { highlights, notes } from "../db/schema.ts";
import type { Conn } from "./conn.ts";
import { notFound } from "./errors.ts";

export type Note = typeof notes.$inferSelect;

/** 在书畔里对一条划线写下想法（来源为本地）。 */
export function addLocalNote(conn: Conn, highlightId: string, content: string, now = new Date()): Note {
  if (!conn.select({ id: highlights.id }).from(highlights).where(eq(highlights.id, highlightId)).get()) {
    throw notFound("划线", highlightId);
  }
  return conn
    .insert(notes)
    .values({ highlightId, source: "local", content: content.trim(), writtenAt: now, createdAt: now, probeConsideredAt: now, activationConsideredAt: now })
    .returning()
    .get();
}
