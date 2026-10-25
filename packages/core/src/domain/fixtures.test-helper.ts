import { type Db, openDb } from "../db/client.ts";
import { books, highlights, notes } from "../db/schema.ts";

export const T0 = new Date("2026-10-01T00:00:00Z");
export const days = (n: number) => new Date(T0.getTime() + n * 24 * 60 * 60 * 1000);

/** 一个内存库，里面有一本书、一条划线和挂在其上的一条想法。 */
export function seed(): { db: Db; bookId: string; highlightId: string; noteId: string } {
  const db = openDb(":memory:");
  const bookId = db.insert(books).values({ source: "weread", title: "书" }).returning().get().id;
  const highlightId = db
    .insert(highlights)
    .values({ bookId, source: "weread", text: "原文", markedAt: T0 })
    .returning()
    .get().id;
  const noteId = db
    .insert(notes)
    .values({ highlightId, source: "weread", content: "作者在偷换概念", writtenAt: T0 })
    .returning()
    .get().id;
  return { db, bookId, highlightId, noteId };
}
