import { beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/client.ts";
import { books, highlights } from "../db/schema.ts";
import { latestGuide, listGuides } from "../domain/guides.ts";
import { pendingProbes, promoteProbe } from "../domain/probes.ts";
import { createQuestion } from "../domain/questions.ts";
import type { CatalogBook, PopularHighlight, TocEntry, WereadCatalog } from "../weread/client.ts";
import { refOf } from "./brief.ts";
import { findChapter, guideBrief, loadToc, parseGuide, writeGuide } from "./guide.ts";

class FakeCatalog implements WereadCatalog {
  tocs = new Map<string, TocEntry[]>();
  popular: PopularHighlight[] = [];
  popularCalls: (number | undefined)[] = [];
  async search(): Promise<CatalogBook[]> {
    return [];
  }
  async bookInfo(bookId: string): Promise<CatalogBook> {
    return { bookId, title: "t", intro: "一本讲习惯的书" };
  }
  async toc(bookId: string) {
    return this.tocs.get(bookId) ?? [];
  }
  async popularHighlights(_bookId: string, chapterUid?: number) {
    this.popularCalls.push(chapterUid);
    return this.popular;
  }
}

const T = new Date("2026-10-10T00:00:00Z");
const GUIDE = "依据：熟悉\n## 一句话\nx\n## 追问\n- 你为什么读？";
const TOC: TocEntry[] = [
  { chapterUid: 1, chapterIdx: 1, title: "第一部分 基础", level: 1 },
  { chapterUid: 2, chapterIdx: 2, title: "第1章 微小习惯的惊人力量", level: 2 },
  { chapterUid: 3, chapterIdx: 3, title: "第2章 习惯如何塑造身份", level: 2 },
];
let db: Db;
let catalog: FakeCatalog;
let bookId: string;

beforeEach(() => {
  db = openDb(":memory:");
  catalog = new FakeCatalog();
  catalog.tocs.set("W1", TOC);
  bookId = db.insert(books).values({ source: "weread", wereadBookId: "W1", title: "掌控习惯", purpose: "想把反思坚持下去" }).returning().get().id;
});

describe("parseGuide", () => {
  it("reads the basis line, the body and up to three probes", () => {
    const g = parseGuide("```markdown\n依据：有限\n依据有限。\n## 一句话\n讲习惯\n## 追问\n- 一\n- 二\n1. 三\n- 四\n```");
    expect(g.basis).toBe("limited");
    expect(g.content.startsWith("依据有限。")).toBe(true);
    expect(g.probes).toEqual(["一", "二", "三"]);
  });

  it("rejects output without a basis line", () => {
    expect(() => parseGuide("## 一句话\nx")).toThrow(/依据/);
  });
});

describe("guideBrief", () => {
  it("hands over the toc, popular highlights, the reader's highlights and open questions", async () => {
    db.insert(highlights).values({ bookId, source: "weread", text: "习惯是复利", markedAt: T }).run();
    createQuestion(db, { title: "为什么我的反思总是一断就停？" });
    catalog.popular = [{ markText: "每天进步 1%", count: 3200 }];
    const b = await guideBrief(db, catalog, { bookId });
    expect(b.instructions).toContain("## 怎么读");
    expect(b.material).toContain("简介：一本讲习惯的书");
    expect(b.material).toContain("- 第一部分 基础\n  - 第1章 微小习惯的惊人力量");
    expect(b.material).toContain("- （3200）每天进步 1%");
    expect(b.material).toContain("读者的读前目的：想把反思坚持下去");
    expect(b.material).toContain("- 习惯是复利");
    expect(b.material).toContain("- 为什么我的反思总是一断就停？（未探索）");
    expect(b.writeBack).toBe(`bookside guide ${refOf("book", bookId)} --write -`);
  });

  it("points a chapter guide at that chapter", async () => {
    const b = await guideBrief(db, catalog, { bookId, chapterUid: 3 });
    expect(b.instructions).toContain("章节导读");
    expect(b.material).toContain("第2章 习惯如何塑造身份  ← 本章");
    expect(catalog.popularCalls).toEqual([3]);
    expect(b.writeBack).toBe(`bookside guide ${refOf("book", bookId)} --chapter 3 --write -`);
  });

  it("grounds a guide on the reader's highlights when there is no table of contents", async () => {
    const kindle = db.insert(books).values({ source: "kindle", title: "Atomic Habits", author: "James Clear" }).returning().get().id;
    db.insert(highlights).values({ bookId: kindle, source: "kindle", text: "You do not rise to the level of your goals.", markedAt: T }).run();
    const b = await guideBrief(db, undefined, { bookId: kindle });
    expect(b.material).toContain("没有拿到这本书的目录。");
    expect(b.material).toContain("- You do not rise to the level of your goals.");
    expect(b.instructions).toContain("不写具体的章节名");
    expect(b.instructions).toContain("我对这本书不熟，以下只根据你的划线");
    const unknown = db.insert(books).values({ source: "weread", wereadBookId: "W404", title: "没目录" }).returning().get().id;
    expect((await guideBrief(db, catalog, { bookId: unknown })).material).toContain("没有拿到这本书的目录。");
  });

  it("still needs a table of contents for a chapter guide", async () => {
    const local = db.insert(books).values({ source: "local", title: "纸书" }).returning().get().id;
    await expect(guideBrief(db, undefined, { bookId: local, chapterUid: 1 })).rejects.toMatchObject({ code: "no_basis" });
  });

  it("writes a one-page quick guide kept apart from the full guide", async () => {
    const b = await guideBrief(db, catalog, { bookId, depth: "quick" });
    expect(b.instructions).toContain("速览");
    expect(b.instructions).toContain("全文 400–600 字");
    expect(b.writeBack).toBe(`bookside guide ${refOf("book", bookId)} --quick --write -`);
    writeGuide(db, { bookId, depth: "quick" }, "依据：熟悉\n## 一句话\n短\n## 追问\n- 一", T);
    writeGuide(db, { bookId }, GUIDE, new Date(T.getTime() + 1000));
    expect(latestGuide(db, bookId, undefined, "quick")?.content).toContain("短");
    expect(latestGuide(db, bookId)?.depth).toBe("full");
    expect(listGuides(db, bookId).map((g) => g.depth)).toEqual(["quick", "full"]);
  });
});

describe("writeGuide", () => {
  it("stores the guide and hangs its probes on the book", () => {
    const r = writeGuide(db, { bookId, by: "claude-code" }, GUIDE, T);
    expect(r.guide).toMatchObject({ bookId, chapterId: null, basis: "familiar", model: "claude-code" });
    expect(r.probes).toMatchObject([{ bookId, content: "你为什么读？" }]);
    expect(latestGuide(db, bookId)?.id).toBe(r.guide.id);
  });

  it("hangs a chapter guide's probes on that chapter, found by toc number without going online", async () => {
    await loadToc(db, catalog, bookId);
    const ch = findChapter(db, bookId, "3");
    expect(findChapter(db, bookId, "身份").id).toBe(ch.id);
    const r = writeGuide(db, { bookId, chapterId: ch.id }, "依据：熟悉\n## 主要内容\nx\n## 追问\n- 你认同身份先于行为吗？", T);
    expect(pendingProbes(db, { bookId }).map((p) => p.chapterId)).toEqual([ch.id]);
    expect(promoteProbe(db, r.probes[0]!.id).originChapterId).toBe(ch.id);
    expect(() => findChapter(db, bookId, "99")).toThrow(/找不到章节/);
  });

  it("keeps only the latest guide per scope when listing", async () => {
    await loadToc(db, catalog, bookId);
    writeGuide(db, { bookId }, GUIDE, T);
    const second = writeGuide(db, { bookId }, "依据：有限\n新版", new Date(T.getTime() + 1000));
    writeGuide(db, { bookId, chapterId: findChapter(db, bookId, "2").id }, GUIDE, T);
    const list = listGuides(db, bookId);
    expect(list.map((g) => [g.chapterTitle, g.basis])).toEqual([
      [null, "limited"],
      ["第1章 微小习惯的惊人力量", "familiar"],
    ]);
    expect(list[0]!.id).toBe(second.guide.id);
  });

  it("lists the toc with which chapters already have guides", async () => {
    await loadToc(db, catalog, bookId);
    writeGuide(db, { bookId, chapterId: findChapter(db, bookId, "2").id }, GUIDE, T);
    const toc = await loadToc(db, catalog, bookId);
    expect(toc.map((c) => [c.title, c.hasGuide])).toEqual([
      ["第一部分 基础", false],
      ["第1章 微小习惯的惊人力量", true],
      ["第2章 习惯如何塑造身份", false],
    ]);
  });
});
