// 只读查看器：在浏览器里看见自己的问题、观点和划线。每条旁边可以「接着聊」，把一句话贴给智能体；这里不写入任何东西。
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import {
  type BookSummary,
  type Conn,
  type Db,
  type InsightWithSources,
  type Link,
  type Question,
  type Suggestion,
  DomainError,
  LINK_KIND_LABELS,
  QUESTION_STATUS_LABELS,
  describeProbeTarget,
  describeRef,
  getBookDetail,
  getQuestionDetail,
  insightsOfBook,
  listBooks,
  listGuides,
  listInsights,
  listMessages,
  listQuestions,
  nextUp,
  pendingProbes,
  readingModeOf,
  refOf,
  reviewsOf,
  searchAll,
} from "@bookside/core";
import { Hono } from "hono";
import { html, raw } from "hono/html";
import { copyButton, page } from "./layout.ts";
import { markdownToHtml } from "./markdown.ts";

const pad = (n: number) => String(n).padStart(2, "0");
const day = (d: Date | null | undefined) => (d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : "—");
const clip = (s: string, n = 30) => (s.length > n ? `${s.slice(0, n)}…` : s);
const md = (s: string) => raw(markdownToHtml(s));
const empty = (text: unknown) => html`<p class="empty">${text}</p>`;

const THINKING = 5;
const RECENT_INSIGHTS = 3;
const RECENT_BOOKS = 6;
const SOURCE = { weread: "微信读书", kindle: "Kindle", local: "本地" } as const;
const MODE_HINT = {
  argument: "思辨：追问论证与反方，回访时问现在怎么看",
  practice: "实践：追问能用在哪件事上，回访时问试了没有",
  knowledge: "知识：请你用自己的话讲一遍，回访时问还讲不讲得出",
  narrative: "叙事：聊感受和人物，没读完时不剧透",
} as const;

const prompt = {
  revisit: (q: Question) => `用书畔回访这个问题（${refOf("question", q.id)}）：「${q.title}」`,
  question: (q: Question) => `用书畔接着想这个问题（${refOf("question", q.id)}）：「${q.title}」`,
  link: (l: Link) => `用书畔看看这条关联提议（${refOf("link", l.id)}）`,
  probe: (id: string, content: string) => `用书畔聊聊这条追问（${refOf("probe", id)}）：「${clip(content)}」`,
  insight: (i: { id: string; content: string }) => `用书畔看看这条观点（${refOf("insight", i.id)}）：「${clip(i.content)}」`,
  book: (b: { id: string; title: string }) => `用书畔陪我读《${b.title}》（${refOf("book", b.id)}）`,
};

function cover(b: { title: string; cover: string | null }) {
  return b.cover
    ? html`<div class="cover"><img src="${b.cover}" alt="" loading="lazy" referrerpolicy="no-referrer"></div>`
    : html`<div class="cover blank"><span>${b.title}</span></div>`;
}

/** 问题一行：标题、状态、你上次说的话。 */
function questionItem(db: Conn, q: Question, p = prompt.question(q)) {
  const last = listMessages(db, q.id).filter((m) => m.speaker === "me").at(-1);
  return html`<li><div class="row"><div>
    <a class="title" href="/questions/${q.id}">${q.title}</a>
    ${last ? html`<p class="said">你上次说：${last.content}</p>` : ""}
    <p class="meta">${QUESTION_STATUS_LABELS[q.status]}${q.nextRevisitAt ? ` · ${day(q.nextRevisitAt)} 之后再聊时会问你` : ""}</p>
  </div>${copyButton(p)}</div></li>`;
}

function insightItem(db: Conn, i: InsightWithSources | (InsightWithSources & { sources: [] })) {
  const from = i.sources.map((s) =>
    s.questionId
      ? html`<a href="/questions/${s.questionId}">${describeRef(db, { type: "question", id: s.questionId }, 40)}</a>`
      : s.highlightId
        ? html`${describeRef(db, { type: "highlight", id: s.highlightId }, 40)}`
        : html`<a href="/books/${s.bookId}">${describeRef(db, { type: "book", id: s.bookId! }, 40)}</a>`,
  );
  return html`<li><div class="row"><div>
    <p class="insight">${i.content}</p>
    <p class="meta"><span class="tag ${i.authorship === "mine" ? "mine" : "ai"}">${i.authorship === "mine" ? "我写的" : "AI 协助"}</span> ${day(i.createdAt)}${from.length ? html` · 来自 ${from.map((f, n) => html`${n ? "；" : ""}${f}`)}` : ""}</p>
  </div>${copyButton(prompt.insight(i))}</div></li>`;
}

