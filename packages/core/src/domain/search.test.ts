import { describe, expect, it } from "vitest";
import { openDb } from "../db/client.ts";
import { books, highlights, insightSources, insightVersions, insights, messages, notes, questions } from "../db/schema.ts";
import { searchAll, snippetOf } from "./search.ts";

const T = new Date("2026-10-01T00:00:00Z");

function seed() {
  const db = openDb(":memory:");
  const book = db.insert(books).values({ source: "weread", title: "被讨厌的勇气", author: "岸见一郎" }).returning().get();
  const h = db.insert(highlights).values({ bookId: book.id, source: "weread", text: "所有的烦恼都来自人际关系。", markedAt: T }).returning().get();
  db.insert(notes).values({ highlightId: h.id, source: "weread", content: "我的烦恼大多是在意别人的眼光", writtenAt: T }).run();
  const q = db.insert(questions).values({ title: "怎样做课题分离" }).returning().get();
  db.insert(messages).values({ questionId: q.id, speaker: "me", content: "我总是替别人的情绪负责，这是烦恼的来源" }).run();
  const i = db.insert(insights).values({}).returning().get();
  db.insert(insightVersions).values({ insightId: i.id, content: "旧版本：烦恼", author: "ai", createdAt: T }).run();
  db.insert(insightVersions).values({ insightId: i.id, content: "新版本：别人的课题交给别人", author: "me", createdAt: new Date(T.getTime() + 1000) }).run();
  db.insert(insightSources).values({ insightId: i.id, highlightId: h.id }).run();
  db.insert(books).values({ source: "weread", title: "100%_完成" }).run();
  return { db, book, q };
}

describe("searchAll", () => {
  it("finds a word across books, highlights, notes, threads and book chat", () => {
    const { db, q } = seed();
    const kinds = searchAll(db, "烦恼").map((h) => h.kind);
    expect(kinds).toEqual(["highlight", "note", "question"]);
    const thread = searchAll(db, "烦恼").find((h) => h.kind === "question")!;
    expect(thread).toMatchObject({ id: q.id, title: "怎样做课题分离", snippet: expect.stringContaining("你：") });
  });

  it("searches only the latest version of an insight and points to its book", () => {
    const { db, book } = seed();
    expect(searchAll(db, "旧版本")).toEqual([]);
    expect(searchAll(db, "课题交给")[0]).toMatchObject({ kind: "insight", bookId: book.id, bookTitle: "被讨厌的勇气" });
  });

  it("needs every word, matches authors, and treats % and _ literally", () => {
    const { db } = seed();
    expect(searchAll(db, "岸见 勇气").map((h) => h.kind)).toEqual(["book"]);
    expect(searchAll(db, "烦恼 眼光").map((h) => h.kind)).toEqual(["note"]);
    expect(searchAll(db, "%_").map((h) => h.title)).toEqual(["100%_完成"]);
    expect(searchAll(db, "   ")).toEqual([]);
  });

  it("cuts a snippet around the first match", () => {
    const long = `${"甲".repeat(100)}关键词${"乙".repeat(100)}`;
    const s = snippetOf(long, ["关键词"], 10);
    expect(s).toContain("关键词");
    expect(s.startsWith("…") && s.endsWith("…")).toBe(true);
  });
});
