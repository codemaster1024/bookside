import { describe, expect, it } from "vitest";
import { books, highlights, notes } from "../db/schema.ts";
import { T0, seed } from "../domain/fixtures.test-helper.ts";
import { pickRereads } from "../domain/reread.ts";
import { refOf } from "./brief.ts";
import { draftBrief, quizBrief, recapBrief } from "./recap.ts";
import { appendMessage, createQuestion } from "../domain/questions.ts";

const DAY = 86_400_000;

describe("recap and quiz", () => {
  it("recaps what the reader highlighted, keeping the author's words apart from the reader's", () => {
    const { db, bookId, highlightId } = seed();
    const b = recapBrief(db, bookId);
    expect(b.material).toContain(`[${refOf("highlight", highlightId)}] 原文`);
    expect(b.material).toContain("    想法：作者在偷换概念");
    expect(b.instructions).toContain("不是书的摘要");
    expect(b.writeBack).toBeUndefined();
  });

  it("quizzes one question at a time and offers to keep what the reader explained well", () => {
    const { db, bookId } = seed();
    const b = quizBrief(db, bookId);
    expect(b.instructions).toContain("一次只问一道");
    expect(b.instructions).toContain(`bookside insight new --as me --book ${refOf("book", bookId)} -`);
  });

  it("drafts a piece from the reader's own words, named for the kind of book", () => {
    const { db, bookId } = seed();
    const q = createQuestion(db, { title: "概念被偷换了吗", origin: { type: "book", id: bookId } });
    appendMessage(db, q.id, { speaker: "me", content: "我觉得作者把两件事混在一起说了" });
    const b = draftBrief(db, bookId, { for: "豆瓣" });
    expect(b.task).toBe("用读者自己的话起草一篇《书》的书评");
    expect(b.instructions).toContain("发在豆瓣");
    expect(b.instructions).toContain("【这里你怎么看？】");
    expect(b.material).toContain(`[${refOf("question", q.id)}] 关于「概念被偷换了吗」，读者说：我觉得作者把两件事混在一起说了`);
    const bare = db.insert(books).values({ source: "local", title: "没写过想法的书" }).returning().get().id;
    db.insert(highlights).values({ bookId: bare, source: "local", text: "只有划线", markedAt: T0 }).run();
    expect(() => draftBrief(db, bare)).toThrow(/还没写下自己的想法/);
  });

  it("refuses books with nothing to work from", () => {
    const { db } = seed();
    const empty = db.insert(books).values({ source: "local", title: "空" }).returning().get().id;
    expect(() => recapBrief(db, empty)).toThrow(/没有可回顾的/);
    expect(() => quizBrief(db, empty)).toThrow(/出不了题/);
  });
});

describe("pickRereads", () => {
  it("picks old highlights, noted ones first, and rests them for two months", () => {
    const { db, bookId, highlightId } = seed();
    const now = new Date(T0.getTime() + 40 * DAY);
    const fresh = db.insert(highlights).values({ bookId, source: "weread", text: "新划的", markedAt: new Date(now.getTime() - DAY) }).returning().get().id;
    const plain = db.insert(highlights).values({ bookId, source: "weread", text: "旧的没想法", markedAt: T0 }).returning().get().id;
    const first = pickRereads(db, { count: 1 }, now, () => 0.5);
    expect(first.map((r) => r.highlightId)).toEqual([highlightId]);
    expect(first[0]!.notes.map((n) => n.content)).toEqual(["作者在偷换概念"]);
    expect(pickRereads(db, { count: 5 }, now, () => 0.5).map((r) => r.highlightId)).toEqual([plain]);
    expect(pickRereads(db, {}, now)).toEqual([]);
    expect(pickRereads(db, {}, new Date(now.getTime() + 61 * DAY)).map((r) => r.highlightId).sort()).toEqual([fresh, highlightId, plain].sort());
    expect(db.select().from(notes).all()).toHaveLength(1);
  });
});
