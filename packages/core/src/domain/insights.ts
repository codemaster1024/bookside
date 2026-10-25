import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import {
  chapters as chaptersTable,
  highlights as highlightsTable,
  insightSources,
  insightVersions,
  insights,
  links,
  questions as questionsTable,
} from "../db/schema.ts";
import type { Speaker } from "../db/schema.ts";
import type { Conn } from "./conn.ts";
import { DomainError, notFound } from "./errors.ts";

export type InsightVersion = typeof insightVersions.$inferSelect;
export type InsightSource = { questionId: string } | { highlightId: string } | { bookId: string };
export type Authorship = "mine" | "ai_assisted";

export type InsightView = {
  id: string;
  content: string;
  authorship: Authorship;
  versions: InsightVersion[];
};

/** 沉淀一条观点；至少要有一个来源（问题、划线，或一本书本身）。 */
export function createInsight(
  conn: Conn,
  input: { content: string; author: Speaker; sources: InsightSource[] },
  now = new Date(),
): InsightView {
  if (input.sources.length === 0) {
    throw new DomainError("insight_requires_source", "观点至少要来自一个问题、一条划线或一本书");
  }
  return conn.transaction((tx) => {
    const { id } = tx.insert(insights).values({ createdAt: now }).returning().get();
    for (const s of input.sources) {
      tx.insert(insightSources)
        .values({ insightId: id, ...s })
        .onConflictDoNothing()
        .run();
    }
    tx.insert(insightVersions)
      .values({ insightId: id, content: input.content, author: input.author, rewrite: true, createdAt: now })
      .run();
    return getInsight(tx, id);
  });
}

/**
 * 给观点添加新版本。rewrite 表示你从零重写、不基于上一版，
 * 只有这样才能让一条曾经 AI 协助的观点重新算作"我写的"。
 */
export function reviseInsight(
  conn: Conn,
  insightId: string,
  input: { content: string; author: Speaker; rewrite?: boolean },
  now = new Date(),
): InsightView {
  return conn.transaction((tx) => {
    getInsight(tx, insightId);
    tx.insert(insightVersions)
      .values({ insightId, content: input.content, author: input.author, rewrite: input.rewrite ?? false, createdAt: now })
      .run();
    return getInsight(tx, insightId);
  });
}

/** 删掉一条观点（连同版本、来源和挂在它上面的关联）；只在你明确要删时用。 */
export function deleteInsight(conn: Conn, insightId: string): InsightView {
  const view = getInsight(conn, insightId);
  conn.transaction((tx) => {
    tx.delete(links).where(or(and(eq(links.fromType, "insight"), eq(links.fromId, insightId)), and(eq(links.toType, "insight"), eq(links.toId, insightId)))).run();
    tx.delete(insights).where(eq(insights.id, insightId)).run();
  });
  return view;
}

export function getInsight(conn: Conn, insightId: string): InsightView {
  const versions = conn
    .select()
    .from(insightVersions)
    .where(eq(insightVersions.insightId, insightId))
    .orderBy(asc(insightVersions.createdAt), asc(sql`${insightVersions}.rowid`))
    .all();
  const latest = versions.at(-1);
  if (!latest) throw notFound("观点", insightId);
  return { id: insightId, content: latest.content, authorship: authorshipOf(versions), versions };
}

/**
 * 作者标记：从最新版本往回追溯到最近一次重写，这一段里只要有 AI 写的版本，就是 AI 协助。
 */
export function authorshipOf(versions: readonly Pick<InsightVersion, "author" | "rewrite">[]): Authorship {
  for (let i = versions.length - 1; i >= 0; i--) {
    const v = versions[i]!;
    if (v.author === "ai") return "ai_assisted";
    if (v.rewrite) return "mine";
  }
  return "mine";
}

/** 以某个问题为来源的观点，最新的在前。 */
export function insightsOfQuestion(conn: Conn, questionId: string): InsightView[] {
  return conn
    .select({ insightId: insightSources.insightId })
    .from(insightSources)
    .innerJoin(insights, eq(insights.id, insightSources.insightId))
    .where(eq(insightSources.questionId, questionId))
    .orderBy(desc(insights.createdAt))
    .all()
    .map((r) => getInsight(conn, r.insightId));
}

export type InsightWithSources = InsightView & {
  createdAt: Date;
  sources: { questionId: string | null; highlightId: string | null; bookId: string | null }[];
};

/** 全部观点及其来源，最新的在前。 */
export function listInsights(conn: Conn): InsightWithSources[] {
  const sources = conn.select().from(insightSources).all();
  return conn
    .select()
    .from(insights)
    .orderBy(desc(insights.createdAt))
    .all()
    .map((i) => ({
      ...getInsight(conn, i.id),
      createdAt: i.createdAt,
      sources: sources
        .filter((s) => s.insightId === i.id)
        .map(({ questionId, highlightId, bookId }) => ({ questionId, highlightId, bookId })),
    }));
}

/** 一本书的观点：来源是这本书本身、起源于这本书（含其章节、划线）的问题，或这本书里的划线。最新的在前。 */
export function insightsOfBook(conn: Conn, bookId: string): InsightWithSources[] {
  const chapterIds = new Set(
    conn.select({ id: chaptersTable.id }).from(chaptersTable).where(eq(chaptersTable.bookId, bookId)).all().map((c) => c.id),
  );
  const hlIds = new Set(
    conn.select({ id: highlightsTable.id }).from(highlightsTable).where(eq(highlightsTable.bookId, bookId)).all().map((h) => h.id),
  );
  const qIds = new Set(
    conn
      .select()
      .from(questionsTable)
      .all()
      .filter(
        (q) =>
          q.originBookId === bookId ||
          (q.originChapterId && chapterIds.has(q.originChapterId)) ||
          (q.originHighlightId && hlIds.has(q.originHighlightId)),
      )
      .map((q) => q.id),
  );
  return listInsights(conn).filter((i) =>
    i.sources.some(
      (s) => s.bookId === bookId || (s.highlightId && hlIds.has(s.highlightId)) || (s.questionId && qIds.has(s.questionId)),
    ),
  );
}
