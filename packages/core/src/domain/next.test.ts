import { describe, expect, it } from "vitest";
import { highlights } from "../db/schema.ts";
import { T0, seed } from "./fixtures.test-helper.ts";
import { proposeLink } from "./links.ts";
import { nextUp } from "./next.ts";
import { addProbe } from "./probes.ts";
import { createQuestion } from "./questions.ts";

const later = new Date(T0.getTime() + 10 * 86_400_000);

describe("nextUp", () => {
  it("puts a new cross-book link first, then due questions from the book being discussed, then the oldest due, then probes", () => {
    const { db, bookId, highlightId } = seed();
    const elsewhere = createQuestion(db, { title: "长期问题" }, T0);
    const here = createQuestion(db, { title: "这本书上的", origin: { type: "book", id: bookId } }, new Date(T0.getTime() + 86_400_000));
    addProbe(db, { target: { type: "highlight", id: highlightId }, content: "追问" }, T0);
    expect(nextUp(db, { bookId }, later).items.map((s) => s.kind === "revisit" ? s.question.title : s.kind)).toEqual(["这本书上的", "长期问题", "probe"]);
    expect(nextUp(db, {}, later).items.map((s) => s.kind === "revisit" ? s.question.title : s.kind)).toEqual(["长期问题", "这本书上的", "probe"]);

    const h2 = db.insert(highlights).values({ bookId, source: "local", text: "另一句", markedAt: T0 }).returning().get().id;
    proposeLink(db, { from: { type: "highlight", id: h2 }, to: { type: "question", id: elsewhere.id }, kind: "answers", reason: "r" });
    const r = nextUp(db, { bookId }, later);
    expect(r.items[0]!.kind).toBe("link");
    expect(r.counts).toEqual({ links: 1, revisits: 2, probes: 1 });
    expect(here.id).toBeTruthy();
  });

  it("has nothing when nothing is waiting", () => {
    const { db } = seed();
    expect(nextUp(db).items).toEqual([]);
  });
});
