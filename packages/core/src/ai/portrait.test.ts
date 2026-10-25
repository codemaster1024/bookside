import { describe, expect, it } from "vitest";
import { books, highlights } from "../db/schema.ts";
import { T0, seed } from "../domain/fixtures.test-helper.ts";
import { createQuestion } from "../domain/questions.ts";
import { refOf } from "./brief.ts";
import { latestPortrait, listPortraits, portraitBrief, portraitDue, writePortrait } from "./portrait.ts";
import { listTodos } from "./todo.ts";

const DAY = 86_400_000;

/** 一本书里再加 n 条划线（共用测试数据里已有一条），返回它们的 id。 */
function addHighlights(db: ReturnType<typeof seed>["db"], bookId: string, n: number, at = T0, createdAt = at): string[] {
  return Array.from({ length: n }, (_, i) => db.insert(highlights).values({ bookId, source: "weread", text: `第 ${i} 句`, markedAt: at, createdAt }).returning().get().id);
}

const reply = (reread: string, themes: string[][], question?: string) =>
  JSON.stringify({
    reread: { highlight: reread, why: "和你最近的问题有关" },
    themes: themes.map((hs, i) => ({ title: `主题${i}`, gist: "你反复停在这里", highlights: hs })),
    portrait: "你读书在意人怎么选。",
    next: { text: "回到那个问题再想一次", ...(question ? { question } : {}) },
  });

describe("reading portrait", () => {
  it("waits until there are enough highlights, then asks for one through todo", () => {
    const { db, bookId } = seed();
    addHighlights(db, bookId, 10);
    expect(portraitDue(db).due).toBe(false);
    expect(() => portraitBrief(db)).toThrow(/攒到 20 条/);
    addHighlights(db, bookId, 9);
    expect(portraitDue(db)).toEqual({ due: true, newHighlights: 20 });
    expect(listTodos(db, { perBookLimit: 0 }).at(-1)).toMatchObject({ kind: "portrait", brief: "bookside portrait --brief" });
  });

  it("hands over recent and older highlights, open questions, and the reader's own notes", () => {
    const { db, bookId, highlightId } = seed();
    const now = new Date(T0.getTime() + 60 * DAY);
    const recent = addHighlights(db, bookId, 20, new Date(now.getTime() - DAY));
    const q = createQuestion(db, { title: "该不该叫醒别人" });
    const b = portraitBrief(db, now);
    expect(b.material).toContain(`[${refOf("highlight", recent[0]!)}]`);
    expect(b.material).toContain(`[${refOf("highlight", highlightId)}] 2026-10-01 原文`);
    expect(b.material).toContain("    想法：作者在偷换概念");
    expect(b.material).toContain(`[${refOf("question", q.id)}] 该不该叫醒别人`);
    expect(b.writeBack).toBe("bookside portrait --write -");
  });

  it("keeps one binge-read book from crowding out the rest", () => {
    const { db, bookId } = seed();
    const now = new Date(T0.getTime() + 60 * DAY);
    const other = db.insert(books).values({ source: "weread", title: "另一本" }).returning().get().id;
    const old = addHighlights(db, other, 5, new Date(now.getTime() - 40 * DAY));
    addHighlights(db, bookId, 200, new Date(now.getTime() - DAY));
    const b = portraitBrief(db, now);
    expect(b.material.match(/^\[h:/gm)!.length).toBeLessThanOrEqual(30 + 6);
    expect(b.material).toContain(`[${refOf("highlight", old[0]!)}]`);
    expect(b.material).toContain("【《另一本》");
  });

  it("keeps only quotes that are real highlights, and expands them for the homepage", () => {
    const { db, bookId, highlightId } = seed();
    const [a, b] = addHighlights(db, bookId, 20);
    const q = createQuestion(db, { title: "问题" });
    const p = writePortrait(
      db,
      reply(refOf("highlight", highlightId), [[refOf("highlight", a!), "h:deadbeef"], ["h:00000000"], [refOf("highlight", b!)]], refOf("question", q.id)),
      { by: "claude-code" },
    );
    expect(p.reread).toMatchObject({ highlightId, text: "原文", bookTitle: "书", why: "和你最近的问题有关" });
    expect(p.themes.map((t) => t.quotes.map((x) => x.highlightId))).toEqual([[a], [b]]);
    expect(p.next).toMatchObject({ questionId: q.id, questionTitle: "问题" });
    expect(p.highlightCount).toBe(21);
    expect(latestPortrait(db)?.id).toBe(p.id);
  });

  it("rejects a reread quote that is not one of the reader's highlights", () => {
    const { db, bookId } = seed();
    const [a] = addHighlights(db, bookId, 20);
    expect(() => writePortrait(db, reply("h:deadbeef", [[refOf("highlight", a!)]]))).toThrow(/不是材料里的划线/);
    expect(() => writePortrait(db, reply(refOf("highlight", a!), [["h:deadbeef"]]))).toThrow(/主题引用的划线都对不上/);
  });

  it("asks again once enough new highlights come in, or a week later with any new ones", () => {
    const { db, bookId, highlightId } = seed();
    addHighlights(db, bookId, 20);
    // 共用数据里的划线是测试运行时导入的，画像写在那之后。
    const written = new Date(Date.now() + 60_000);
    writePortrait(db, reply(refOf("highlight", highlightId), [[refOf("highlight", highlightId)]]), {}, written);
    expect(portraitDue(db, new Date(written.getTime() + DAY)).due).toBe(false);
    const other = db.insert(books).values({ source: "kindle", title: "另一本" }).returning().get().id;
    addHighlights(db, other, 2, written, new Date(written.getTime() + 1000));
    expect(portraitDue(db, new Date(written.getTime() + 2 * DAY))).toEqual({ due: false, newHighlights: 2 });
    expect(portraitDue(db, new Date(written.getTime() + 8 * DAY)).due).toBe(true);
    addHighlights(db, other, 28, written, new Date(written.getTime() + 2000));
    expect(portraitDue(db, new Date(written.getTime() + 2 * DAY)).due).toBe(true);
  });

  it("keeps every portrait, and from the second one on notes what changed", () => {
    const { db, bookId, highlightId } = seed();
    addHighlights(db, bookId, 20);
    const h = refOf("highlight", highlightId);
    const withChange = (change: string) => JSON.stringify({ ...JSON.parse(reply(h, [[h]])), change });
    const first = writePortrait(db, withChange("第一份不该有变化"), {}, new Date(Date.now() + 60_000));
    expect(first.change).toBeUndefined();
    expect(portraitBrief(db).material).toContain("上一份画像");
    const second = writePortrait(db, withChange("这几周转向了怎么开口"), {}, new Date(Date.now() + 120_000));
    expect(second.change).toBe("这几周转向了怎么开口");
    expect(listPortraits(db).map((p) => p.id)).toEqual([second.id, first.id]);
  });
});
