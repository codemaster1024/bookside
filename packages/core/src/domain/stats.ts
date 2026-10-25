// 读书记忆的分析：直接从数据算出来，不需要 AI。给查看器首页用。
import { and, eq, gte, isNull } from "drizzle-orm";
import { QUESTION_STATUSES, type QuestionStatus, type ReadingMode, READING_MODES, books, highlights, notes } from "../db/schema.ts";
import { type BookSummary, listBooks } from "./books.ts";
import type { Conn } from "./conn.ts";
import { insightsOfBook, listInsights } from "./insights.ts";
import { READING_MODE_LABELS, readingModeOf } from "./reading-mode.ts";
import { listQuestions } from "./threads.ts";

const DAY = 24 * 60 * 60 * 1000;
const WEEKS = 12;

export type Growth = {
  questions: Record<QuestionStatus, number>;
  /** 观点按作者：你自己写的、AI 协助的。 */
  insights: { mine: number; aiAssisted: number };
};

/** 思考的成长：问题各走到了哪一步，观点里有多少是你自己写的。 */
export function growth(conn: Conn): Growth {
  const questions = Object.fromEntries(QUESTION_STATUSES.map((s) => [s, 0])) as Record<QuestionStatus, number>;
  for (const q of listQuestions(conn)) questions[q.status]++;
  const insights = { mine: 0, aiAssisted: 0 };
  for (const i of listInsights(conn)) insights[i.authorship === "mine" ? "mine" : "aiAssisted"]++;
  return { questions, insights };
}

/** 本地时间那一周的周一零点。 */
function weekStart(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

/** 读书节奏：最近 12 周每周划了多少线，最早的一周在前。 */
export function rhythm(conn: Conn, now = new Date()): { weekStart: Date; count: number }[] {
  const first = new Date(weekStart(now).getTime() - (WEEKS - 1) * 7 * DAY);
  const weeks = Array.from({ length: WEEKS }, (_, i) => ({ weekStart: new Date(first.getTime() + i * 7 * DAY), count: 0 }));
  const rows = conn
    .select({ at: highlights.markedAt })
    .from(highlights)
    .where(and(isNull(highlights.deletedAtSourceAt), gte(highlights.markedAt, first)))
    .all();
  for (const { at } of rows) {
    const i = Math.floor((weekStart(at).getTime() - first.getTime()) / (7 * DAY) + 0.5);
    if (i >= 0 && i < WEEKS) weeks[i]!.count++;
  }
  return weeks;
}

export type BookWeight = BookSummary & { insightCount: number; mode: ReadingMode };

/** 你最常回到的书：问题和观点比划线更能说明一本书影响了你。 */
export function topBooks(conn: Conn, limit = 6): BookWeight[] {
  return listBooks(conn)
    .map((b) => ({ ...b, insightCount: insightsOfBook(conn, b.id).length, mode: readingModeOf(b).mode }))
    .map((b) => ({ b, score: b.highlightCount + 5 * b.questionCount + 5 * b.insightCount }))
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map(({ b }) => b);
}

/** 读法分布：书单里的书各是哪种读法。 */
export function modeDistribution(conn: Conn): Record<ReadingMode, number> {
  const out = Object.fromEntries(READING_MODES.map((m) => [m, 0])) as Record<ReadingMode, number>;
  for (const b of listBooks(conn)) out[readingModeOf(b).mode]++;
  return out;
}

/** 本地时间那一天的零点。 */
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

const liveHighlights = (conn: Conn) =>
  conn
    .select({ id: highlights.id, bookId: highlights.bookId, at: highlights.markedAt })
    .from(highlights)
    .where(isNull(highlights.deletedAtSourceAt))
    .all();

export type Overview = {
  highlights: number;
  /** 这个月划的。 */
  highlightsThisMonth: number;
  books: number;
  /** 最近 30 天里划过线的书。 */
  readingNow: number;
  questions: number;
  resolved: number;
  insights: number;
  mine: number;
  /** 到本周为止，连续几周都划过线（本周还没划时从上周算起）。 */
  streakWeeks: number;
};

/** 首页那一行数字。 */
export function overview(conn: Conn, now = new Date()): Overview {
  const rows = liveHighlights(conn);
  const month = new Date(now.getFullYear(), now.getMonth(), 1);
  const recent = new Date(now.getTime() - 30 * DAY);
  const weeks = new Set(rows.map((r) => weekStart(r.at).getTime()));
  let week = weekStart(now).getTime();
  if (!weeks.has(week)) week = weekStart(new Date(week - DAY)).getTime();
  let streakWeeks = 0;
  while (weeks.has(week)) {
    streakWeeks++;
    week = weekStart(new Date(week - DAY)).getTime();
  }
  const g = growth(conn);
  return {
    highlights: rows.length,
    highlightsThisMonth: rows.filter((r) => r.at >= month).length,
    books: listBooks(conn).length,
    readingNow: new Set(rows.filter((r) => r.at >= recent).map((r) => r.bookId)).size,
    questions: QUESTION_STATUSES.reduce((n, s) => n + g.questions[s], 0),
    resolved: g.questions.resolved,
    insights: g.insights.mine + g.insights.aiAssisted,
    mine: g.insights.mine,
    streakWeeks,
  };
}

export type YearHeat = {
  /** 从 52 周前的周一到今天，每天划了几条，最早的一天在前。 */
  days: { date: Date; count: number }[];
  /** 划得最多的一天，以及那天划得最多的书。 */
  peak?: { date: Date; count: number; bookTitle: string };
};

/** 这一年的划线：给日历热力图用。 */
export function yearHeat(conn: Conn, now = new Date()): YearHeat {
  const first = new Date(weekStart(now).getTime() - 52 * 7 * DAY);
  const today = dayStart(now);
  const days: YearHeat["days"] = [];
  for (let d = first; d <= today; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) days.push({ date: d, count: 0 });
  const index = new Map(days.map((d, i) => [d.date.getTime(), i]));
  const perBook = new Map<string, Map<string, number>>();
  for (const r of liveHighlights(conn)) {
    const key = dayStart(r.at).getTime();
    const i = index.get(key);
    if (i === undefined) continue;
    days[i]!.count++;
    const m = perBook.get(String(key)) ?? new Map<string, number>();
    m.set(r.bookId, (m.get(r.bookId) ?? 0) + 1);
    perBook.set(String(key), m);
  }
  const top = days.reduce<YearHeat["days"][number] | undefined>((a, d) => (d.count > (a?.count ?? 0) ? d : a), undefined);
  if (!top) return { days };
  const [bookId] = [...perBook.get(String(top.date.getTime()))!].sort((a, b) => b[1] - a[1])[0]!;
  const book = conn.select({ title: books.title }).from(books).where(eq(books.id, bookId)).get();
  return { days, peak: { date: top.date, count: top.count, bookTitle: book?.title ?? "" } };
}

/** 阅读偏好最多画几个轴。 */
const PREFERENCE_AXES = 6;

/**
 * 阅读偏好：按书的分类数划线，取最多的几类。分类取大类（「文学-外国文学」算文学）；
 * 没有分类的书（Kindle、本地的书）按读法归类。
 */
export function preference(conn: Conn): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const b of listBooks(conn)) {
    if (!b.highlightCount) continue;
    const label = b.category?.split("-")[0]?.trim() || READING_MODE_LABELS[readingModeOf(b).mode];
    counts.set(label, (counts.get(label) ?? 0) + b.highlightCount);
  }
  return [...counts]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, PREFERENCE_AXES);
}