function linkItem(db: Conn, l: Link) {
  return html`<li><div class="row"><div>
    <span class="tag link">${LINK_KIND_LABELS[l.kind]}</span> ${describeRef(db, { type: l.fromType, id: l.fromId }, 60)}
    <p class="meta">→ ${describeRef(db, { type: l.toType, id: l.toId }, 60)}</p>
    ${l.reason ? html`<p class="said">${l.reason}</p>` : ""}
  </div>${l.state === "proposed" ? copyButton(prompt.link(l)) : ""}</div></li>`;
}

/** 首页「下次聊书，可以从这里开始」：和智能体开场时提的是同一件。 */
function nextCard(db: Conn, s: Suggestion) {
  const [kind, what, why, p] =
    s.kind === "link"
      ? ["有一条新的关联", `${describeRef(db, { type: s.link.fromType, id: s.link.fromId }, 50)}，可能${LINK_KIND_LABELS[s.link.kind]}了「${describeRef(db, { type: s.link.toType, id: s.link.toId }, 40)}」`, s.link.reason, prompt.link(s.link)]
      : s.kind === "revisit"
        ? ["有个问题可以再想想了", s.question.title, (() => { const m = listMessages(db, s.question.id).filter((x) => x.speaker === "me").at(-1); return m ? `你上次说：${clip(m.content, 60)}` : "你还没回答过它。"; })(), prompt.revisit(s.question)]
        : ["有一条追问在等你", s.probe.content, (() => { const t = describeProbeTarget(db, s.probe); return t.quote ? `《${t.bookTitle}》：${clip(t.quote, 50)}` : `《${t.bookTitle}》`; })(), prompt.probe(s.probe.id, s.probe.content)];
  return html`<div class="card next"><div>
    <p class="label">下次聊书，可以从这里开始 · ${kind}</p>
    <p class="what">${what}</p>
    ${why ? html`<p class="why">${why}</p>` : ""}
  </div>${copyButton(p, { primary: true })}</div>`;
}

function onboarding() {
  return html`<div class="card">
    <p class="label">还没有书</p>
    <p>书畔会把你的划线交给智能体，陪你读书、记住你的问题。三步开始：</p>
    <ol class="steps">
      <li><span class="t">接上数据</span><span class="meta">在终端运行 <code>bookside init</code>，选微信读书、Kindle，或先用示例书鲁迅《呐喊》。</span></li>
      <li><span class="t">打开智能体</span><span class="meta">Claude Code、Codex 都可以；<code>init</code> 已经把书畔的 skill 装好了。</span></li>
      <li><span class="t">说一句</span><span class="meta">「用书畔陪我读书」。聊过的东西会出现在这里。</span></li>
    </ol>
  </div>`;
}

function bookCard(b: BookSummary) {
  return html`<a href="/books/${b.id}">${cover(b)}<p class="bt">${b.title}</p><p class="ba">${b.author ?? ""}</p></a>`;
}

