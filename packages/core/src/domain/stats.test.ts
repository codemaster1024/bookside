import { describe, expect, it } from "vitest";
import { books, highlights } from "../db/schema.ts";
import { T0, seed } from "./fixtures.test-helper.ts";
import { createInsight, reviseInsight } from "./insights.ts";
import { createQuestion, setQuestionStatus } from "./questions.ts";
import { growth, modeDistribution, overview, preference, quoteOfTheDay, rhythm, topBooks, yearHeat } from "./stats.ts";

const DAY = 86_400_000;

describe("stats", () => {
  it("shows how questions moved and how much of the thinking is the reader's own", () => {
    const { db, highlightId } = seed();
    const q = createQuestion(db, { title: "q" });
    createQuestion(db, { title: "q2" });
    createInsight(db, { content: "我写的", author: "me", sources: [{ questionId: q.id }] });
    const ai = createInsight(db, { content: "AI 起草", author: "ai", sources: [{ highlightId }] });
    reviseInsight(db, ai.id, { content: "我改过", author: "me" });
    setQuestionStatus(db, q.id, "resolved");
    const g = growth(db);
    expect(g.questions).toMatchObject({ unexplored: 1, resolved: 1, exploring: 0 });
    expect(g.insights).toEqual({ mine: 1, aiAssisted: 1 });
  });

  it("counts highlights per week over the last twelve weeks", () => {
    const { db, bookId } = seed();
    const now = new Date(2026, 9, 25, 12);
    for (const d of [0, 1, 8, 200]) db.insert(highlights).values({ bookId, source: "weread", text: `d${d}`, markedAt: new Date(now.getTime() - d * DAY) }).run();
    const r = rhythm(db, now);
    expect(r).toHaveLength(12);
    expect(r.at(-1)!.count).toBe(2);
    expect(r.at(-2)!.count).toBe(1);
    // 共用的测试数据里还有一条 10 月 1 日的划线，也在这 12 周里；200 天前的那条不算。
    expect(r.reduce((n, w) => n + w.count, 0)).toBe(4);
  });

  it("ranks the books the reader keeps coming back to, and counts reading modes", () => {
    const { db, bookId } = seed();
    const other = db.insert(books).values({ source: "weread", title: "1984", category: "文学-外国文学" }).returning().get().id;
    for (let i = 0; i < 3; i++) db.insert(highlights).values({ bookId: other, source: "weread", text: `h${i}`, markedAt: T0 }).run();
    createQuestion(db, { title: "q", origin: { type: "book", id: bookId } });
    expect(topBooks(db).map((b) => b.id)).toEqual([bookId, other]);
    expect(modeDistribution(db)).toMatchObject({ narrative: 1, argument: 1 });
  });
});

describe("homepage numbers", () => {
  it("counts this month, books read lately, and the weekly streak", () => {
    const { db, bookId } = seed();
    const now = new Date(2026, 9, 25, 12);
    for (const d of [0, 7, 14]) db.insert(highlights).values({ bookId, source: "weread", text: `d${d}`, markedAt: new Date(now.getTime() - d * DAY) }).run();
    const o = overview(db, now);
    expect(o).toMatchObject({ highlights: 4, books: 1, readingNow: 1 });
    expect(o.highlightsThisMonth).toBe(4);
    // 本周、上周、上上周，加上共用数据里 10 月 1 日那一周，连着 4 周。
    expect(o.streakWeeks).toBe(4);
    expect(overview(db, new Date(2026, 10, 20)).streakWeeks).toBe(0);
  });

  it("lays out a year of days and finds the busiest one", () => {
    const { db, bookId } = seed();
    const now = new Date(2026, 9, 25, 12);
    for (let i = 0; i < 3; i++) db.insert(highlights).values({ bookId, source: "weread", text: `p${i}`, markedAt: new Date(2026, 2, 14, 9 + i) }).run();
    const h = yearHeat(db, now);
    expect(h.days[0]!.date.getDay()).toBe(1);
    expect(h.days.at(-1)!.date).toEqual(new Date(2026, 9, 25));
    expect(h.days.reduce((n, d) => n + d.count, 0)).toBe(4);
    expect(h.peak).toMatchObject({ date: new Date(2026, 2, 14), count: 3, bookTitle: "书" });
  });

  it("groups highlights by major category, falling back to the reading mode", () => {
    const { db } = seed();
    const add = (title: string, category: string | null, n: number) => {
      const id = db.insert(books).values({ source: "weread", title, category }).returning().get().id;
      for (let i = 0; i < n; i++) db.insert(highlights).values({ bookId: id, source: "weread", text: `${title}${i}`, markedAt: T0 }).run();
    };
    add("活着", "文学-中国文学", 2);
    add("1984", "文学-外国文学", 3);
    add("被讨厌的勇气", "心理-心理学应用", 1);
    expect(preference(db)).toEqual([
      { label: "文学", count: 5 },
      { label: "思辨", count: 1 },
      { label: "心理", count: 1 },
    ]);
  });

  it("picks one old highlight a day, noted ones first", () => {
    const { db, bookId, highlightId } = seed();
    const now = new Date(T0.getTime() + 40 * DAY);
    db.update(highlights).set({ text: "写过想法的这一句" }).run();
    db.insert(highlights).values({ bookId, source: "weread", text: "旧的但没写想法的一句", markedAt: T0 }).run();
    expect(quoteOfTheDay(db, now)?.highlightId).toBe(highlightId);
    expect(quoteOfTheDay(db, new Date(now.getTime() + DAY))?.highlightId).toBe(highlightId);
  });
});
