import { beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/client.ts";
import { books, highlights, notes, syncState } from "../db/schema.ts";
import { pendingProbes } from "../domain/probes.ts";
import { ReplyError, refOf } from "./brief.ts";
import { probeBrief, writeProbes } from "./probes.ts";
import { listTodos, settleTodos } from "./todo.ts";

const T = new Date("2026-10-10T00:00:00Z");
const LATER = new Date("2026-10-11T00:00:00Z");
let db: Db;
let bookId: string;

function addHighlight(text: string, opts: { considered?: boolean; createdAt?: Date } = {}) {
  return db
    .insert(highlights)
    .values({ bookId, source: "weread", text, markedAt: T, probeConsideredAt: opts.considered ? T : null, createdAt: opts.createdAt ?? T })
    .returning()
    .get().id;
}

const write = (reply: unknown, limit = 3, asOf = T) =>
  writeProbes(db, bookId, typeof reply === "string" ? reply : JSON.stringify(reply), { perBookLimit: limit, asOf });

beforeEach(() => {
  db = openDb(":memory:");
  bookId = db.insert(books).values({ source: "weread", title: "思考，快与慢", purpose: "想知道直觉何时可信" }).returning().get().id;
  db.insert(syncState).values({ key: "weread.baseline_at", value: T.toISOString() }).run();
});

describe("probeBrief", () => {
  it("hands over the purpose, earlier highlights and new content by ref, with the write-back command", () => {
    addHighlight("更早的一句", { considered: true });
    const h1 = addHighlight("直觉是一种识别");
    const b = probeBrief(db, bookId, { perBookLimit: 3 }, LATER);
    expect(b.material).toContain("想知道直觉何时可信");
    expect(b.material).toContain("- 更早的一句");
    expect(b.material).toContain(`[${refOf("highlight", h1)}] 新划线：直觉是一种识别`);
    expect(b.material).toContain("最多写 3 条追问");
    expect(b.writeBack).toBe(`bookside probes write ${refOf("book", bookId)} --as-of ${LATER.getTime()} -`);
  });

  it("shows an old highlight only as context for a new note on it", () => {
    const old = addHighlight("锚定效应无处不在", { considered: true });
    const noteId = db.insert(notes).values({ highlightId: old, source: "weread", content: "谈薪时我就被锚定了", writtenAt: T, createdAt: T }).returning().get().id;
    const b = probeBrief(db, bookId, { perBookLimit: 3 }, LATER);
    expect(b.material).toContain("旧划线，只作上下文：锚定效应无处不在");
    expect(b.material).toContain(`[${refOf("note", noteId)}] 新想法：谈薪时我就被锚定了`);
  });
});

describe("writeProbes", () => {
  it("creates the picked probes and marks the whole batch considered", () => {
    const h1 = addHighlight("直觉是一种识别");
    addHighlight("系统二很懒");
    const probes = write(`\`\`\`json\n{"probes":[{"target":"${refOf("highlight", h1)}","probe":"你同意直觉只是识别吗？"}]}\n\`\`\``);
    expect(probes).toMatchObject([{ highlightId: h1, content: "你同意直觉只是识别吗？" }]);
    expect(listTodos(db, { perBookLimit: 3 })).toEqual([]);
  });

  it("targets a new note", () => {
    const old = addHighlight("锚定效应无处不在", { considered: true });
    const noteId = db.insert(notes).values({ highlightId: old, source: "weread", content: "谈薪", writtenAt: T, createdAt: T }).returning().get().id;
    const probes = write({ probes: [{ target: refOf("highlight", old), probe: "旧的不行" }, { target: refOf("note", noteId), probe: "那次怎么被锚定的？" }] });
    expect(probes).toMatchObject([{ noteId, content: "那次怎么被锚定的？" }]);
  });

  it("ignores unknown, old or duplicate targets and enforces the per-book limit", () => {
    const old = addHighlight("旧", { considered: true });
    const [a, b, c] = ["a", "b", "c"].map((t) => addHighlight(t));
    const probes = write(
      {
        probes: [
          { target: "h:deadbeef", probe: "不存在" },
          { target: refOf("highlight", old), probe: "旧的" },
          { target: refOf("highlight", a!), probe: "一" },
          { target: refOf("highlight", a!), probe: "重复" },
          { target: refOf("highlight", b!), probe: "二" },
          { target: refOf("highlight", c!), probe: "三" },
        ],
      },
      2,
    );
    expect(probes.map((p) => p.content)).toEqual(["一", "二"]);
  });

  it("leaves content imported after the brief for the next batch", () => {
    addHighlight("交出去的");
    const late = addHighlight("后来同步进来的", { createdAt: LATER });
    write({ probes: [{ target: refOf("highlight", late), probe: "不该写上" }] });
    expect(pendingProbes(db)).toEqual([]);
    expect(listTodos(db, { perBookLimit: 3 })).toMatchObject([{ kind: "probes", bookId, count: 1 }]);
  });

  it("rejects a reply that is not the expected JSON, leaving candidates for a retry", () => {
    addHighlight("a");
    expect(() => write("不是 JSON")).toThrow(ReplyError);
    expect(() => write({ probes: [{ target: "h:1" }] })).toThrow(/格式不对/);
    expect(listTodos(db, { perBookLimit: 3 })).toHaveLength(1);
  });
});

describe("todos", () => {
  it("lists books with new content and skips highlights deleted at the source", () => {
    addHighlight("a");
    db.insert(highlights).values({ bookId, source: "weread", text: "删了", markedAt: T, deletedAtSourceAt: T }).run();
    expect(listTodos(db, { perBookLimit: 3 })).toEqual([
      { kind: "probes", bookId, bookTitle: "思考，快与慢", count: 1, brief: `bookside probes brief ${refOf("book", bookId)}` },
    ]);
  });

  it("settles probe candidates when no probes are wanted", () => {
    addHighlight("a");
    expect(listTodos(db, { perBookLimit: 0 })).toEqual([]);
    settleTodos(db, { perBookLimit: 0 });
    expect(listTodos(db, { perBookLimit: 3 })).toEqual([]);
  });
});
