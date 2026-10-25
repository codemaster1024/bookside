import { describe, expect, it } from "vitest";
import { DomainError } from "./errors.ts";
import { T0, days, seed } from "./fixtures.test-helper.ts";
import { createInsight } from "./insights.ts";
import {
  appendMessage,
  createQuestion,
  dueRevisits,
  getQuestion,
  listMessages,
  postponeRevisit,
  renameQuestion,
  setQuestionStatus,
} from "./questions.ts";

describe("questions", () => {
  it("can be renamed but not to an empty title", () => {
    const { db } = seed();
    const q = createQuestion(db, { title: "自由是什么" }, T0);
    expect(renameQuestion(db, q.id, "  自由和责任是什么关系？ ").title).toBe("自由和责任是什么关系？");
    expect(() => renameQuestion(db, q.id, "  ")).toThrow("不能为空");
  });

  it("starts unexplored and due for revisit in 3 days", () => {
    const { db } = seed();
    const q = createQuestion(db, { title: "自由是什么？" }, T0);
    expect(q.status).toBe("unexplored");
    expect(q.nextRevisitAt).toEqual(days(3));
  });

  it("rejects an origin that does not exist", () => {
    const { db } = seed();
    expect(() => createQuestion(db, { title: "q", origin: { type: "highlight", id: "nope" } })).toThrow(DomainError);
  });

  it("carries initial messages from a free conversation into the thread", () => {
    const { db, highlightId } = seed();
    const q = createQuestion(
      db,
      {
        title: "q",
        origin: { type: "highlight", id: highlightId },
        initialMessages: [
          { speaker: "me", content: "这里是什么意思？", highlightIds: [highlightId] },
          { speaker: "ai", content: "你觉得呢？" },
        ],
      },
      T0,
    );
    expect(listMessages(db, q.id).map((m) => m.speaker)).toEqual(["me", "ai"]);
    expect(q.status).toBe("exploring");
  });

  it("moves to exploring and resets the revisit clock when I reply", () => {
    const { db } = seed();
    const q = createQuestion(db, { title: "q" }, T0);
    postponeRevisit(db, q.id, {}, days(3));
    appendMessage(db, q.id, { speaker: "me", content: "我想是……" }, days(10));
    const after = getQuestion(db, q.id);
    expect(after.status).toBe("exploring");
    expect(after.revisitStep).toBe(0);
    expect(after.nextRevisitAt).toEqual(days(13));
  });

  it("leaves status and revisit alone when only the AI speaks", () => {
    const { db } = seed();
    const q = createQuestion(db, { title: "q" }, T0);
    appendMessage(db, q.id, { speaker: "ai", content: "你划这句是同意还是怀疑？" }, days(1));
    expect(getQuestion(db, q.id)).toMatchObject({ status: "unexplored", nextRevisitAt: days(3) });
  });

  it("walks the revisit intervals 3 → 7 → 21 → 60 → 60 days when postponed", () => {
    const { db } = seed();
    const q = createQuestion(db, { title: "q" }, T0);
    const gaps: number[] = [];
    let at = getQuestion(db, q.id).nextRevisitAt!;
    for (let i = 0; i < 4; i++) {
      const next = postponeRevisit(db, q.id, {}, at).nextRevisitAt!;
      gaps.push((next.getTime() - at.getTime()) / 86_400_000);
      at = next;
    }
    expect(gaps).toEqual([7, 21, 60, 60]);
  });

  it("pushes a question to the longest interval when the reader says not to ask for now", () => {
    const { db } = seed();
    const q = createQuestion(db, { title: "q" }, T0);
    const at = getQuestion(db, q.id).nextRevisitAt!;
    const next = postponeRevisit(db, q.id, { far: true }, at).nextRevisitAt!;
    expect((next.getTime() - at.getTime()) / 86_400_000).toBe(60);
  });

  it("lists due revisits, earliest first", () => {
    const { db } = seed();
    const late = createQuestion(db, { title: "late" }, days(1));
    const early = createQuestion(db, { title: "early" }, T0);
    createQuestion(db, { title: "not yet" }, days(5));
    expect(dueRevisits(db, days(4)).map((q) => q.id)).toEqual([early.id, late.id]);
  });

  it("refuses to resolve a question without an insight", () => {
    const { db } = seed();
    const q = createQuestion(db, { title: "q" }, T0);
    expect(() => setQuestionStatus(db, q.id, "resolved")).toThrow(
      expect.objectContaining({ code: "resolved_requires_insight" }),
    );
    createInsight(db, { content: "答案", author: "me", sources: [{ questionId: q.id }] });
    expect(setQuestionStatus(db, q.id, "resolved").status).toBe("resolved");
  });

  it("stops revisits when abandoned and restarts them from 3 days when reopened", () => {
    const { db } = seed();
    const q = createQuestion(db, { title: "q" }, T0);
    expect(setQuestionStatus(db, q.id, "abandoned", days(1)).nextRevisitAt).toBeNull();
    expect(dueRevisits(db, days(100))).toEqual([]);
    expect(setQuestionStatus(db, q.id, "exploring", days(50)).nextRevisitAt).toEqual(days(53));
  });

  it("keeps the revisit schedule when moving between revisited statuses", () => {
    const { db } = seed();
    const q = createQuestion(db, { title: "q" }, T0);
    expect(setQuestionStatus(db, q.id, "tentative", days(1)).nextRevisitAt).toEqual(days(3));
  });
});
