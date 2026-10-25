import { and, asc, eq, isNull, or } from "drizzle-orm";
import { chapters, highlights, notes, probes } from "../db/schema.ts";
import type { Conn } from "./conn.ts";
import { DomainError, notFound } from "./errors.ts";
import { type Origin, type Question, createQuestion } from "./questions.ts";

export type Probe = typeof probes.$inferSelect;

export type ProbeTarget = { type: "book" | "chapter" | "highlight" | "note"; id: string };

export function addProbe(conn: Conn, input: { target: ProbeTarget; content: string }, now = new Date()): Probe {
  const { target } = input;
  return conn
    .insert(probes)
    .values({
      content: input.content,
      bookId: target.type === "book" ? target.id : null,
      chapterId: target.type === "chapter" ? target.id : null,
      highlightId: target.type === "highlight" ? target.id : null,
      noteId: target.type === "note" ? target.id : null,
      createdAt: now,
    })
    .returning()
    .get();
}

function getPendingProbe(conn: Conn, probeId: string): Probe {
  const p = conn.select().from(probes).where(eq(probes.id, probeId)).get();
  if (!p) throw notFound("追问", probeId);
  if (p.promotedQuestionId || p.dismissedAt) {
    throw new DomainError("probe_not_pending", `追问 ${probeId} 已升格或已搁置`);
  }
  return p;
}

/** 追问挂在哪里，升格出的问题就起源于哪里；挂在想法上的追问起源于想法所在的划线。 */
function originOf(conn: Conn, p: Probe): Origin {
  if (p.bookId) return { type: "book", id: p.bookId };
  if (p.chapterId) return { type: "chapter", id: p.chapterId };
  if (p.highlightId) return { type: "highlight", id: p.highlightId };
  const note = conn.select({ highlightId: notes.highlightId }).from(notes).where(eq(notes.id, p.noteId!)).get();
  return { type: "highlight", id: note!.highlightId };
}

/** 升格：把追问认领为问题。标题默认沿用追问原文。 */
export function promoteProbe(conn: Conn, probeId: string, input: { title?: string } = {}, now = new Date()): Question {
  return conn.transaction((tx) => {
    const p = getPendingProbe(tx, probeId);
    const q = createQuestion(tx, { title: input.title ?? p.content, origin: originOf(tx, p) }, now);
    tx.update(probes).set({ promotedQuestionId: q.id }).where(eq(probes.id, probeId)).run();
    return q;
  });
}

/** 搁置：不认领这条追问，保留但不再待处理。 */
export function dismissProbe(conn: Conn, probeId: string, now = new Date()): Probe {
  return conn.transaction((tx) => {
    getPendingProbe(tx, probeId);
    return tx.update(probes).set({ dismissedAt: now }).where(eq(probes.id, probeId)).returning().get();
  });
}

/** 待处理的追问；给定 bookId 时只取这本书上的（含挂在其划线和想法上的）。 */
export function pendingProbes(conn: Conn, filter: { bookId?: string } = {}): Probe[] {
  const pending = and(isNull(probes.promotedQuestionId), isNull(probes.dismissedAt));
  const query = conn
    .select({ probe: probes })
    .from(probes)
    .leftJoin(notes, eq(notes.id, probes.noteId))
    .leftJoin(highlights, or(eq(highlights.id, probes.highlightId), eq(highlights.id, notes.highlightId)))
    .leftJoin(chapters, eq(chapters.id, probes.chapterId));
  const where = filter.bookId
    ? and(
        pending,
        or(eq(probes.bookId, filter.bookId), eq(highlights.bookId, filter.bookId), eq(chapters.bookId, filter.bookId)),
      )
    : pending;
  return query
    .where(where)
    .orderBy(asc(probes.createdAt))
    .all()
    .map((r) => r.probe);
}