/** 划了多久以上才算旧划线。 */
const OLD_DAYS = 30;

export type DailyQuote = { highlightId: string; text: string; bookId: string; bookTitle: string; markedAt: Date };

/**
 * 还没有读书画像时，首页每天换一句旧划线：写过想法的优先，一天之内不变。
 * 只读，不记重温时间。
 */
export function quoteOfTheDay(conn: Conn, now = new Date()): DailyQuote | undefined {
  const rows = conn
    .select({ id: highlights.id, text: highlights.text, bookId: highlights.bookId, bookTitle: books.title, markedAt: highlights.markedAt })
    .from(highlights)
    .innerJoin(books, eq(books.id, highlights.bookId))
    .where(and(isNull(highlights.deletedAtSourceAt), eq(highlights.kind, "marked")))
    .orderBy(highlights.id)
    .all()
    .filter((r) => r.text.length >= 8 && r.text.length <= 120);
  if (rows.length === 0) return undefined;
  const old = rows.filter((r) => r.markedAt < new Date(now.getTime() - OLD_DAYS * DAY));
  const noted = new Set(conn.select({ h: notes.highlightId }).from(notes).where(isNull(notes.deletedAtSourceAt)).all().map((r) => r.h));
  const pool = [old.filter((r) => noted.has(r.id)), old, rows].find((p) => p.length)!;
  const n = Math.floor(dayStart(now).getTime() / DAY);
  const r = pool[n % pool.length]!;
  return { highlightId: r.id, text: r.text, bookId: r.bookId, bookTitle: r.bookTitle, markedAt: r.markedAt };
}
