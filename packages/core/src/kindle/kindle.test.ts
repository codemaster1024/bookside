import { beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/client.ts";
import { books, highlights, notes } from "../db/schema.ts";
import { listTodos } from "../ai/todo.ts";
import { parseClippings } from "./clippings.ts";
import { importKindle } from "./import.ts";

const EN = `﻿Thinking, Fast and Slow (Daniel Kahneman)\r
- Your Highlight on page 12 | Location 180-182 | Added on Monday, March 4, 2024 9:15:32 PM\r
\r
Intuition is nothing more and nothing less than recognition.\r
==========\r
Thinking, Fast and Slow (Daniel Kahneman)\r
- Your Note on page 12 | Location 182 | Added on Monday, March 4, 2024 9:16:00 PM\r
\r
Firefighters again.\r
==========\r
Thinking, Fast and Slow (Daniel Kahneman)\r
- Your Bookmark on page 13 | Location 190 | Added on Monday, March 4, 2024 9:17:00 PM\r
\r
\r
==========\r
`;

const ZH = `思考，快与慢（修订版） (丹尼尔·卡尼曼)
- 您在第 20 页（位置 #300-310）的标注 | 添加于 2024年3月5日星期二 下午9:15:32

直觉不过是识别而已。
==========
思考，快与慢（修订版） (丹尼尔·卡尼曼)
- 您在位置 #500 的笔记 | 添加于 2024年3月5日星期二 上午12:05:00

这里没划线，只写了一句
==========
无名书
- Your Highlight at location 40-2 | Added on Tuesday, March 5, 2024 10:00:00 AM

<You have reached the clipping limit for this item>
==========
`;

describe("parseClippings", () => {
  it("reads English and Chinese entries and skips bookmarks and clipping-limit notices", () => {
    const list = parseClippings(EN + ZH);
    expect(list.map((c) => [c.title, c.author, c.kind, c.start, c.end])).toEqual([
      ["Thinking, Fast and Slow", "Daniel Kahneman", "highlight", 180, 182],
      ["Thinking, Fast and Slow", "Daniel Kahneman", "note", 182, 182],
      ["思考，快与慢（修订版）", "丹尼尔·卡尼曼", "highlight", 300, 310],
      ["思考，快与慢（修订版）", "丹尼尔·卡尼曼", "note", 500, 500],
    ]);
    expect(list[0]!.addedAt).toEqual(new Date(2024, 2, 4, 21, 15, 32));
    expect(list[2]!.addedAt).toEqual(new Date(2024, 2, 5, 21, 15, 32));
    expect(list[3]!.addedAt).toEqual(new Date(2024, 2, 5, 0, 5, 0));
    expect(list[0]!.text).toBe("Intuition is nothing more and nothing less than recognition.");
  });

  it("expands abbreviated ranges and falls back to page numbers", () => {
    const [a, b] = parseClippings(`书 (作者)
- Your Highlight Loc. 1180-82 | Added on Tuesday, March 5, 2024 10:00:00 AM

一
==========
书 (作者)
- Your Highlight on page 7 | Added on Tuesday, March 5, 2024 10:00:00 AM

二
==========`);
    expect([a!.start, a!.end, a!.byPage]).toEqual([1180, 1182, false]);
    expect([b!.start, b!.end, b!.byPage]).toEqual([7, 7, true]);
  });
});

describe("importKindle", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(":memory:");
  });

  it("imports books, highlights and notes, attaching a note to the highlight that covers it", () => {
    const r = importKindle(db, EN + ZH);
    expect(r).toEqual({ baseline: true, books: 2, newHighlights: 2, updatedHighlights: 0, newNotes: 2 });
    expect(db.select().from(books).all().map((b) => [b.source, b.title, b.author])).toEqual([
      ["kindle", "Thinking, Fast and Slow", "Daniel Kahneman"],
      ["kindle", "思考，快与慢（修订版）", "丹尼尔·卡尼曼"],
    ]);
    const fire = db.select().from(notes).all().find((n) => n.content === "Firefighters again.")!;
    expect(db.select().from(highlights).all().find((h) => h.id === fire.highlightId)!.range).toBe("180-182");
    const orphan = db.select().from(highlights).all().find((h) => h.kind === "from_note")!;
    expect(orphan.text).toBe("（Kindle 位置 500，没有划线）");
  });

  it("is idempotent, and treats a later clipping at the same start as an edit", () => {
    importKindle(db, EN);
    const edited = `${EN}Thinking, Fast and Slow (Daniel Kahneman)
- Your Highlight on page 12 | Location 180-185 | Added on Tuesday, March 5, 2024 9:15:32 PM

Intuition is nothing more and nothing less than recognition, says Simon.
==========
`;
    expect(importKindle(db, edited)).toMatchObject({ baseline: false, newHighlights: 0, updatedHighlights: 1, newNotes: 0 });
    expect(importKindle(db, edited)).toMatchObject({ newHighlights: 0, updatedHighlights: 0, newNotes: 0 });
    expect(db.select().from(highlights).all().map((h) => [h.range, h.text])).toEqual([
      ["180-185", "Intuition is nothing more and nothing less than recognition, says Simon."],
    ]);
  });

  it("treats the first import as a baseline and later additions as new content for the agent", () => {
    importKindle(db, EN);
    expect(listTodos(db, { perBookLimit: 3 })).toEqual([]);
    importKindle(db, ZH);
    expect(listTodos(db, { perBookLimit: 3 })).toMatchObject([{ kind: "probes", bookTitle: "思考，快与慢（修订版）", count: 2 }]);
  });
});
