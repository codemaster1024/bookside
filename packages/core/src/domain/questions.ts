import { and, asc, eq, gt, isNotNull, lte, sql } from "drizzle-orm";
import { books, chapters, highlights, insightSources, messageHighlights, messages, questionStatusChanges, questions } from "../db/schema.ts";
import type { QuestionStatus, Speaker } from "../db/schema.ts";
import type { Conn } from "./conn.ts";
import { DomainError, notFound } from "./errors.ts";
import { REVISIT_INTERVAL_DAYS, isRevisited, nextRevisitAt } from "./revisit.ts";

export type Question = typeof questions.$inferSelect;
export type Message = typeof messages.$inferSelect;

export type Origin = { type: "book" | "chapter" | "highlight"; id: string };

export type NewMessage = { speaker: Speaker; content: string; highlightIds?: string[] };

export function getQuestion(conn: Conn, id: string): Question {
  const q = conn.select().from(questions).where(eq(questions.id, id)).get();
  if (!q) throw notFound("问题", id);
  return q;
}

/** 改问题的标题；问题不删除，不想再想就设为放弃。 */
export function renameQuestion(conn: Conn, questionId: string, title: string): Question {
  getQuestion(conn, questionId);
  const t = title.trim();
  if (!t) throw new DomainError("invalid_input", "问题的标题不能为空");
  return conn.update(questions).set({ title: t }).where(eq(questions.id, questionId)).returning().get();
}

/**
 * 创建问题；起源省略即长期问题。initialMessages 用于把自由对话中的上下文带进线程。
 */
export function createQuestion(
  conn: Conn,
  input: { title: string; origin?: Origin; initialMessages?: NewMessage[] },
  now = new Date(),
): Question {
  return conn.transaction((tx) => {
    if (input.origin) assertOriginExists(tx, input.origin);
    const q = tx
      .insert(questions)
      .values({
        title: input.title,
        originBookId: input.origin?.type === "book" ? input.origin.id : null,
        originChapterId: input.origin?.type === "chapter" ? input.origin.id : null,
        originHighlightId: input.origin?.type === "highlight" ? input.origin.id : null,
        revisitStep: 0,
        nextRevisitAt: nextRevisitAt(0, now),
        createdAt: now,
      })
      .returning()
      .get();
    for (const m of input.initialMessages ?? []) appendMessage(tx, q.id, m, now);
    return getQuestion(tx, q.id);
  });
}

function assertOriginExists(conn: Conn, origin: Origin): void {
  const table = { book: books, chapter: chapters, highlight: highlights }[origin.type];
  const row = conn.select({ id: table.id }).from(table).where(eq(table.id, origin.id)).get();
  if (!row) throw notFound(origin.type, origin.id);
}

/**
 * 在线程里追加一条发言。你的发言意味着你在想这个问题：
 * 未探索的问题转为探讨中，回访节奏重置到最短间隔。AI 的发言不影响状态和回访。
 */
export function appendMessage(conn: Conn, questionId: string, input: NewMessage, now = new Date()): Message {
  return conn.transaction((tx) => {
    const q = getQuestion(tx, questionId);
    const message = tx
      .insert(messages)
      .values({ questionId, speaker: input.speaker, content: input.content, createdAt: now })
      .returning()
      .get();
    for (const highlightId of new Set(input.highlightIds)) {
      tx.insert(messageHighlights).values({ messageId: message.id, highlightId }).run();
    }
    if (input.speaker === "me") {
      const status = q.status === "unexplored" ? "exploring" : q.status;
      tx.update(questions)
        .set({
          status,
          revisitStep: 0,
          nextRevisitAt: isRevisited(status) ? nextRevisitAt(0, now) : null,
        })
        .where(eq(questions.id, questionId))
        .run();
      if (status !== q.status) tx.insert(questionStatusChanges).values({ questionId, from: q.status, to: status, createdAt: now }).run();
    }
    return message;
  });
}

export function listMessages(conn: Conn, questionId: string): Message[] {
  return conn
    .select()
    .from(messages)
    .where(eq(messages.questionId, questionId))
    .orderBy(asc(messages.createdAt), asc(sql`${messages}.rowid`))
    .all();
}

/**
 * 改变问题状态。"已解决"要求至少一条观点以它为来源；
 * 离开回访状态时清掉回访时间，重新进入时从最短间隔开始。
 */
export function setQuestionStatus(conn: Conn, questionId: string, status: QuestionStatus, now = new Date()): Question {
  return conn.transaction((tx) => {
    const q = getQuestion(tx, questionId);
    if (status === "resolved" && !hasInsight(tx, questionId)) {
      throw new DomainError("resolved_requires_insight", "标记已解决前，先为这个问题沉淀至少一条观点");
    }
    const schedule = !isRevisited(status)
      ? { revisitStep: 0, nextRevisitAt: null }
      : isRevisited(q.status)
        ? {}
        : { revisitStep: 0, nextRevisitAt: nextRevisitAt(0, now) };
    tx.update(questions)
      .set({ status, ...schedule })
      .where(eq(questions.id, questionId))
      .run();
    if (q.status !== status) tx.insert(questionStatusChanges).values({ questionId, from: q.status, to: status, createdAt: now }).run();
    return getQuestion(tx, questionId);
  });
}

function hasInsight(conn: Conn, questionId: string): boolean {
  return !!conn
    .select({ id: insightSources.id })
    .from(insightSources)
    .where(eq(insightSources.questionId, questionId))
    .get();
}

/** 到期需要回访的问题，最早到期的在前。 */
export function dueRevisits(conn: Conn, now = new Date()): Question[] {
  return conn
    .select()
    .from(questions)
    .where(and(isNotNull(questions.nextRevisitAt), lte(questions.nextRevisitAt, now)))
    .orderBy(asc(questions.nextRevisitAt))
    .all();
}

/**
 * 回访时你暂时没有新想法：推到下一个更长的间隔。
 * far：你说「这个先别问了」时，直接推到最长的间隔。
 */
export function postponeRevisit(conn: Conn, questionId: string, opts: { far?: boolean } = {}, now = new Date()): Question {
  return conn.transaction((tx) => {
    const q = getQuestion(tx, questionId);
    if (!isRevisited(q.status)) return q;
    const step = opts.far ? Math.max(q.revisitStep, REVISIT_INTERVAL_DAYS.length - 1) : q.revisitStep + 1;
    tx.update(questions)
      .set({ revisitStep: step, nextRevisitAt: nextRevisitAt(step, now) })
      .where(eq(questions.id, questionId))
      .run();
    return getQuestion(tx, questionId);
  });
}

/** 接下来几天要回访的问题（不含已到期的），最早的在前。 */
export function upcomingRevisits(conn: Conn, days = 7, now = new Date()): Question[] {
  const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  return conn
    .select()
    .from(questions)
    .where(and(gt(questions.nextRevisitAt, now), lte(questions.nextRevisitAt, until)))
    .orderBy(asc(questions.nextRevisitAt))
    .all();
}

export type StatusChange = typeof questionStatusChanges.$inferSelect;

/** 这个问题的状态改动，早的在前。 */
export function statusChanges(conn: Conn, questionId: string): StatusChange[] {
  return conn.select().from(questionStatusChanges).where(eq(questionStatusChanges.questionId, questionId)).orderBy(asc(questionStatusChanges.createdAt)).all();
}
