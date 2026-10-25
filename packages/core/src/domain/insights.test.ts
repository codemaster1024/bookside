import { describe, expect, it } from "vitest";
import { T0, days, seed } from "./fixtures.test-helper.ts";
import { authorshipOf, createInsight, deleteInsight, getInsight, insightsOfQuestion, listInsights, reviseInsight } from "./insights.ts";
import { confirmLink, linksOf, proposeLink } from "./links.ts";
import { createQuestion } from "./questions.ts";

describe("insights", () => {
  it("requires at least one source", () => {
    const { db } = seed();
    expect(() => createInsight(db, { content: "x", author: "me", sources: [] })).toThrow(
      expect.objectContaining({ code: "insight_requires_source" }),
    );
  });

  it("is mine when I wrote every version", () => {
    const { db, highlightId } = seed();
    const i = createInsight(db, { content: "v1", author: "me", sources: [{ highlightId }] }, T0);
    const v2 = reviseInsight(db, i.id, { content: "v2", author: "me" }, days(1));
    expect(v2).toMatchObject({ content: "v2", authorship: "mine" });
    expect(v2.versions).toHaveLength(2);
  });

  it("stays AI-assisted after I edit an AI draft", () => {
    const { db, highlightId } = seed();
    const i = createInsight(db, { content: "AI 扩写", author: "ai", sources: [{ highlightId }] }, T0);
    expect(reviseInsight(db, i.id, { content: "我改了三分之二", author: "me" }, days(1)).authorship).toBe(
      "ai_assisted",
    );
  });

  it("becomes mine again only when I rewrite from scratch", () => {
    const { db, highlightId } = seed();
    const i = createInsight(db, { content: "AI 扩写", author: "ai", sources: [{ highlightId }] }, T0);
    expect(reviseInsight(db, i.id, { content: "重写", author: "me", rewrite: true }, days(1)).authorship).toBe("mine");
  });

  it("treats the last-written version as latest even within the same millisecond", () => {
    const { db, highlightId } = seed();
    const i = createInsight(db, { content: "v1", author: "ai", sources: [{ highlightId }] }, T0);
    const v = reviseInsight(db, i.id, { content: "v2", author: "me", rewrite: true }, T0);
    expect(v).toMatchObject({ content: "v2", authorship: "mine" });
  });

  it("derives authorship from the lineage since the last rewrite", () => {
    expect(authorshipOf([{ author: "ai", rewrite: true }, { author: "me", rewrite: true }, { author: "me", rewrite: false }])).toBe("mine");
    expect(authorshipOf([{ author: "me", rewrite: true }, { author: "ai", rewrite: false }, { author: "me", rewrite: false }])).toBe("ai_assisted");
  });

  it("lists insights drawn from a question, newest first", () => {
    const { db } = seed();
    const q = createQuestion(db, { title: "q" }, T0);
    const a = createInsight(db, { content: "a", author: "me", sources: [{ questionId: q.id }] }, days(1));
    const b = createInsight(db, { content: "b", author: "me", sources: [{ questionId: q.id }] }, days(2));
    expect(insightsOfQuestion(db, q.id).map((i) => i.id)).toEqual([b.id, a.id]);
  });

  it("deletes an insight with its versions, sources and links", () => {
    const { db, highlightId } = seed();
    const i = createInsight(db, { content: "要删的", author: "ai", sources: [{ highlightId }] });
    confirmLink(db, proposeLink(db, { from: { type: "highlight", id: highlightId }, to: { type: "insight", id: i.id }, kind: "supports" }).id);
    deleteInsight(db, i.id);
    expect(listInsights(db)).toEqual([]);
    expect(linksOf(db, { type: "highlight", id: highlightId })).toEqual([]);
    expect(() => getInsight(db, i.id)).toThrow(/不存在/);
  });
});