export function createViewer(db: Db): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const books = listBooks(db);
    const all = listBooks(db, { includeEmpty: true });
    const questions = listQuestions(db);
    const insights = listInsights(db);
    const highlightCount = all.reduce((n, b) => n + b.highlightCount, 0);
    const first = nextUp(db).items[0];
    // 上面那张卡片已经提了的问题，列表里不再重复。
    const featured = first?.kind === "revisit" ? first.question.id : undefined;
    const thinking = questions
      .filter((q) => q.id !== featured && (q.status === "exploring" || q.status === "tentative" || q.status === "unexplored"))
      .slice(0, THINKING);
    const body = html`
      <div class="hero">
        <h1>你的读书记忆</h1>
        <p class="sub">${all.length} 本书 · ${highlightCount} 条划线 · ${questions.length} 个问题 · ${insights.length} 条观点</p>
      </div>
      ${all.length === 0 ? onboarding() : first ? nextCard(db, first) : ""}
      ${all.length
        ? html`<div class="bento">
            <section class="card">
              <p class="label">正在想的问题</p>
              ${thinking.length ? html`<ul class="list">${thinking.map((q) => questionItem(db, q))}</ul>` : empty("还没有问题。和智能体聊到想继续想的地方，说「记成问题」就行。")}
              ${questions.length > thinking.length ? html`<p class="meta" style="margin-top:1rem"><a href="/questions">全部 ${questions.length} 个问题</a></p>` : ""}
            </section>
            <section class="card">
              <p class="label">最近的观点</p>
              ${insights.length ? html`<ul class="list">${insights.slice(0, RECENT_INSIGHTS).map((i) => insightItem(db, i))}</ul>` : empty("读完一本书，可以对智能体说「帮我把这本书整理成观点」。")}
              ${insights.length > RECENT_INSIGHTS ? html`<p class="meta" style="margin-top:1rem"><a href="/insights">全部 ${insights.length} 条观点</a></p>` : ""}
            </section>
            ${books.length
              ? html`<section class="card wide">
                  <p class="label">最近在读</p>
                  <div class="shelf">${books.slice(0, RECENT_BOOKS).map(bookCard)}</div>
                </section>`
              : ""}
          </div>`
        : ""}`;
    return c.html(page({ title: "首页", section: "home", body }));
  });

  app.get("/questions", (c) => {
    const all = listQuestions(db);
    const order = ["exploring", "unexplored", "tentative", "resolved", "abandoned"] as const;
    const body = html`
      <div class="page-head"><div><h1>问题</h1><p class="sub">你决定继续想下去的 ${all.length} 个问题。到期的那些，下次聊书时智能体会挑一个问你。</p></div></div>
      ${all.length ? "" : empty("还没有问题。和智能体聊到想继续想的地方，说「记成问题」就行。")}
      ${order.map((s) => {
        const group = all.filter((q) => q.status === s);
        return group.length ? html`<section class="block"><h3>${QUESTION_STATUS_LABELS[s]}</h3><ul class="list card">${group.map((q) => questionItem(db, q))}</ul></section>` : "";
      })}`;
    return c.html(page({ title: "问题", section: "questions", body }));
  });

  app.get("/questions/:id", (c) => {
    const d = getQuestionDetail(db, c.req.param("id"));
    const q = d.question;
    const origin = d.origin
      ? d.origin.type === "highlight"
        ? html`<a href="/books/${d.origin.bookId}">《${d.origin.bookTitle}》</a><p class="quote" style="margin-top:.5rem">${d.origin.quote}</p>`
        : html`<a href="/books/${d.origin.bookId}">《${d.origin.bookTitle}》</a>${d.origin.type === "chapter" ? ` ${d.origin.chapterTitle}` : ""}`
      : html`<span class="meta">长期问题，不属于哪本书</span>`;
    const body = html`
      <div class="page-head"><div>
        <h1>${q.title}</h1>
        <p class="sub"><span class="tag">${QUESTION_STATUS_LABELS[q.status]}</span> 创建于 ${day(q.createdAt)}${q.nextRevisitAt ? ` · ${day(q.nextRevisitAt)} 之后再聊时会问你` : ""}</p>
      </div>${copyButton(prompt.question(q), { primary: true })}</div>
      <section class="card"><p class="label">起源</p>${origin}</section>
      <section class="block"><h2>线程</h2>
        ${d.messages.length ? "" : empty("还没有发言。点「接着聊」，把你现在的想法告诉智能体。")}
        ${d.messages.map(
          (m) => html`<div class="msg ${m.speaker}"><div class="who">${m.speaker === "me" ? "我" : "AI"} · ${day(m.createdAt)}</div>
            <div class="body">${md(m.content)}</div>${m.cited.map((h) => html`<p class="quote">${h.text}</p>`)}</div>`,
        )}
      </section>
      ${d.insights.length ? html`<section class="block"><h2>观点</h2><ul class="list card">${d.insights.map((i) => insightItem(db, { ...i, createdAt: i.versions[0]!.createdAt, sources: [] }))}</ul></section>` : ""}
      ${d.links.length ? html`<section class="block"><h2>关联</h2><ul class="list card">${d.links.map((l) => linkItem(db, l))}</ul></section>` : ""}
      ${d.proposals.length ? html`<section class="block"><h2>等你确认的关联</h2><ul class="list card">${d.proposals.map((l) => linkItem(db, l))}</ul></section>` : ""}`;
    return c.html(page({ title: q.title, section: "questions", body }));
  });

  app.get("/books", (c) => {
    const all = c.req.query("all") === "1";
    const list = listBooks(db, { includeEmpty: all });
    const hidden = all ? 0 : listBooks(db, { includeEmpty: true }).length - list.length;
    const body = html`
      <div class="page-head"><div><h1>书架</h1>
        <p class="sub">${list.length} 本有划线、问题或读前目的的书${hidden ? html` · <a href="/books?all=1">另有 ${hidden} 本还空着</a>` : ""}</p></div></div>
      ${list.length ? html`<div class="shelf">${list.map(bookCard)}</div>` : onboarding()}`;
    return c.html(page({ title: "书架", section: "books", body }));
  });

  app.get("/books/:id", (c) => {
    const d = getBookDetail(db, c.req.param("id"));
    const b = d.book;
    const mode = readingModeOf(b);
    const guides = listGuides(db, b.id);
    const insights = insightsOfBook(db, b.id);
    const reviews = reviewsOf(db, b.id, null);
    // 追问挂在划线或想法上的，放到那条划线下面；挂在书或章节上的单独列出。
    const noteToHighlight = new Map(d.chapters.flatMap((ch) => ch.highlights.flatMap((h) => h.notes.map((n) => [n.id, h.id] as const))));
    const probesOf = new Map<string, { id: string; content: string }[]>();
    const loose: { id: string; content: string }[] = [];
    for (const p of pendingProbes(db, { bookId: b.id })) {
      const h = p.highlightId ?? (p.noteId ? noteToHighlight.get(p.noteId) : undefined);
      if (h) probesOf.set(h, [...(probesOf.get(h) ?? []), p]);
      else loose.push(p);
    }
    const highlightTotal = d.chapters.reduce((n, ch) => n + ch.highlights.length, 0);
    const body = html`
      <div class="book-head">
        ${cover(b)}
        <div>
          <div class="row"><h1>《${b.title}》</h1>${copyButton(prompt.book(b), { primary: true })}</div>
          <p class="sub">${[b.author, SOURCE[b.source], b.finishedAt ? `读完于 ${day(b.finishedAt)}` : ""].filter(Boolean).join(" · ")}</p>
          <p class="sub"><span class="tag mode" title="${MODE_HINT[mode.mode]}">读法 · ${mode.label}</span> <span class="meta">${MODE_HINT[mode.mode].split("：")[1]}</span></p>
          ${b.progress !== null ? html`<div class="progress" title="进度 ${b.progress}%"><i style="width:${b.progress}%"></i></div><p class="meta">读到 ${b.progress}%</p>` : ""}
        </div>
      </div>
      <nav class="toc">${[
        guides.length ? html`<a href="#guide">导读</a>` : "",
        d.questions.length ? html`<a href="#questions">问题 ${d.questions.length}</a>` : "",
        insights.length ? html`<a href="#insights">观点 ${insights.length}</a>` : "",
        html`<a href="#highlights">划线 ${highlightTotal}</a>`,
      ]}</nav>
      ${b.purpose ? html`<section class="block"><p class="label">读前目的</p><p class="insight">${b.purpose}</p></section>` : ""}
      ${reviews.map((r) => html`<section class="block"><p class="label">我的书评 · ${day(r.writtenAt)}</p><div class="body">${md(r.content)}</div></section>`)}
      <section class="block" id="guide"><h2>AI 导读</h2>
        ${guides.length
          ? guides.map(
              (g) => html`<details class="guide"${g.depth === "quick" && !g.chapterTitle ? raw(" open") : ""}><summary><span>${g.chapterTitle ? `章节导读：${g.chapterTitle}` : g.depth === "quick" ? "速览" : "全书导读"} <span class="meta">${day(g.createdAt)}</span></span></summary>
                <div class="inner"><p class="ai-note">AI 写的讲解，不是你的笔记。${g.basis === "limited" ? "依据有限：只根据给出的材料（目录、简介、热门划线或你的划线）。" : ""}</p><div class="body">${md(g.content)}</div></div></details>`,
            )
          : html`<div class="card row"><p class="empty">还没有导读。想先了解这本书讲什么，可以请智能体写一份。</p>${copyButton(`用书畔给《${b.title}》写一份导读（${refOf("book", b.id)}）`, { label: "请它写" })}</div>`}
      </section>
      ${loose.length ? html`<section class="block"><h2>带着读的追问</h2><ul class="list card">${loose.map((p) => html`<li><div class="row"><p class="title">${p.content}</p>${copyButton(prompt.probe(p.id, p.content))}</div></li>`)}</ul></section>` : ""}
      ${d.questions.length ? html`<section class="block" id="questions"><h2>问题</h2><ul class="list card">${d.questions.map((q) => questionItem(db, q))}</ul></section>` : ""}
      ${insights.length ? html`<section class="block" id="insights"><h2>观点</h2><ul class="list card">${insights.map((i) => insightItem(db, i))}</ul></section>` : ""}
      <section class="block" id="highlights"><h2>划线与想法</h2>
        ${d.chapters.length ? "" : empty("还没有划线。")}
        ${d.chapters.map(
          (ch) => html`<h3>${ch.title || "未分章"}</h3><ul class="list card">${ch.highlights.map(
            (h) => html`<li><div class="row"><div>
              <p class="quote">${h.text}</p>
              ${h.notes.map((n) => html`<p class="note">想法 · ${n.content}</p>`)}
              ${(probesOf.get(h.id) ?? []).map((p) => html`<div class="probe row"><p><span class="k">追问</span>${p.content}</p>${copyButton(prompt.probe(p.id, p.content), { label: "回答" })}</div>`)}
              <p class="meta">${day(h.markedAt)}${h.kind === "from_note" ? " · 由想法带出" : ""}</p>
            </div>${copyButton(`用书畔聊聊《${b.title}》里这条划线（${refOf("highlight", h.id)}）：「${clip(h.text)}」`)}</div></li>`,
          )}</ul>`,
        )}
      </section>`;
    return c.html(page({ title: b.title, section: "books", body }));
  });

  app.get("/insights", (c) => {
    const list = listInsights(db);
    const body = html`<div class="page-head"><div><h1>观点</h1><p class="sub">${list.length} 条，从你的划线、问题和书里沉淀下来的看法</p></div></div>
      ${list.length ? html`<ul class="list card">${list.map((i) => insightItem(db, i))}</ul>` : empty("还没有观点。读完一本书，可以对智能体说「帮我把这本书整理成观点」。")}`;
    return c.html(page({ title: "观点", section: "insights", body }));
  });

  app.get("/search", (c) => {
    const q = (c.req.query("q") ?? "").trim();
    const hits = q ? searchAll(db, q) : [];
    const label = { book: "书", highlight: "划线", note: "想法", question: "问题", insight: "观点" } as const;
    const hrefOf = (h: (typeof hits)[number]) =>
      h.kind === "book" ? `/books/${h.id}` : h.kind === "question" ? `/questions/${h.id}` : h.questionId ? `/questions/${h.questionId}` : h.bookId ? `/books/${h.bookId}` : "/insights";
    const body = html`<div class="page-head"><div><h1>搜索</h1><p class="sub">${q ? `「${q}」：${hits.length} 条` : "在书、划线、想法、问题和观点里一起搜"}</p></div></div>
      ${hits.length ? html`<ul class="list card">${hits.map(
        (h) => html`<li><span class="tag">${label[h.kind]}</span> <a class="title" href="${hrefOf(h)}">${h.title}</a>
          ${h.snippet ? html`<p class="said">${h.snippet}</p>` : ""}${h.bookTitle && h.kind !== "book" ? html`<p class="meta">《${h.bookTitle}》</p>` : ""}</li>`,
      )}</ul>` : q ? empty("没有找到。换个词试试。") : ""}`;
    return c.html(page({ title: "搜索", section: "search", body, query: q }));
  });

  app.onError((e, c) => {
    if (e instanceof DomainError && e.code === "not_found") {
      return c.html(page({ title: "找不到", section: "home", body: html`<div class="page-head"><h1>找不到</h1></div>${empty(e.message)}` }), 404);
    }
    throw e;
  });
  app.notFound((c) => c.html(page({ title: "找不到", section: "home", body: html`<div class="page-head"><h1>找不到这一页</h1></div>` }), 404));
  return app;
}

/** 启动查看器；端口被占用时依次试后面几个。 */
export async function startViewer(db: Db, opts: { hostname: string; port: number }): Promise<{ port: number; close: () => void }> {
  const app = createViewer(db);
  for (let port = opts.port; port < opts.port + 10; port++) {
    try {
      const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
        const s = serve({ fetch: app.fetch, hostname: opts.hostname, port }, () => resolve(s));
        s.once("error", reject);
      });
      return { port: (server.address() as AddressInfo).port, close: () => server.close() };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    }
  }
  throw new Error(`端口 ${opts.port}–${opts.port + 9} 都被占用了，用 --port 换一个`);
}
