import { beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/client.ts";
import { books, highlights, notes } from "../db/schema.ts";
import { createInsight } from "../domain/insights.ts";
import { pendingProposals, proposeLink, rejectLink } from "../domain/links.ts";
import { appendMessage, createQuestion } from "../domain/questions.ts";
import { activationBrief, writeActivations } from "./activation.ts";
import { refOf } from "./brief.ts";
import { listTodos, settleTodos } from "./todo.ts";

const T = new Date("2026-10-10T00:00:00Z");
let db: Db;
let oldBook: string;
let newBook: string;

const book = (title: string) => db.insert(books).values({ source: "weread", title }).returning().get().id;
function highlight(bookId: string, text: string, considered = false) {
  return db
    .insert(highlights)
    .values({ bookId, source: "weread", text, markedAt: T, createdAt: T, activationConsideredAt: considered ? T : null, probeConsideredAt: T })
    .returning()
    .get().id;
}
const write = (links: object[]) => writeActivations(db, newBook, JSON.stringify({ links }), { asOf: T });
const todos = () => listTodos(db, { perBookLimit: 3 }).filter((t) => t.kind === "activation");

beforeEach(() => {
  db = openDb(":memory:");
  oldBook = book("思考，快与慢");
  newBook = book("刻意练习");
});

describe("activation", () => {
  it("has nothing to do without new content", () => {
    createQuestion(db, { title: "q" });
    highlight(newBook, "旧", true);
    expect(todos()).toEqual([]);
  });

  it("settles content when there are no questions from other books yet", () => {
    createQuestion(db, { title: "同书的问题", origin: { type: "book", id: newBook } });
    highlight(newBook, "a");
    expect(todos()).toEqual([]);
    expect(activationBrief(db, newBook)).toBeUndefined();
    settleTodos(db, { perBookLimit: 3 });
    createQuestion(db, { title: "后来的问题" });
    expect(todos()).toEqual([]);
  });

  it("hands over questions from other books with the reader's current view, and the new content", () => {
    const origin = highlight(oldBook, "直觉不过是识别", true);
    const q = createQuestion(db, { title: "专家直觉可信吗？", origin: { type: "highlight", id: origin } });
    appendMessage(db, q.id, { speaker: "me", content: "我怀疑消防员的直觉" });
    createQuestion(db, { title: "同书的问题", origin: { type: "book", id: newBook } });
    const h = highlight(newBook, "及时反馈是刻意练习的核心");
    expect(todos()).toMatchObject([{ bookId: newBook, count: 1, brief: `bookside activate brief ${refOf("book", newBook)}` }]);

    const b = activationBrief(db, newBook, T)!;
    expect(b.material).toContain(`[${refOf("question", q.id)}] 专家直觉可信吗？（探讨中，起源《思考，快与慢》）`);
    expect(b.material).toContain("读者目前的看法：我怀疑消防员的直觉");
    expect(b.material).not.toContain("同书的问题");
    expect(b.material).toContain(`[${refOf("highlight", h)}] 新划线：及时反馈是刻意练习的核心`);

    const links = write([{ from: refOf("highlight", h), question: refOf("question", q.id), kind: "answers", reason: "直觉可信需要及时反馈" }]);
    expect(links).toMatchObject([
      { fromType: "highlight", fromId: h, toType: "question", toId: q.id, kind: "answers", state: "proposed", proposedBy: "ai" },
    ]);
    expect(pendingProposals(db)).toHaveLength(1);
    expect(todos()).toEqual([]);
  });

  it("prefers the latest insight as the reader's current view", () => {
    const q = createQuestion(db, { title: "q" });
    appendMessage(db, q.id, { speaker: "me", content: "早先的想法" });
    createInsight(db, { content: "沉淀下来的看法", author: "me", sources: [{ questionId: q.id }] });
    highlight(newBook, "a");
    expect(activationBrief(db, newBook)!.material).toContain("读者目前的看法：沉淀下来的看法");
  });

  it("never links to a question from the same book, nor re-proposes a rejected pair", () => {
    const same = createQuestion(db, { title: "q", origin: { type: "book", id: newBook } });
    const other = createQuestion(db, { title: "q2" });
    const h = highlight(newBook, "a");
    rejectLink(db, proposeLink(db, { from: { type: "highlight", id: h }, to: { type: "question", id: other.id }, kind: "answers" }).id);
    expect(
      write([
        { from: refOf("highlight", h), question: refOf("question", same.id), kind: "supports", reason: "r" },
        { from: refOf("highlight", h), question: refOf("question", other.id), kind: "extends", reason: "r" },
      ]),
    ).toEqual([]);
  });

  it("can link a new note, ignores old highlights and caps the number of proposals", () => {
    const q1 = createQuestion(db, { title: "q1" });
    const q2 = createQuestion(db, { title: "q2" });
    const old = highlight(newBook, "旧划线", true);
    const n = db.insert(notes).values({ highlightId: old, source: "weread", content: "新想法", writtenAt: T, createdAt: T }).returning().get().id;
    const b = highlight(newBook, "b");
    const c = highlight(newBook, "c");
    const links = write([
      { from: refOf("note", n), question: refOf("question", q1.id), kind: "conflicts", reason: "r1" },
      { from: refOf("highlight", old), question: refOf("question", q2.id), kind: "answers", reason: "old is context only" },
      { from: refOf("highlight", b), question: refOf("question", q2.id), kind: "supports", reason: "r2" },
      { from: refOf("highlight", c), question: refOf("question", q2.id), kind: "supports", reason: "r3" },
      { from: refOf("highlight", c), question: refOf("question", q1.id), kind: "supports", reason: "over the cap" },
    ]);
    expect(links.map((l) => [l.fromType, l.reason])).toEqual([
      ["note", "r1"],
      ["highlight", "r2"],
      ["highlight", "r3"],
    ]);
    expect(links[0]!.fromId).toBe(n);
  });

  it("hands over at most 40 candidates at a time", () => {
    createQuestion(db, { title: "q" });
    for (let i = 0; i < 45; i++) highlight(newBook, `h${i}`);
    expect(activationBrief(db, newBook)!.material).not.toContain("h40");
    write([]);
    expect(todos()).toMatchObject([{ count: 5 }]);
    expect(activationBrief(db, newBook)!.material).toContain("新划线：h40");
  });
});
