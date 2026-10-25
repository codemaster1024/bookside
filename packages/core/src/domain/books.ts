import { and, asc, count, desc, eq, inArray, isNull, like, max, or, sql } from "drizzle-orm";
import { books, chapters, highlights, notes, questions, reviews } from "../db/schema.ts";
import type { Conn } from "./conn.ts";
import { notFound } from "./errors.ts";
import { pendingProbes, type Probe } from "./probes.ts";

export type Book = typeof books.$inferSelect;

export type BookSummary = Book & { highlightCount: number; pendingProbeCount: number; questionCount: number };

export type BookDetail = {
  book: Book;
  chapters: {
    id: string | null;
    title: string;
    highlights: (typeof highlights.$inferSelect & { notes: (typeof notes.$inferSelect)[] })[];
  }[];
  pendingProbes: Probe[];
  questions: (typeof questions.$inferSelect)[];
};

export function getBook(conn: Conn, id: string): Book {
  const b = conn.select().from(books).where(eq(books.id, id)).get();
  if (!b) throw notFound("书", id);
  return b;
}

/**
 * 书单，最近有划线的在前；query 按书名或作者模糊匹配。
 * 默认略去"空书"（无划线、无问题、无追问、未写读前目的），搜索或 includeEmpty 时全部返回。
 */
export function listBooks(conn: Conn, filter: { query?: string; includeEmpty?: boolean } = {}): BookSummary[] {
  const where = filter.query ? or(like(books.title, `%${filter.query}%`), like(books.author, `%${filter.query}%`)) : undefined;
  const rows = conn.select().from(books).where(where).all();
  const ids = rows.map((b) => b.id);
  if (ids.length === 0) return [];
  const hl = new Map(
    conn
      .select({ bookId: highlights.bookId, n: count(), last: max(highlights.markedAt) })
      .from(highlights)
      .where(and(inArray(highlights.bookId, ids), isNull(highlights.deletedAtSourceAt)))
      .groupBy(highlights.bookId)
      .all()
      .map((r) => [r.bookId, r]),
  );
  // 起源于书本身、其章节或其划线的问题都算这本书的问题。
  const originBook = sql<string>`coalesce(${questions.originBookId}, ${chapters.bookId}, ${highlights.bookId})`;
  const qs = new Map(
    conn
      .select({ bookId: originBook, n: count() })
      .from(questions)
      .leftJoin(chapters, eq(chapters.id, questions.originChapterId))
      .leftJoin(highlights, eq(highlights.id, questions.originHighlightId))
      .groupBy(originBook)
      .all()
      .map((r) => [r.bookId, r.n]),
  );
  const probeCounts = new Map<string, number>();
  for (const id of ids) probeCounts.set(id, pendingProbes(conn, { bookId: id }).length);
  return rows
    .map((b) => ({
      ...b,
      highlightCount: hl.get(b.id)?.n ?? 0,
      pendingProbeCount: probeCounts.get(b.id) ?? 0,
      questionCount: qs.get(b.id) ?? 0,
      lastMarked: hl.get(b.id)?.last ? new Date(hl.get(b.id)!.last!).getTime() : 0,
    }))
    .filter(
      (b) =>
        filter.query ||
        filter.includeEmpty ||
        b.highlightCount > 0 ||
        b.questionCount > 0 ||
        b.pendingProbeCount > 0 ||
        !!b.purpose,
    )
    .sort((a, b) => b.lastMarked - a.lastMarked || a.title.localeCompare(b.title))
    .map(({ lastMarked: _, ...rest }) => rest);
}

/** 一本书的工作台：按章节排列的划线（含想法）、待处理追问、起源于此书的问题。 */
export function getBookDetail(conn: Conn, bookId: string, opts: { includeDeleted?: boolean } = {}): BookDetail {
  const book = getBook(conn, bookId);
  const chapterRows = conn.select().from(chapters).where(eq(chapters.bookId, bookId)).orderBy(asc(chapters.idx)).all();
  const hlRows = conn
    .select()
    .from(highlights)
    .where(and(eq(highlights.bookId, bookId), opts.includeDeleted ? undefined : isNull(highlights.deletedAtSourceAt)))
    .orderBy(asc(highlights.markedAt))
    .all();
  const noteRows = hlRows.length
    ? conn
        .select()
        .from(notes)
        .where(
          and(
            inArray(
              notes.highlightId,
              hlRows.map((h) => h.id),
            ),
            opts.includeDeleted ? undefined : isNull(notes.deletedAtSourceAt),
          ),
        )
        .orderBy(asc(notes.writtenAt))
        .all()
    : [];
  const withNotes = hlRows.map((h) => ({ ...h, notes: noteRows.filter((n) => n.highlightId === h.id) }));

  const groups = chapterRows
    .map((c) => ({ id: c.id as string | null, title: c.title, highlights: withNotes.filter((h) => h.chapterId === c.id) }))
    .filter((g) => g.highlights.length > 0);
  const unchaptered = withNotes.filter((h) => !h.chapterId);
  if (unchaptered.length) groups.push({ id: null, title: "", highlights: unchaptered });

  const hlIds = hlRows.map((h) => h.id);
  const qs = conn
    .select()
    .from(questions)
    .where(
      or(
        eq(questions.originBookId, bookId),
        inArray(
          questions.originChapterId,
          chapterRows.map((c) => c.id),
        ),
        inArray(questions.originHighlightId, hlIds),
      ),
    )
    .orderBy(desc(questions.createdAt))
    .all();
  return { book, chapters: groups, pendingProbes: pendingProbes(conn, { bookId }), questions: qs };
}

export function setPurpose(conn: Conn, bookId: string, purpose: string): Book {
  getBook(conn, bookId);
  return conn.update(books).set({ purpose }).where(eq(books.id, bookId)).returning().get();
}

/** 追问的挂载对象与原文，便于展示和对话。 */
export function describeProbeTarget(
  conn: Conn,
  p: Probe,
): { bookId: string; bookTitle: string; chapter?: string; quote?: string; note?: string } {
  if (p.bookId) {
    const b = getBook(conn, p.bookId);
    return { bookId: b.id, bookTitle: b.title };
  }
  if (p.chapterId) {
    const c = conn.select().from(chapters).where(eq(chapters.id, p.chapterId)).get()!;
    const b = getBook(conn, c.bookId);
    return { bookId: b.id, bookTitle: b.title, chapter: c.title };
  }
  const note = p.noteId ? conn.select().from(notes).where(eq(notes.id, p.noteId)).get() : undefined;
  const hlId = p.highlightId ?? note!.highlightId;
  const h = conn.select().from(highlights).where(eq(highlights.id, hlId)).get()!;
  const b = getBook(conn, h.bookId);
  return { bookId: b.id, bookTitle: b.title, quote: h.text, ...(note ? { note: note.content } : {}) };
}

/** 书单略去的空书数量，供书单提示。 */
export function countEmptyBooks(conn: Conn): number {
  return listBooks(conn, { includeEmpty: true }).length - listBooks(conn).length;
}

export type Review = typeof reviews.$inferSelect;

/** 书评：chapterId 为 null 时取整本书的书评，否则取这一章的点评；源端已删除的不列出。 */
export function reviewsOf(conn: Conn, bookId: string, chapterId: string | null): Review[] {
  return conn
    .select()
    .from(reviews)
    .where(
      and(
        eq(reviews.bookId, bookId),
        chapterId ? eq(reviews.chapterId, chapterId) : isNull(reviews.chapterId),
        isNull(reviews.deletedAtSourceAt),
      ),
    )
    .orderBy(asc(reviews.writtenAt))
    .all();
}
