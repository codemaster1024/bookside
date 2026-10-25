// 全局搜索：一次搜遍书、划线、想法、问题（含线程里的话）和观点。
// 读者的库最多几万条，直接 LIKE 就够快；空格分开的几个词要同时出现。
import { type SQL, and, desc, eq, isNull, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { books, highlights, insightSources, insightVersions, messages, notes, questions } from "../db/schema.ts";
import type { Conn } from "./conn.ts";

export type SearchKind = "book" | "highlight" | "note" | "question" | "insight";

export type SearchHit = {
  kind: SearchKind;
  id: string;
  /** 主要文字：书名、划线、想法、问题标题…… */
  title: string;
  /** 命中处前后的一小段（标题本身没命中时，如问题线程里的话）。 */
  snippet: string | null;
  bookId: string | null;
  bookTitle: string | null;
  chapterId: string | null;
  questionId: string | null;
};

const PER_KIND = 8;
const SNIPPET = 60;

const escape = (w: string) => w.replace(/[\\%_]/g, (c) => `\\${c}`);

/** 每个词都要出现在这一列里。 */
function matchAll(col: SQLiteColumn | SQL, words: string[]): SQL {
  return and(...words.map((w) => sql`${col} like ${`%${escape(w)}%`} escape '\\'`))!;
}

/** 第一个命中词前后各取一段，多余的用省略号。 */
export function snippetOf(text: string, words: string[], size = SNIPPET): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const at = Math.min(...words.map((w) => lower.indexOf(w.toLowerCase())).filter((i) => i >= 0), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(at) || flat.length <= size * 2) return flat.length <= size * 2 ? flat : `${flat.slice(0, size * 2)}…`;
  const start = Math.max(0, at - Math.floor(size / 2));
  const end = Math.min(flat.length, start + size * 2);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

export function searchAll(conn: Conn, query: string, perKind = PER_KIND): SearchHit[] {
  const words = query.trim().split(/\s+/).filter(Boolean).slice(0, 5);
  if (words.length === 0) return [];
  const hits: SearchHit[] = [];
  const base = { snippet: null, bookId: null, bookTitle: null, chapterId: null, questionId: null };

  for (const b of conn
    .select()
    .from(books)
    .where(matchAll(sql`${books.title} || ' ' || coalesce(${books.author}, '')`, words))
    .orderBy(desc(books.createdAt))
    .limit(perKind)
    .all()) {
    hits.push({ ...base, kind: "book", id: b.id, title: b.title, snippet: b.author, bookId: b.id, bookTitle: b.title });
  }

  for (const h of conn
    .select({ id: highlights.id, text: highlights.text, bookId: books.id, bookTitle: books.title, chapterId: highlights.chapterId })
    .from(highlights)
    .innerJoin(books, eq(books.id, highlights.bookId))
    .where(and(matchAll(highlights.text, words), isNull(highlights.deletedAtSourceAt)))
    .orderBy(desc(highlights.markedAt))
    .limit(perKind)
    .all()) {
    hits.push({ ...base, kind: "highlight", id: h.id, title: snippetOf(h.text, words), bookId: h.bookId, bookTitle: h.bookTitle, chapterId: h.chapterId });
  }

  for (const n of conn
    .select({ id: notes.id, content: notes.content, quote: highlights.text, bookId: books.id, bookTitle: books.title, chapterId: highlights.chapterId })
    .from(notes)
    .innerJoin(highlights, eq(highlights.id, notes.highlightId))
    .innerJoin(books, eq(books.id, highlights.bookId))
    .where(and(matchAll(notes.content, words), isNull(notes.deletedAtSourceAt)))
    .orderBy(desc(notes.writtenAt))
    .limit(perKind)
    .all()) {
    hits.push({
      ...base,
      kind: "note",
      id: n.id,
      title: snippetOf(n.content, words),
      snippet: `划线：${snippetOf(n.quote, [], 30)}`,
      bookId: n.bookId,
      bookTitle: n.bookTitle,
      chapterId: n.chapterId,
    });
  }

  // 问题：标题命中，或线程里的某句话命中（取最近的一句）。
  const qSeen = new Set<string>();
  for (const q of conn.select().from(questions).where(matchAll(questions.title, words)).orderBy(desc(questions.createdAt)).limit(perKind).all()) {
    qSeen.add(q.id);
    hits.push({ ...base, kind: "question", id: q.id, title: q.title, questionId: q.id });
  }
  for (const m of conn
    .select({ qid: messages.questionId, content: messages.content, speaker: messages.speaker, title: questions.title })
    .from(messages)
    .innerJoin(questions, eq(questions.id, messages.questionId))
    .where(matchAll(messages.content, words))
    .orderBy(desc(messages.createdAt))
    .limit(perKind * 3)
    .all()) {
    if (qSeen.has(m.qid) || qSeen.size >= perKind) continue;
    qSeen.add(m.qid);
    hits.push({ ...base, kind: "question", id: m.qid, title: m.title, snippet: `${m.speaker === "me" ? "你" : "AI"}：${snippetOf(m.content, words)}`, questionId: m.qid });
  }

  // 观点：只看每条的最新版本。
  const latest = conn
    .select({ insightId: insightVersions.insightId, content: insightVersions.content, at: sql<number>`max(${insightVersions.createdAt})`.as("at") })
    .from(insightVersions)
    .groupBy(insightVersions.insightId)
    .as("latest");
  for (const i of conn
    .select({ id: latest.insightId, content: latest.content })
    .from(latest)
    .where(matchAll(latest.content, words))
    .orderBy(desc(latest.at))
    .limit(perKind)
    .all()) {
    const src = conn
      .select({ q: insightSources.questionId, h: insightSources.highlightId, b: insightSources.bookId })
      .from(insightSources)
      .where(eq(insightSources.insightId, i.id))
      .get();
    const hb = src?.h ? conn.select({ b: highlights.bookId }).from(highlights).where(eq(highlights.id, src.h)).get()?.b : undefined;
    const bookId = src?.b ?? hb ?? null;
    const bookTitle = bookId ? (conn.select({ t: books.title }).from(books).where(eq(books.id, bookId)).get()?.t ?? null) : null;
    hits.push({ ...base, kind: "insight", id: i.id, title: snippetOf(i.content, words), bookId, bookTitle, questionId: src?.q ?? null });
  }

  return hits;
}
