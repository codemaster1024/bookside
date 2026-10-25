import { beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "./client.ts";
import { books, highlights, insightSources, insights, links, notes, probes, questions } from "./schema.ts";

let db: Db;
let bookId: string;
let highlightId: string;

beforeEach(() => {
  db = openDb(":memory:");
  bookId = db.insert(books).values({ source: "weread", wereadBookId: "b1", title: "书" }).returning().get().id;
  highlightId = db
    .insert(highlights)
    .values({ bookId, source: "weread", wereadBookmarkId: "m1", text: "一段原文", markedAt: new Date() })
    .returning()
    .get().id;
});

describe("schema invariants", () => {
  it("rejects unknown enum values", () => {
    expect(() => db.insert(books).values({ source: "kobo" as "local", title: "x" }).run()).toThrow(/CHECK/);
  });

  it("allows a question without origin (a long-running question)", () => {
    const q = db.insert(questions).values({ title: "什么是自由？" }).returning().get();
    expect(q.status).toBe("unexplored");
  });

  it("rejects a question with more than one origin", () => {
    expect(() =>
      db.insert(questions).values({ title: "q", originBookId: bookId, originHighlightId: highlightId }).run(),
    ).toThrow(/CHECK/);
  });

  it("requires a probe to hang on exactly one object", () => {
    expect(() => db.insert(probes).values({ content: "p" }).run()).toThrow(/CHECK/);
    expect(() => db.insert(probes).values({ content: "p", bookId, highlightId }).run()).toThrow(/CHECK/);
    expect(() => db.insert(probes).values({ content: "p", highlightId }).run()).not.toThrow();
  });

  it("does not let a probe be both promoted and dismissed", () => {
    const q = db.insert(questions).values({ title: "q" }).returning().get();
    expect(() =>
      db.insert(probes).values({ content: "p", bookId, promotedQuestionId: q.id, dismissedAt: new Date() }).run(),
    ).toThrow(/CHECK/);
  });

  it("requires every note to hang on an existing highlight", () => {
    expect(() =>
      db.insert(notes).values({ highlightId: "missing", source: "local", content: "n", writtenAt: new Date() }).run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it("deduplicates synced highlights by source id", () => {
    expect(() =>
      db
        .insert(highlights)
        .values({ bookId, source: "weread", wereadBookmarkId: "m1", text: "dup", markedAt: new Date() })
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it("requires an insight source to be exactly one of question or highlight", () => {
    const insightId = db.insert(insights).values({}).returning().get().id;
    expect(() => db.insert(insightSources).values({ insightId }).run()).toThrow(/CHECK/);
    db.insert(insightSources).values({ insightId, highlightId }).run();
    expect(() => db.insert(insightSources).values({ insightId, highlightId }).run()).toThrow(/UNIQUE/);
  });

  it("rejects a link from an object to itself", () => {
    expect(() =>
      db
        .insert(links)
        .values({
          fromType: "highlight",
          fromId: highlightId,
          toType: "highlight",
          toId: highlightId,
          kind: "supports",
          state: "proposed",
          proposedBy: "ai",
        })
        .run(),
    ).toThrow(/CHECK/);
  });
});
