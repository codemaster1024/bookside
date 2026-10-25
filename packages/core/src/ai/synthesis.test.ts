import { describe, expect, it } from "vitest";
import { createInsight } from "../domain/insights.ts";
import { seed } from "../domain/fixtures.test-helper.ts";
import { appendMessage, createQuestion } from "../domain/questions.ts";
import { books } from "../db/schema.ts";
import { refOf } from "./brief.ts";
import { synthesisBrief } from "./synthesis.ts";

describe("synthesisBrief", () => {
  it("gathers the reader's highlights, notes, questions and existing insights by ref", () => {
    const { db, bookId, highlightId } = seed();
    const q = createQuestion(db, { title: "作者偷换了哪个概念？", origin: { type: "highlight", id: highlightId } });
    appendMessage(db, q.id, { speaker: "me", content: "自由和放任" });
    createInsight(db, { content: "已有观点", author: "me", sources: [{ questionId: q.id }] });
    const b = synthesisBrief(db, bookId);
    expect(b.material).toContain(`[${refOf("highlight", highlightId)}] 原文\n    想法：作者在偷换概念`);
    expect(b.material).toContain(`[${refOf("question", q.id)}] 作者偷换了哪个概念？\n    读者：自由和放任`);
    expect(b.material).toContain("- 已有观点");
    expect(b.instructions).toContain("bookside insight new");
    expect(b.writeBack).toBeUndefined();
  });

  it("refuses a book with nothing to work from", () => {
    const { db } = seed();
    const empty = db.insert(books).values({ source: "local", title: "空" }).returning().get().id;
    expect(() => synthesisBrief(db, empty)).toThrow(/没有可整理的材料/);
  });
});
