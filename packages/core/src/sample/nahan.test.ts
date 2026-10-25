import { beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/client.ts";
import { books, highlights, questions } from "../db/schema.ts";
import { listTodos } from "../ai/todo.ts";
import { pendingProbes } from "../domain/probes.ts";
import { createInsight, listInsights } from "../domain/insights.ts";
import { createQuestion, dueRevisits } from "../domain/questions.ts";
import { getBook } from "../domain/books.ts";
import { describePosition, readingModeOf } from "../domain/reading-mode.ts";
import { pickRereads } from "../domain/reread.ts";
import { loadSample, removeSample, sampleBookId } from "./nahan.ts";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

describe("sample book", () => {
  it("shows the whole loop at once: a pending probe, a question due for revisit, and enough highlights for a reading portrait", () => {
    const { bookId, created } = loadSample(db);
    expect(created).toBe(true);
    expect(db.select().from(highlights).all()).toHaveLength(22);
    expect(pendingProbes(db, { bookId })).toHaveLength(1);
    expect(dueRevisits(db).map((q) => q.title)).toEqual(["铁屋子里先醒来的人，该不该叫醒别人？"]);
    expect(listTodos(db, { perBookLimit: 3 }).map((t) => t.kind)).toEqual(["portrait"]);
    expect(loadSample(db)).toEqual({ bookId, created: false });
    expect(pickRereads(db, { count: 2 })).toHaveLength(2);
  });

  it("is a narrative book read up to 《故乡》, so the spoiler guard shows", () => {
    const { bookId } = loadSample(db);
    expect(readingModeOf(getBook(db, bookId))).toMatchObject({ mode: "narrative", origin: "category" });
    expect(describePosition(db, bookId)).toBe("读到第 9 章「故乡」，进度 45%");
  });

  it("removes the book with what hangs on it, leaving the reader's other books alone", () => {
    const { bookId } = loadSample(db);
    const q = db.select().from(questions).get()!;
    createInsight(db, { content: "在示例书里写的观点", author: "me", sources: [{ questionId: q.id }] });
    const other = db.insert(books).values({ source: "local", title: "别的书" }).returning().get().id;
    createQuestion(db, { title: "长期问题" });
    removeSample(db);
    expect(sampleBookId(db)).toBeUndefined();
    expect(db.select().from(books).all().map((b) => b.id)).toEqual([other]);
    expect(db.select().from(questions).all().map((x) => x.title)).toEqual(["长期问题"]);
    expect(listInsights(db)).toEqual([]);
    expect(() => removeSample(db)).toThrow(/没有示例书/);
    expect(loadSample(db).bookId).not.toBe(bookId);
  });
});
