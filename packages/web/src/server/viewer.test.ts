import { describe, expect, it } from "vitest";
import { appendMessage, createInsight, createQuestion, loadSample, openDb, refOf, reviseInsight, schema, setQuestionStatus, writePortrait } from "@bookside/core";
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
  it("offers one thing to start with on the home page, with analysis and the books that matter", async () => {
    const { get } = setup();
    const { status, text } = await get("/");
    expect(status).toBe(200);
    expect(text).toContain('<div class="frontis">');
    expect(text).toContain('<div class="stat"><div class="n">22</div><div class="k">条划线');
    expect(text).toContain("现在看到的是示例书");
    expect(text).toContain("下次聊书，可以从这里开始 · 有个问题可以再想想了");
    expect(text).toContain("你上次说：我觉得该叫，哪怕希望很小");
    expect(text).toMatch(/data-copy="用书畔：关于「铁屋子里先醒来的人，该不该叫醒别人？」（q:[0-9a-f]{8}），我现在的想法是：" data-label="说说我现在的想法" data-input/);
    expect(text).toContain("下次和它聊书时会自动写好");
    expect(text).toContain('data-copy="用书畔给我写一份读书画像"');
    expect(text).toContain("你的划线都来自 <b>文学</b>");
    expect(text).toContain("文学 22 条，历史 0 条");
    expect(text).toContain("这一年的划线");
    expect(text).toContain("你最常回到的书");
    expect(text).toContain("叙事 1 本");
  });

  it("shows the reading portrait: a line worth rereading, themes with the reader's own highlights, and a next step", async () => {
    const { db, bookId, get } = setup();
    const [h1, h2] = db.select().from(schema.highlights).all();
    const q = db.select().from(schema.questions).get()!;
    writePortrait(
      db,
      JSON.stringify({
        reread: { highlight: refOf("highlight", h1!.id), why: "这和你最近的问题离得很近。" },
        themes: [{ title: "先醒来的人", gist: "你反复停在看见了却改变不了的段落上。", highlights: [refOf("highlight", h2!.id)] }],
        portrait: "你读书在意人怎么选。\n\n你的问题大多从鲁迅开始。",
        next: { text: "回到那个问题再想一次", question: refOf("question", q.id) },
      }),
      { by: "claude-code" },
    );
    const { text } = await get("/");
    expect(text).toContain(`<blockquote>${h1!.text}</blockquote>`);
    expect(text).toContain("这和你最近的问题离得很近。");
    expect(text).toContain("<h3>先醒来的人</h3>");
    expect(text).toContain(`href="/books/${bookId}#h-${h2!.id}"`);
    expect(text).toContain("<p>你读书在意人怎么选。</p>");
    expect(text).toContain("<p>你的问题大多从鲁迅开始。</p>");
    expect(text).toContain("回到那个问题再想一次");
    expect(text).toContain("由智能体（claude-code）根据 22 条划线写成");
    const history = await get("/portraits");
    expect(history.text).toContain("<b>先醒来的人</b>");
    expect(history.text).toContain("最新");
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

  it("shows how a question moved, what an insight used to say, and what a book was read for against what it left", async () => {
    const { db, bookId, get } = setup();
    const q = db.select().from(schema.questions).get()!;
    const i = createInsight(db, { content: "AI 起草的说法", author: "ai", sources: [{ questionId: q.id }] });
    reviseInsight(db, i.id, { content: "我改过的说法", author: "me" });
    setQuestionStatus(db, q.id, "resolved");
    const question = (await get(`/questions/${q.id}`)).text;
    expect(question).toContain("走过的路");
    expect(question).toContain("提出这个问题");
    expect(question).toContain("你说：我觉得该叫");
    expect(question).toContain("探讨中 → <b>已解决</b>");
    expect(question).toContain("改过 1 次，看以前的说法");
    expect(question).toContain("AI 起草的说法");
    createInsight(db, { content: "读完的看法", author: "me", sources: [{ bookId }] });
    const book = (await get(`/books/${bookId}`)).text;
    expect(book).toContain("读之前，你想要的");
    expect(book).toContain("中学课本里读过几篇");
    expect(book).toContain("读之后，你留下的");
  });

  it("shows a QR code for phones only when opened to the local network", async () => {
    const db = openDb(":memory:");
    const open = createViewer(db, { phoneUrl: () => "http://192.168.1.8:4317/" });
    const text = await (await open.request("/phone")).text();
    expect(text).toContain("<svg");
    expect(text).toContain("http://192.168.1.8:4317/");
    expect(await (await open.request("/")).text()).toContain('<a href="/phone">在手机上看</a>');
    const closed = await (await createViewer(db).request("/phone")).text();
    expect(closed).toContain("bookside web --host");
    expect(closed).not.toContain("<svg");
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
