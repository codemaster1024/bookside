import { describe, expect, it } from "vitest";
import { appendMessage, createInsight, createQuestion, loadSample, openDb, schema } from "@bookside/core";
import { createViewer } from "./index.ts";
import { markdownToHtml } from "./markdown.ts";

function setup() {
  const db = openDb(":memory:");
  const { bookId } = loadSample(db);
  const app = createViewer(db);
  const get = async (path: string) => {
    const r = await app.request(path);
    return { status: r.status, text: await r.text() };
  };
  return { db, bookId, get };
}

describe("viewer", () => {
  it("offers one thing to start with on the home page, plus the questions being thought about", async () => {
    const { get } = setup();
    const { status, text } = await get("/");
    expect(status).toBe(200);
    expect(text).toContain("你的读书记忆");
    expect(text).toContain("1 本书 · 5 条划线 · 1 个问题 · 0 条观点");
    expect(text).toContain("下次聊书，可以从这里开始 · 有个问题可以再想想了");
    expect(text).toMatch(/class="chat primary" data-copy="用书畔回访这个问题（q:[0-9a-f]{8}）：「铁屋子里先醒来的人，该不该叫醒别人？」"/);
    expect(text).toContain("你上次说：我觉得该叫，哪怕希望很小");
    expect(text).not.toContain("你想到了自己生活里的哪条「路」？");
  });

  it("walks a new reader through getting started", async () => {
    const text = await (await createViewer(openDb(":memory:")).request("/")).text();
    expect(text).toContain("还没有书");
    expect(text).toContain("<code>bookside init</code>");
  });

  it("renders a question thread, keeping the reader's words and the AI's apart", async () => {
    const { db, get } = setup();
    const q = db.select().from(schema.questions).get()!;
    const { text } = await get(`/questions/${q.id}`);
    expect(text).toContain('<div class="msg me"><div class="who">我 · ');
    expect(text).toContain('<div class="msg ai"><div class="who">AI · ');
    expect(text).toContain("假如一间铁屋子");
  });

  it("renders a book with its highlights, notes, probes and questions", async () => {
    const { bookId, get } = setup();
    const { text } = await get(`/books/${bookId}`);
    expect(text).toContain("《呐喊》");
    expect(text).toContain("读法 · 叙事");
    expect(text).toMatch(/<div class="probe row"><p><span class="k">追问<\/span>读到「走的人多了，也便成了路」/);
    expect(text).toContain("<h3>孔乙己</h3>");
    expect(text).toContain("他想体面，又体面不起来。");
    expect(text).toContain("还没有导读。");
  });

  it("lists books, questions and insights, and searches", async () => {
    const { db, get } = setup();
    const q = createQuestion(db, { title: "长期问题" });
    appendMessage(db, q.id, { speaker: "me", content: "x" });
    createInsight(db, { content: "叫醒别人之前，先想好醒来之后能做什么", author: "me", sources: [{ questionId: q.id }] });
    expect((await get("/books")).text).toContain('<p class="bt">呐喊</p>');
    expect((await get("/questions")).text).toContain("长期问题");
    expect((await get("/insights")).text).toContain("先想好醒来之后能做什么");
    expect((await get("/search?q=" + encodeURIComponent("铁屋子"))).text).toContain("假如一间铁屋子");
  });

  it("escapes content and answers 404 for unknown pages and ids", async () => {
    const { db, bookId, get } = setup();
    db.insert(schema.highlights).values({ bookId, source: "local", text: "<script>alert(1)</script>", markedAt: new Date() }).run();
    expect((await get(`/books/${bookId}`)).text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect((await get("/questions/nope")).status).toBe(404);
    expect((await get("/nope")).status).toBe(404);
  });
});

describe("markdownToHtml", () => {
  it("handles headings, lists, quotes and emphasis, escaping any HTML", () => {
    expect(markdownToHtml("## 一句话\n讲**习惯**\n\n- 一\n- 二\n\n> 引用\n\n<b>x</b>")).toBe(
      "<h4>一句话</h4>\n<p>讲<strong>习惯</strong></p>\n<ul>\n<li>一</li>\n<li>二</li>\n</ul>\n<blockquote>引用</blockquote>\n<p>&lt;b&gt;x&lt;/b&gt;</p>",
    );
  });
});
