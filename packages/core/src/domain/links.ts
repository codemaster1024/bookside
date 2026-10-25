import { and, asc, eq, or } from "drizzle-orm";
import { books, chapters, highlights, insights, links, notes, questions } from "../db/schema.ts";
import type { LinkKind, LinkableType } from "../db/schema.ts";
import type { Conn } from "./conn.ts";
import { DomainError, notFound } from "./errors.ts";

export type Link = typeof links.$inferSelect;
export type Ref = { type: LinkableType; id: string };

const TABLES = { book: books, chapter: chapters, highlight: highlights, note: notes, question: questions, insight: insights };

/** links 表两端没有外键，存在性在这里检查。 */
function assertExists(conn: Conn, ref: Ref): void {
  const table = TABLES[ref.type];
  if (!conn.select({ id: table.id }).from(table).where(eq(table.id, ref.id)).get()) throw notFound(ref.type, ref.id);
}

/** 同一对对象、同一类型的关联（任何状态）。 */
export function findLink(conn: Conn, from: Ref, to: Ref, kind: LinkKind): Link | undefined {
  return conn
    .select()
    .from(links)
    .where(
      and(
        eq(links.fromType, from.type),
        eq(links.fromId, from.id),
        eq(links.toType, to.type),
        eq(links.toId, to.id),
        eq(links.kind, kind),
      ),
    )
    .get();
}

/** 两个对象之间（不分方向、不分类型与状态）的全部关联。 */
export function linksBetween(conn: Conn, a: Ref, b: Ref): Link[] {
  const dir = (x: Ref, y: Ref) =>
    and(eq(links.fromType, x.type), eq(links.fromId, x.id), eq(links.toType, y.type), eq(links.toId, y.id));
  return conn.select().from(links).where(or(dir(a, b), dir(b, a))).all();
}

/**
 * AI 提议一条关联，等你确认。同一关联已存在（无论待定、已确认还是被你拒绝过）时原样返回，
 * 不重复提议，也不让 AI 推翻你的决定。
 */
export function proposeLink(
  conn: Conn,
  input: { from: Ref; to: Ref; kind: LinkKind; reason?: string },
  now = new Date(),
): Link {
  return conn.transaction((tx) => {
    assertExists(tx, input.from);
    assertExists(tx, input.to);
    const existing = findLink(tx, input.from, input.to, input.kind);
    if (existing) return existing;
    return tx
      .insert(links)
      .values({
        fromType: input.from.type,
        fromId: input.from.id,
        toType: input.to.type,
        toId: input.to.id,
        kind: input.kind,
        state: "proposed",
        proposedBy: "ai",
        reason: input.reason,
        createdAt: now,
      })
      .returning()
      .get();
  });
}

/** 你亲手建立的关联，直接生效；若已有同样的提议则视为确认它。 */
export function createLink(conn: Conn, input: { from: Ref; to: Ref; kind: LinkKind }, now = new Date()): Link {
  return conn.transaction((tx) => {
    assertExists(tx, input.from);
    assertExists(tx, input.to);
    const existing = findLink(tx, input.from, input.to, input.kind);
    if (existing) {
      return tx.update(links).set({ state: "confirmed", decidedAt: now }).where(eq(links.id, existing.id)).returning().get();
    }
    return tx
      .insert(links)
      .values({
        fromType: input.from.type,
        fromId: input.from.id,
        toType: input.to.type,
        toId: input.to.id,
        kind: input.kind,
        state: "confirmed",
        proposedBy: "me",
        decidedAt: now,
        createdAt: now,
      })
      .returning()
      .get();
  });
}

function decide(conn: Conn, linkId: string, state: "confirmed" | "rejected", now: Date): Link {
  return conn.transaction((tx) => {
    const link = tx.select().from(links).where(eq(links.id, linkId)).get();
    if (!link) throw notFound("关联", linkId);
    if (link.state !== "proposed") throw new DomainError("link_not_proposed", `关联 ${linkId} 已被处理过`);
    return tx.update(links).set({ state, decidedAt: now }).where(eq(links.id, linkId)).returning().get();
  });
}

export function confirmLink(conn: Conn, linkId: string, now = new Date()): Link {
  return decide(conn, linkId, "confirmed", now);
}

export function rejectLink(conn: Conn, linkId: string, now = new Date()): Link {
  return decide(conn, linkId, "rejected", now);
}

/** 解除一条已确认的关联：记为拒绝，AI 之后不再提议同一条。 */
export function removeLink(conn: Conn, linkId: string, now = new Date()): Link {
  const link = conn.select().from(links).where(eq(links.id, linkId)).get();
  if (!link) throw notFound("关联", linkId);
  if (link.state !== "confirmed") throw new DomainError("invalid_input", "只能解除已确认的关联");
  return conn.update(links).set({ state: "rejected", decidedAt: now }).where(eq(links.id, linkId)).returning().get();
}

/** 等你确认的关联提议，最早的在前。 */
export function pendingProposals(conn: Conn): Link[] {
  return conn.select().from(links).where(eq(links.state, "proposed")).orderBy(asc(links.createdAt)).all();
}

/** 某个对象两端的已确认关联。 */
export function linksOf(conn: Conn, ref: Ref, state: Link["state"] = "confirmed"): Link[] {
  return conn
    .select()
    .from(links)
    .where(
      and(
        eq(links.state, state),
        or(
          and(eq(links.fromType, ref.type), eq(links.fromId, ref.id)),
          and(eq(links.toType, ref.type), eq(links.toId, ref.id)),
        ),
      ),
    )
    .orderBy(asc(links.createdAt))
    .all();
}
