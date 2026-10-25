import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databasePath, openDb, schema } from "@bookside/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { output } from "./context.ts";
import { runCli } from "./run.ts";

let bookId: string;
let highlightId: string;

beforeAll(() => {
  // getDb() 在首次调用时才按 BOOKSIDE_HOME 打开数据库。
  process.env.BOOKSIDE_HOME = mkdtempSync(join(tmpdir(), "bookside-cli-"));
  const db = openDb(databasePath());
  bookId = db.insert(schema.books).values({ source: "local", title: "思考，快与慢" }).returning().get().id;
  highlightId = db
    .insert(schema.highlights)
    .values({ bookId, source: "local", text: "直觉不过是识别而已。", markedAt: new Date() })
    .returning()
    .get().id;
});

afterEach(() => {
  output.json = false;
  vi.restoreAllMocks();
});

async function run(...args: string[]): Promise<string> {
  return runWith(undefined, ...args);
}

async function runWith(stdin: string | undefined, ...args: string[]): Promise<string> {
  const r = await runCli(args, { stdin });
  if (r.code) throw new Error(r.stderr);
  return r.stdout.trimEnd();
}

const json = async <T>(...args: string[]): Promise<T> => JSON.parse(await run("--json", ...args)) as T;

describe("bookside CLI", () => {
  it("walks a probe through promotion into a resolved question", async () => {
    const short = (id: string) => id.slice(0, 8);
    await run("book", "purpose", `b:${short(bookId)}`, "想弄清直觉什么时候可信");
    expect(await run("book", "show", bookId)).toContain("读前目的：想弄清直觉什么时候可信");

    await run("probes", "add", "--highlight", `h:${short(highlightId)}`, "你同意还是怀疑？");
    const [probe] = await json<{ id: string }[]>("probes");
    expect(await run("probes")).toContain("原文：直觉不过是识别而已。");

    const q = await json<{ id: string; originHighlightId: string }>("probes", "promote", short(probe!.id), "--title", "专家直觉只是识别吗？");
    expect(q.originHighlightId).toBe(highlightId);

    await run("q", "say", `q:${short(q.id)}`, "--as", "me", "--cite", `h:${short(highlightId)}`, "我怀疑");
    await run("q", "say", q.id, "--as", "ai", "多出来的部分是什么？");
    await expect(run("q", "status", q.id, "已解决")).rejects.toThrow("先为这个问题沉淀至少一条观点");

    await run("insight", "new", "--as", "me", "--question", q.id, "直觉可信的前提是环境有规律");
    expect(await run("q", "status", q.id, "resolved")).toContain("已解决");

    const detail = await json<{ messages: { speaker: string; cited: unknown[] }[]; insights: { authorship: string }[] }>(
      "q",
      "show",
      q.id,
    );
    expect(detail.messages.map((m) => m.speaker)).toEqual(["me", "ai"]);
    expect(detail.messages[0]!.cited).toHaveLength(1);
    expect(detail.insights[0]!.authorship).toBe("mine");
  });

  it("hands new highlights to the agent as a todo and takes its probes back", async () => {
    const db = openDb(databasePath());
    const book = db.insert(schema.books).values({ source: "local", title: "刻意练习" }).returning().get().id;
    const h = db.insert(schema.highlights).values({ bookId: book, source: "local", text: "及时反馈是核心", markedAt: new Date() }).returning().get().id;
    const todos = await json<{ kind: string; bookId: string; brief: string }[]>("todo");
    const todo = todos.find((t) => t.kind === "probes" && t.bookId === book)!;
    expect(todo.brief).toBe(`bookside probes brief b:${book.slice(0, 8)}`);

    const brief = await run(...todo.brief.split(" ").slice(1));
    expect(brief).toContain(`[h:${h.slice(0, 8)}] 新划线：及时反馈是核心`);
    const writeBack = brief.match(/^(bookside probes write .+ -) <<'TEXT'$/m)![1]!;
    const out = await runWith(JSON.stringify({ probes: [{ target: `h:${h.slice(0, 8)}`, probe: "你最近一次得到及时反馈是什么时候？" }] }), ...writeBack.split(" ").slice(1));
    expect(out).toContain("已添加 1 条追问");
    expect((await json<{ kind: string; bookId: string }[]>("todo")).some((t) => t.kind === "probes" && t.bookId === book)).toBe(false);
  });

  it("rejects a reference of the wrong type", async () => {
    await expect(run("q", "show", `h:${highlightId.slice(0, 8)}`)).rejects.toThrow(/这里需要问题/);
  });

  it("requires exactly one probe target", async () => {
    await expect(run("probes", "add", "--book", bookId, "--highlight", highlightId, "x")).rejects.toThrow(/恰好给一个/);
  });
});

describe("auto export", () => {
  it("remembers the folder and refreshes it when the agent opens a session, until turned off", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "bookside-auto-")), "vault");
    expect(await run("export", dir, "--auto")).toContain("自动更新这里");
    await run("q", "new", "自动导出之后才记下的问题");
    expect(existsSync(join(dir, "questions", "自动导出之后才记下的问题.md"))).toBe(false);
    await run("todo");
    expect(existsSync(join(dir, "questions", "自动导出之后才记下的问题.md"))).toBe(true);
    expect(await run("export", "--auto-off")).toContain("已关闭自动导出");
    await run("q", "new", "关掉之后的问题");
    await run("todo");
    expect(existsSync(join(dir, "questions", "关掉之后的问题.md"))).toBe(false);
  });
});
