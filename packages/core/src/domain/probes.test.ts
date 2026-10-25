import { describe, expect, it } from "vitest";
import { books, highlights } from "../db/schema.ts";
import { T0, seed } from "./fixtures.test-helper.ts";
import { addProbe, dismissProbe, pendingProbes, promoteProbe } from "./probes.ts";

describe("probes", () => {
  it("promotes into a question titled after the probe, originating where it hung", () => {
    const { db, highlightId } = seed();
    const p = addProbe(db, { target: { type: "highlight", id: highlightId }, content: "你同意还是怀疑？" });
    const q = promoteProbe(db, p.id, {}, T0);
    expect(q).toMatchObject({ title: "你同意还是怀疑？", originHighlightId: highlightId, status: "unexplored" });
    expect(pendingProbes(db)).toEqual([]);
  });

  it("gives a probe on a note the note's highlight as origin", () => {
    const { db, noteId, highlightId } = seed();
    const p = addProbe(db, { target: { type: "note", id: noteId }, content: "偷换了哪个概念？" });
    expect(promoteProbe(db, p.id, { title: "偷换概念" }).originHighlightId).toBe(highlightId);
  });

  it("gives a reading-purpose probe on a book the book as origin", () => {
    const { db, bookId } = seed();
    const p = addProbe(db, { target: { type: "book", id: bookId }, content: "作者想反驳谁？" });
    expect(promoteProbe(db, p.id).originBookId).toBe(bookId);
  });

  it("cannot promote or dismiss a probe twice", () => {
    const { db, bookId } = seed();
    const p = addProbe(db, { target: { type: "book", id: bookId }, content: "?" });
    dismissProbe(db, p.id);
    expect(() => promoteProbe(db, p.id)).toThrow(expect.objectContaining({ code: "probe_not_pending" }));
    expect(() => dismissProbe(db, p.id)).toThrow(expect.objectContaining({ code: "probe_not_pending" }));
  });

  it("filters pending probes by book, including those on its highlights and notes", () => {
    const { db, bookId, highlightId, noteId } = seed();
    const other = db.insert(books).values({ source: "local", title: "另一本" }).returning().get().id;
    const otherHl = db
      .insert(highlights)
      .values({ bookId: other, source: "local", text: "x", markedAt: T0 })
      .returning()
      .get().id;
    const onBook = addProbe(db, { target: { type: "book", id: bookId }, content: "a" }, T0);
    const onHl = addProbe(db, { target: { type: "highlight", id: highlightId }, content: "b" }, T0);
    const onNote = addProbe(db, { target: { type: "note", id: noteId }, content: "c" }, T0);
    addProbe(db, { target: { type: "highlight", id: otherHl }, content: "d" }, T0);
    expect(pendingProbes(db, { bookId }).map((p) => p.id).sort()).toEqual([onBook.id, onHl.id, onNote.id].sort());
    expect(pendingProbes(db)).toHaveLength(4);
  });
});
