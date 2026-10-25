import { beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/client.ts";
import { books, chapters, highlights } from "../db/schema.ts";
import { probeBrief } from "../ai/probes.ts";
import { guideBrief } from "../ai/guide.ts";
import { synthesisBrief } from "../ai/synthesis.ts";
import type { WereadCatalog } from "../weread/client.ts";
import { syncWeread } from "../weread/sync.ts";
import { getBook } from "./books.ts";
import { describePosition, modeOfCategory, parseReadingMode, readingModeOf, setReadingMode } from "./reading-mode.ts";

const T = new Date("2026-10-10T00:00:00Z");
let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

describe("reading mode", () => {
  it("infers a mode from WeRead categories, minor category first", () => {
    expect(modeOfCategory("文学-外国文学")).toBe("narrative");
    expect(modeOfCategory("人物传记-文学家")).toBe("narrative");
    expect(modeOfCategory("个人成长-励志成长")).toBe("practice");
    expect(modeOfCategory("经济理财-管理")).toBe("practice");
    expect(modeOfCategory("计算机-编程设计")).toBe("knowledge");
    expect(modeOfCategory("哲学宗教-西方哲学")).toBe("argument");
    expect(modeOfCategory("历史-中国历史")).toBe("argument");
    expect(modeOfCategory("期刊杂志")).toBeUndefined();
    expect(modeOfCategory(null)).toBeUndefined();
  });

  it("prefers an explicit mode, then the category, then argument as an undecided default", () => {
    const id = db.insert(books).values({ source: "weread", title: "1984", category: "文学-外国文学" }).returning().get().id;
    expect(readingModeOf(getBook(db, id))).toMatchObject({ mode: "narrative", origin: "category" });
    setReadingMode(db, id, parseReadingMode("思辨"));
    expect(readingModeOf(getBook(db, id))).toMatchObject({ mode: "argument", label: "思辨", origin: "set" });
    const kindle = db.insert(books).values({ source: "kindle", title: "Atomic Habits" }).returning().get();
    expect(readingModeOf(kindle)).toMatchObject({ mode: "argument", origin: "default" });
    expect(() => parseReadingMode("诗歌")).toThrow(/未知读法/);
  });

  it("stores the category from the WeRead shelf on sync", async () => {
    const source = {
      shelf: async () => [{ bookId: "W1", title: "1984", category: "文学-外国文学" }],
      notebooks: async () => [],
      bookmarks: async () => ({ bookmarks: [], chapters: [] }),
      myReviews: async () => [],
    };
    await syncWeread(db, source, T);
    expect(db.select().from(books).get()!.category).toBe("文学-外国文学");
  });
});

describe("briefs by reading mode", () => {
  function narrativeBook() {
    const bookId = db.insert(books).values({ source: "weread", wereadBookId: "W1", title: "1984", category: "文学-外国文学", progress: 40 }).returning().get().id;
    const c3 = db.insert(chapters).values({ bookId, idx: 3, title: "第三章" }).returning().get().id;
    db.insert(highlights).values({ bookId, chapterId: c3, source: "weread", text: "战争即和平", markedAt: T, createdAt: T }).run();
    return bookId;
  }

  it("asks narrative probes about feelings and characters, and guards against spoilers while reading", () => {
    const bookId = narrativeBook();
    expect(describePosition(db, bookId)).toBe("读到第 3 章「第三章」，进度 40%");
    const b = probeBrief(db, bookId, { perBookLimit: 3 });
    expect(b.material).toContain("读法：叙事（按分类「文学-外国文学」推定）");
    expect(b.instructions).toContain("人物为什么这么做");
    expect(b.instructions).toContain("一律不写");
  });

  it("writes a practice guide around methods, and a narrative guide without spoilers", async () => {
    const catalog: WereadCatalog = {
      search: async () => [],
      bookInfo: async (bookId) => ({ bookId, title: "t" }),
      toc: async () => [{ chapterUid: 1, chapterIdx: 1, title: "第一章", level: 1 }],
      popularHighlights: async () => [],
    };
    const practice = db.insert(books).values({ source: "weread", wereadBookId: "W2", title: "掌控习惯", category: "个人成长-励志成长" }).returning().get().id;
    const g = await guideBrief(db, catalog, { bookId: practice });
    expect(g.instructions).toContain("## 方法清单");
    expect(g.instructions).not.toContain("一律不写");

    const narrative = narrativeBook();
    const n = await guideBrief(db, catalog, { bookId: narrative });
    expect(n.instructions).toContain("不透露结局");
    expect(n.instructions).toContain("读者还没读完（读到第 3 章「第三章」，进度 40%）");
  });

  it("drops the spoiler guard once the book is finished", () => {
    const bookId = narrativeBook();
    db.update(books).set({ finishedAt: T, progress: 100 }).run();
    expect(probeBrief(db, bookId, { perBookLimit: 3 }).instructions).not.toContain("一律不写");
    expect(describePosition(db, bookId)).toBeUndefined();
  });

  it("names what to keep after reading by mode", () => {
    const bookId = narrativeBook();
    expect(synthesisBrief(db, bookId).instructions).toContain("读后感");
    setReadingMode(db, bookId, "knowledge");
    expect(synthesisBrief(db, bookId).instructions).toContain("我的理解");
  });
});
