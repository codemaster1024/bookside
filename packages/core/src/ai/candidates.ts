import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { books, chapters, highlights, notes } from "../db/schema.ts";
import type { Conn } from "../domain/conn.ts";
import { refOf } from "./brief.ts";

/** 哪一种 AI 处理的"已考虑"标记：追问生成或跨书激活，各自独立推进。 */
export type Marker = "probe" | "activation";

const COLUMNS = {
  probe: { highlight: highlights.probeConsideredAt, note: notes.probeConsideredAt, hKey: "probeConsideredAt", nKey: "probeConsideredAt" },
  activation: {
    highlight: highlights.activationConsideredAt,
    note: notes.activationConsideredAt,
    hKey: "activationConsideredAt",
    nKey: "activationConsideredAt",
  },
} as const;

export type Candidate = {
  highlightId: string;
  text: string;
  chapter: string | null;
  /** 划线本身尚未考虑过；否则只是作为新想法的上下文出现。 */
  isNew: boolean;
  notes: { noteId: string; content: string; isNew: boolean }[];
};

/** 有尚未考虑过的划线或想法的书（源端已删除的不算）。 */
export function booksWithCandidates(db: Conn, marker: Marker): { id: string; title: string; author: string | null }[] {
  const col = COLUMNS[marker];
  const pick = { id: books.id, title: books.title, author: books.author };
  const viaHighlights = db
    .selectDistinct(pick)
    .from(highlights)
    .innerJoin(books, eq(books.id, highlights.bookId))
    .where(and(isNull(col.highlight), isNull(highlights.deletedAtSourceAt)))
    .all();
  const viaNotes = db
    .selectDistinct(pick)
    .from(notes)
    .innerJoin(highlights, eq(highlights.id, notes.highlightId))
    .innerJoin(books, eq(books.id, highlights.bookId))
    .where(and(isNull(col.note), isNull(notes.deletedAtSourceAt), isNull(highlights.deletedAtSourceAt)))
    .all();
  return [...new Map([...viaHighlights, ...viaNotes].map((b) => [b.id, b])).values()];
}

/**
 * 一本书里的候选：新划线连同其想法，以及挂在旧划线上的新想法（旧划线作为上下文）。
 * 给 asOf 时只把那之前导入的算作新内容：写回时据此认出交给智能体的是哪一批，期间新同步进来的留到下一批。
 */
export function loadCandidates(db: Conn, bookId: string, marker: Marker, asOf?: Date): Candidate[] {
  const col = COLUMNS[marker];
  const rows = db
    .select({ h: highlights, chapter: chapters.title })
    .from(highlights)
    .leftJoin(chapters, eq(chapters.id, highlights.chapterId))
    .where(and(eq(highlights.bookId, bookId), isNull(highlights.deletedAtSourceAt)))
    .orderBy(asc(highlights.markedAt), asc(sql`${highlights}.rowid`))
    .all();
  const ids = rows.map((r) => r.h.id);
  const noteRows = ids.length
    ? db
        .select()
        .from(notes)
        .where(and(inArray(notes.highlightId, ids), isNull(notes.deletedAtSourceAt)))
        .orderBy(asc(notes.writtenAt), asc(sql`${notes}.rowid`))
        .all()
    : [];

  const out: Candidate[] = [];
  for (const { h, chapter } of rows) {
    const hNotes = noteRows
      .filter((x) => x.highlightId === h.id)
      .map((x) => ({ noteId: x.id, content: x.content, isNew: !x[col.nKey] && importedBy(x.createdAt, asOf) }));
    const isNew = !h[col.hKey] && importedBy(h.createdAt, asOf);
    if (!isNew && !hNotes.some((x) => x.isNew)) continue;
    out.push({ highlightId: h.id, text: h.text, chapter: chapter || null, isNew, notes: hNotes });
  }
  return out;
}

const importedBy = (createdAt: Date, asOf?: Date) => !asOf || createdAt.getTime() <= asOf.getTime();

export function markConsidered(tx: Conn, candidates: Candidate[], marker: Marker, now: Date): void {
  const col = COLUMNS[marker];
  const hIds = candidates.filter((c) => c.isNew).map((c) => c.highlightId);
  const nIds = candidates.flatMap((c) => c.notes.filter((x) => x.isNew).map((x) => x.noteId));
  if (hIds.length) tx.update(highlights).set({ [col.hKey]: now }).where(inArray(highlights.id, hIds)).run();
  if (nIds.length) tx.update(notes).set({ [col.nKey]: now }).where(inArray(notes.id, nIds)).run();
}


/** 候选里可以作为目标的新对象（brief 里标了「新」的）。 */
export function newTargets(candidates: Candidate[]): {
  highlights: { type: "highlight"; id: string }[];
  notes: { type: "note"; id: string }[];
} {
  return {
    highlights: candidates.filter((c) => c.isNew).map((c) => ({ type: "highlight" as const, id: c.highlightId })),
    notes: candidates.flatMap((c) => c.notes.filter((n) => n.isNew).map((n) => ({ type: "note" as const, id: n.noteId }))),
  };
}

/** 给智能体看的候选：新对象标「新」，旧划线只作上下文。 */
export function renderCandidates(candidates: Candidate[]): string[] {
  const lines: string[] = [];
  for (const c of candidates) {
    const where = c.chapter ? `（${c.chapter}）` : "";
    lines.push(c.isNew ? `[${refOf("highlight", c.highlightId)}] 新划线${where}：${c.text}` : `旧划线${where}，只作上下文：${c.text}`);
    for (const n of c.notes) {
      lines.push(n.isNew ? `    [${refOf("note", n.noteId)}] 新想法：${n.content}` : `    旧想法：${n.content}`);
    }
  }
  return lines;
}
