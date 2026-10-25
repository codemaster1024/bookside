import { describe, expect, it } from "vitest";
import { T0, seed } from "./fixtures.test-helper.ts";
import { confirmLink, createLink, linksOf, pendingProposals, proposeLink, rejectLink, removeLink } from "./links.ts";
import { createQuestion } from "./questions.ts";

function setup() {
  const s = seed();
  const q = createQuestion(s.db, { title: "旧问题" }, T0);
  const from = { type: "highlight" as const, id: s.highlightId };
  const to = { type: "question" as const, id: q.id };
  return { ...s, from, to };
}

describe("links", () => {
  it("does not count an AI proposal as a link until I confirm it", () => {
    const { db, from, to } = setup();
    const p = proposeLink(db, { from, to, kind: "answers", reason: "这段可能回答了你的问题" });
    expect(pendingProposals(db).map((l) => l.id)).toEqual([p.id]);
    expect(linksOf(db, to)).toEqual([]);
    confirmLink(db, p.id);
    expect(linksOf(db, to).map((l) => l.id)).toEqual([p.id]);
    expect(linksOf(db, from).map((l) => l.id)).toEqual([p.id]);
  });

  it("lets me remove a confirmed link, and AI does not propose it again", () => {
    const { db, from, to } = setup();
    const l = createLink(db, { from, to, kind: "supports" });
    removeLink(db, l.id);
    expect(linksOf(db, to)).toEqual([]);
    expect(proposeLink(db, { from, to, kind: "supports" })).toMatchObject({ id: l.id, state: "rejected" });
    expect(() => removeLink(db, l.id)).toThrow("只能解除已确认的关联");
  });

  it("never re-proposes a link I rejected", () => {
    const { db, from, to } = setup();
    const p = proposeLink(db, { from, to, kind: "answers" });
    rejectLink(db, p.id);
    expect(proposeLink(db, { from, to, kind: "answers" })).toMatchObject({ id: p.id, state: "rejected" });
    expect(pendingProposals(db)).toEqual([]);
  });

  it("only decides a proposal once", () => {
    const { db, from, to } = setup();
    const p = proposeLink(db, { from, to, kind: "answers" });
    confirmLink(db, p.id);
    expect(() => rejectLink(db, p.id)).toThrow(expect.objectContaining({ code: "link_not_proposed" }));
  });

  it("lets me create a link directly, confirming any matching proposal", () => {
    const { db, from, to } = setup();
    const p = proposeLink(db, { from, to, kind: "extends" });
    expect(createLink(db, { from, to, kind: "extends" })).toMatchObject({ id: p.id, state: "confirmed" });
    expect(createLink(db, { from, to, kind: "supports" })).toMatchObject({ state: "confirmed", proposedBy: "me" });
  });

  it("refuses links to objects that do not exist", () => {
    const { db, from } = setup();
    expect(() => proposeLink(db, { from, to: { type: "insight", id: "nope" }, kind: "supports" })).toThrow(
      expect.objectContaining({ code: "not_found" }),
    );
  });
});
