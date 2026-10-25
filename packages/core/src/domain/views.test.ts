import { describe, expect, it } from "vitest";
import { books, chapters, highlights, questions } from "../db/schema.ts";
import { countEmptyBooks, describeProbeTarget, getBookDetail, listBooks, setPurpose } from "./books.ts";
import { T0, days, seed } from "./fixtures.test-helper.ts";
import { resolveId, shortId } from "./ids.ts";
import { createInsight } from "./insights.ts";
import { addProbe } from "./probes.ts";
import { appendMessage, createQuestion } from "./questions.ts";
import { getQuestionDetail, listQuestions } from "./threads.ts";

describe("resolveId", () => {
  it("accepts a full id or a unique prefix", () => {
    const { db, bookId } = seed();
    expect(resolveId(db, books, "书", bookId)).toBe(bookId);
    expect(resolveId(db, books, "书", shortId(bookId).toUpperCase())).toBe(bookId);
  });

  it("rejects unknown, ambiguous or nonsense input", () => {
    const { db } = seed();
    db.insert(books).values([{ id: "abcd1111", source: "local", title: "a" }, { id: "abcd2222", source: "local", title: "b" }]).run();
    expect(() => resolveId(db, books, "书", "abcd")).toThrow(expect.objectContaining({ code: "ambiguous_id" }));
    expect(() => resolveId(db, books, "书", "ffff")).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => resolveId(db, books, "书", "%")).toThrow(expect.objectContaining({ code: "not_found" }));
  });
});

describe("books", () => {
  it("lists books with counts, most recently marked first", () => {
    const { db, bookId, highlightId } = seed();
    const other = db.insert(books).values({ source: "local", title: "新书" }).returning().get().id;
    db.insert(highlights).values({ bookId: other, source: "local", text: "x", markedAt: days(5) }).run();
    addProbe(db, { target: { type: "highlight", id: highlightId }, content: "?" });
    createQuestion(db, { title: "q", origin: { type: "book", id: bookId } });
    createQuestion(db, { title: "起源于划线", origin: { type: "highlight", id: highlightId } });
    db.insert(highlights).values({ bookId, source: "local", text: "更早", markedAt: days(-5) }).run();
    expect(listBooks(db).map((b) => [b.title, b.highlightCount, b.pendingProbeCount, b.questionCount])).toEqual([
      ["新书", 1, 0, 0],
      ["书", 2, 1, 2],
    ]);
    expect(listBooks(db, { query: "新" }).map((b) => b.id)).toEqual([other]);
  });

  it("groups highlights by chapter with their notes, and gathers probes and questions", () => {
    const { db, bookId, highlightId } = seed();
    const ch = db.insert(chapters).values({ bookId, idx: 1, title: "第一章" }).returning().get().id;
    db.insert(highlights).values({ bookId, chapterId: ch, source: "local", text: "章内", markedAt: T0 }).run();
    const q = createQuestion(db, { title: "q", origin: { type: "highlight", id: highlightId } });
    const detail = getBookDetail(db, bookId);
    expect(detail.chapters.map((c) => [c.title, c.highlights.map((h) => h.text)])).toEqual([
      ["第一章", ["章内"]],
      ["", ["原文"]],
    ]);
    expect(detail.chapters[1]!.highlights[0]!.notes.map((n) => n.content)).toEqual(["作者在偷换概念"]);
    expect(detail.questions.map((x) => x.id)).toEqual([q.id]);
  });

  it("hides books with nothing in them unless searching or asked for", () => {
    const { db } = seed();
    const empty = db.insert(books).values({ source: "weread", title: "只在书架上" }).returning().get();
    expect(listBooks(db).map((b) => b.title)).toEqual(["书"]);
    expect(countEmptyBooks(db)).toBe(1);
    expect(listBooks(db, { includeEmpty: true })).toHaveLength(2);
    expect(listBooks(db, { query: "书架" }).map((b) => b.id)).toEqual([empty.id]);
    setPurpose(db, empty.id, "想读");
    expect(listBooks(db)).toHaveLength(2);
  });

  it("sets the reading purpose", () => {
    const { db, bookId } = seed();
    expect(setPurpose(db, bookId, "想弄清直觉何时可信").purpose).toBe("想弄清直觉何时可信");
  });

  it("describes what a probe hangs on", () => {
    const { db, noteId } = seed();
    const p = addProbe(db, { target: { type: "note", id: noteId }, content: "?" });
    expect(describeProbeTarget(db, p)).toMatchObject({ bookTitle: "书", quote: "原文", note: "作者在偷换概念" });
  });
});

describe("question threads", () => {
  it("filters questions by status and by originating book", () => {
    const { db, bookId, highlightId } = seed();
    const a = createQuestion(db, { title: "a", origin: { type: "highlight", id: highlightId } }, T0);
    const b = createQuestion(db, { title: "b" }, days(1));
    expect(listQuestions(db).map((q) => q.id)).toEqual([b.id, a.id]);
    expect(listQuestions(db, { bookId }).map((q) => q.id)).toEqual([a.id]);
    appendMessage(db, b.id, { speaker: "me", content: "想" });
    expect(listQuestions(db, { status: ["exploring"] }).map((q) => q.id)).toEqual([b.id]);
  });

  it("shows origin, messages with cited highlights, and insights", () => {
    const { db, highlightId } = seed();
    const q = createQuestion(db, { title: "q", origin: { type: "highlight", id: highlightId } }, T0);
    appendMessage(db, q.id, { speaker: "me", content: "看这句", highlightIds: [highlightId] }, T0);
    createInsight(db, { content: "结论", author: "me", sources: [{ questionId: q.id }] });
    const d = getQuestionDetail(db, q.id);
    expect(d.origin).toMatchObject({ type: "highlight", id: highlightId, bookTitle: "书", quote: "原文" });
    expect(d.messages[0]!.cited).toEqual([{ id: highlightId, text: "原文" }]);
    expect(d.insights.map((i) => i.content)).toEqual(["结论"]);
    expect(db.select().from(questions).all()).toHaveLength(1);
  });
});
