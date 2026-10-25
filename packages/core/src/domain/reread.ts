// 重温：你想翻翻旧划线时，挑几条很久以前划的拿出来，看看现在读来怎么想。只在你要的时候给，不推送。
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { books, chapters, highlights, notes } from "../db/schema.ts";
import type { Conn } from "./conn.ts";

const DAY = 24 * 60 * 60 * 1000;
/** 划了多久以上才算旧划线。 */
const OLD_DAYS = 30;
/** 重温过的多久内不再拿出来。 */
const REST_DAYS = 60;

export type Reread = {
  highlightId: string;
  text: string;
  bookId: string;
  bookTitle: string;
  chapter: string | null;
  markedAt: Date;
  notes: { content: string; writtenAt: Date }[];
};

/** 挑几条旧划线：写过想法的优先，其余随机；挑中的记下时间，两个月内不再重复。 */
export function pickRereads(conn: Conn, opts: { count?: number; bookId?: string } = {}, now = new Date(), random = Math.random): Reread[] {
  const count = opts.count ?? 3;
  const rows = conn
    .select({ h: highlights, bookTitle: books.title, chapter: chapters.title })
    .from(highlights)
    .innerJoin(books, eq(books.id, highlights.bookId))
    .leftJoin(chapters, eq(chapters.id, highlights.chapterId))
    .where(
      and(
        isNull(highlights.deletedAtSourceAt),
        eq(highlights.kind, "marked"),
        lt(highlights.markedAt, new Date(now.getTime() - OLD_DAYS * DAY)),
        or(isNull(highlights.rereadAt), lt(highlights.rereadAt, new Date(now.getTime() - REST_DAYS * DAY))),
        opts.bookId ? eq(highlights.bookId, opts.bookId) : undefined,
      ),
    )
    .all();
  const noted = new Set(conn.select({ h: notes.highlightId }).from(notes).where(isNull(notes.deletedAtSourceAt)).all().map((r) => r.h));
  const picked = rows
    .map((r) => ({ r, score: (noted.has(r.h.id) ? 1 : 0) + random() }))
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map(({ r }) => r);
  return conn.transaction((tx) =>
    picked.map(({ h, bookTitle, chapter }) => {
      tx.update(highlights).set({ rereadAt: now }).where(eq(highlights.id, h.id)).run();
      const ns = tx
        .select({ content: notes.content, writtenAt: notes.writtenAt })
        .from(notes)
        .where(and(eq(notes.highlightId, h.id), isNull(notes.deletedAtSourceAt)))
        .all();
      return { highlightId: h.id, text: h.text, bookId: h.bookId, bookTitle, chapter: chapter || null, markedAt: h.markedAt, notes: ns };
    }),
  );
}
