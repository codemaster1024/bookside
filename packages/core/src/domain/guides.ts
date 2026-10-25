import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { type GuideDepth, chapters, guides } from "../db/schema.ts";
import type { Conn } from "./conn.ts";

export type Guide = typeof guides.$inferSelect;
export type GuideView = Guide & { chapterTitle: string | null; chapterIdx: number | null };

/** 某本书最新的全书导读或速览（chapterId 省略），或某一章最新的章节导读。 */
export function latestGuide(conn: Conn, bookId: string, chapterId?: string, depth: GuideDepth = "full"): Guide | undefined {
  return conn
    .select()
    .from(guides)
    .where(and(eq(guides.bookId, bookId), chapterId ? eq(guides.chapterId, chapterId) : isNull(guides.chapterId), eq(guides.depth, depth)))
    .orderBy(desc(guides.createdAt), desc(sql`${guides}.rowid`))
    .get();
}

/** 一本书的导读：速览、全书导读在前，章节导读按章节顺序；每个范围、每种篇幅只取最新一份。 */
export function listGuides(conn: Conn, bookId: string): GuideView[] {
  const rows = conn
    .select({ g: guides, title: chapters.title, idx: chapters.idx })
    .from(guides)
    .leftJoin(chapters, eq(chapters.id, guides.chapterId))
    .where(eq(guides.bookId, bookId))
    .orderBy(desc(guides.createdAt), desc(sql`${guides}.rowid`))
    .all();
  const latest = new Map<string, GuideView>();
  for (const { g, title, idx } of rows) {
    const key = `${g.chapterId ?? ""}:${g.depth}`;
    if (!latest.has(key)) latest.set(key, { ...g, chapterTitle: title, chapterIdx: idx });
  }
  const depthOrder = (g: GuideView) => (g.depth === "quick" ? 0 : 1);
  return [...latest.values()].sort((a, b) => (a.chapterIdx ?? -1) - (b.chapterIdx ?? -1) || depthOrder(a) - depthOrder(b));
}
