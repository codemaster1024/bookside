// 只读查看器：在浏览器里看见自己的问题、观点和划线。每条旁边可以「接着聊」，把一句话贴给智能体；这里不写入任何东西。
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { renderSVG } from "uqr";
import { serve } from "@hono/node-server";
import {
  type BookSummary,
  type BookWeight,
  type Conn,
  type DailyQuote,
  type Overview,
  type Portrait,
  type YearHeat,
  type Db,
  type InsightWithSources,
  type Link,
  type Question,
  type Suggestion,
  DomainError,
  LINK_KIND_LABELS,
  QUESTION_STATUSES,
  QUESTION_STATUS_LABELS,
  READING_MODES,
  READING_MODE_LABELS,
  describeProbeTarget,
  describeRef,
  getBookDetail,
  getQuestionDetail,
  insightsOfBook,
  latestPortrait,
  listPortraits,
  listBooks,
  listGuides,
  listInsights,
  listMessages,
  listQuestions,
  modeDistribution,
  nextUp,
  overview,
  PORTRAIT_MIN_HIGHLIGHTS,
  pendingProbes,
  preference,
  quoteOfTheDay,
  readingModeOf,
  refOf,
  reviewsOf,
  sampleBookId,
  searchAll,
  statusChanges,
  topBooks,
  yearHeat,
} from "@bookside/core";
import { Hono } from "hono";
import { html, raw } from "hono/html";
import { type Intent, chatMenu, page as layoutPage } from "./layout.ts";
import { markdownToHtml } from "./markdown.ts";

const pad = (n: number) => String(n).padStart(2, "0");
const day = (d: Date | null | undefined) => (d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : "—");
const clip = (s: string, n = 30) => (s.length > n ? `${s.slice(0, n)}…` : s);
const md = (s: string) => raw(markdownToHtml(s));
const empty = (text: unknown) => html`<p class="empty">${text}</p>`;

const THINKING = 5;
const RECENT_INSIGHTS = 3;
const TOP_BOOKS = 6;
const SOURCE = { weread: "微信读书", kindle: "Kindle", local: "本地" } as const;
const MODE_HINT = {
  argument: "思辨：追问论证与反方，回访时问现在怎么看",
  practice: "实践：追问能用在哪件事上，回访时问试了没有",
  knowledge: "知识：请你用自己的话讲一遍，回访时问还讲不讲得出",
  narrative: "叙事：聊感受和人物，没读完时不剧透",
} as const;

/**
 * 「接着聊」的几种意图：复制出去的是用户对智能体说的话，第一人称，引用放在末尾的括号里。
 * 以冒号结尾的，先在网页上写完后半句。
 */
const intents = {
  highlight: (book: string, h: { id: string; text: string }): Intent[] => {
    const at = `《${book}》里这句「${clip(h.text)}」（${refOf("highlight", h.id)}）`;
    return [
      { label: "说说我的看法", prompt: `用书畔：${at}，我想说说我的看法：`, input: true, placeholder: "你同意吗？想到了什么？" },
      { label: "没读懂，讲讲", prompt: `用书畔：${at}我没太读懂，帮我讲讲` },
      { label: "记成问题", prompt: `用书畔：把${at}引出的问题记下来，我想问的是：`, input: true, placeholder: "你想继续想下去的问题" },
    ];
  },
  question: (q: Question): Intent[] => {
    const at = `「${q.title}」（${refOf("question", q.id)}）`;
    return [
      { label: "说说我现在的想法", prompt: `用书畔：关于${at}，我现在的想法是：`, input: true, placeholder: "和上次比，有什么变化？" },
      { label: "在旧划线里找找", prompt: `用书畔：在我以前的划线里找找能回应${at}的段落` },
      { label: "先别问了", prompt: `用书畔：${at}这个问题先别问我了` },
    ];
  },
  probe: (p: { id: string; content: string }): Intent[] => {
    const at = `「${clip(p.content)}」（${refOf("probe", p.id)}）`;
    return [
      { label: "回答", prompt: `用书畔：回答这条追问${at}：`, input: true },
      { label: "先放下", prompt: `用书畔：这条追问${at}先放下吧` },
    ];
  },
  insight: (i: { id: string; content: string }): Intent[] => [
    { label: "再推敲一下", prompt: `用书畔：我之前的观点「${clip(i.content)}」（${refOf("insight", i.id)}），想再推敲一下：`, input: true, placeholder: "哪里想改？有什么新的经历？" },
  ],
  link: (db: Conn, l: Link): Intent[] => [
    {
      label: "看看对不对",
      prompt: `用书畔：看看「${describeRef(db, { type: l.fromType, id: l.fromId }, 30)}」是不是真的回应了「${describeRef(db, { type: l.toType, id: l.toId }, 30)}」（${refOf("link", l.id)}）`,
    },
  ],
  book: (b: { id: string; title: string }): Intent[] => {
    const at = `《${b.title}》（${refOf("book", b.id)}）`;
    return [
      { label: "陪我读", prompt: `用书畔陪我读${at}` },
      { label: "一分钟讲讲", prompt: `用书畔一分钟讲讲${at}` },
      { label: "我划了些什么", prompt: `用书畔：我在${at}里都划了些什么？` },
      { label: "考考我", prompt: `用书畔考考我${at}` },
      { label: "用我的话写读后感", prompt: `用书畔：用我自己写下的想法，帮我起草一篇${at}的读后感，打算发在：`, input: true, placeholder: "豆瓣、公众号、朋友圈……不写也行" },
    ];
  },
};

/** 没有封面的书按书名取一种底色，同一本书每次一样。 */
const hue = (title: string) => ([...title].reduce((n, ch) => n + ch.codePointAt(0)!, 0) % 6) + 1;

function cover(b: { title: string; cover: string | null; author?: string | null }) {
  return b.cover
    ? html`<div class="cover"><img src="${b.cover}" alt="" loading="lazy" referrerpolicy="no-referrer"></div>`
    : html`<div class="cover blank c${hue(b.title)}"><span>${clip(b.title, 12)}</span>${b.author ? html`<small>${clip(b.author, 8)}</small>` : ""}</div>`;
}

/** 问题一行：标题、状态、你上次说的话。 */
function questionItem(db: Conn, q: Question) {
  const last = listMessages(db, q.id).filter((m) => m.speaker === "me").at(-1);
  return html`<li><div class="row"><div>
    <a class="title" href="/questions/${q.id}">${q.title}</a>
    ${last ? html`<p class="said">你上次说：${last.content}</p>` : ""}
    <p class="meta">${QUESTION_STATUS_LABELS[q.status]}${q.nextRevisitAt ? ` · ${day(q.nextRevisitAt)} 之后再聊时会问你` : ""}</p>
  </div>${chatMenu(intents.question(q))}</div></li>`;
}

function insightItem(db: Conn, i: InsightWithSources | (InsightWithSources & { sources: [] })) {
  const from = i.sources.map((s) =>
    s.questionId
      ? html`<a href="/questions/${s.questionId}">${describeRef(db, { type: "question", id: s.questionId }, 40)}</a>`
      : s.highlightId
        ? html`${describeRef(db, { type: "highlight", id: s.highlightId }, 40)}`
        : html`<a href="/books/${s.bookId}">${describeRef(db, { type: "book", id: s.bookId! }, 40)}</a>`,
  );
  const older = i.versions.slice(0, -1).reverse();
  return html`<li><div class="row"><div>
    <p class="insight">${i.content}</p>
    <p class="meta"><span class="tag ${i.authorship === "mine" ? "mine" : "ai"}">${i.authorship === "mine" ? "我写的" : "AI 协助"}</span> ${day(i.createdAt)}${from.length ? html` · 来自 ${from.map((f, n) => html`${n ? "；" : ""}${f}`)}` : ""}</p>
    ${older.length
      ? html`<details class="versions"><summary>改过 ${older.length} 次，看以前的说法</summary><ol>${older.map(
          (v) => html`<li><span class="meta">${day(v.createdAt)} · ${v.author === "me" ? "你写的" : "AI 起草"}${v.rewrite ? " · 推倒重写" : ""}</span><p>${v.content}</p></li>`,
        )}</ol></details>`
      : ""}
  </div>${chatMenu(intents.insight(i))}</div></li>`;
}

function linkItem(db: Conn, l: Link) {
  return html`<li><div class="row"><div>
    <span class="tag link">${LINK_KIND_LABELS[l.kind]}</span> ${describeRef(db, { type: l.fromType, id: l.fromId }, 60)}
    <p class="meta">→ ${describeRef(db, { type: l.toType, id: l.toId }, 60)}</p>
    ${l.reason ? html`<p class="said">${l.reason}</p>` : ""}
  </div>${l.state === "proposed" ? chatMenu(intents.link(db, l)) : ""}</div></li>`;
}

/** 这个问题走过的路：提出、你每次说的话、状态的每次改动。只有一步时不显示。 */
function pathOf(db: Conn, q: Question, messages: { speaker: string; content: string; createdAt: Date }[]) {
  const steps = [
    { at: q.createdAt, kind: "start", text: html`提出这个问题` },
    ...messages.filter((m) => m.speaker === "me").map((m) => ({ at: m.createdAt, kind: "said", text: html`你说：${clip(m.content, 40)}` })),
    // 第一次开口时问题自动进入「探讨中」，那一步和「你说」重复，不单列。
    ...statusChanges(db, q.id).filter((c) => !(c.from === "unexplored" && c.to === "exploring")).map((c) => ({ at: c.createdAt, kind: c.to, text: html`${QUESTION_STATUS_LABELS[c.from]} → <b>${QUESTION_STATUS_LABELS[c.to]}</b>` })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  if (steps.length < 2) return "";
  return html`<section class="card path"><p class="label">走过的路</p><ol>${steps.map((s) => html`<li class="${s.kind}"><span class="d">${day(s.at)}</span><span>${s.text}</span></li>`)}</ol></section>`;
}

/** 首页「下次聊书，可以从这里开始」：和智能体开场时提的是同一件。 */
function nextCard(db: Conn, s: Suggestion) {
  const [kind, what, why, choices] =
    s.kind === "link"
      ? ["有一条新的关联", `${describeRef(db, { type: s.link.fromType, id: s.link.fromId }, 50)}，可能${LINK_KIND_LABELS[s.link.kind]}了「${describeRef(db, { type: s.link.toType, id: s.link.toId }, 40)}」`, s.link.reason, intents.link(db, s.link)]
      : s.kind === "revisit"
        ? ["有个问题可以再想想了", s.question.title, (() => { const m = listMessages(db, s.question.id).filter((x) => x.speaker === "me").at(-1); return m ? `你上次说：${clip(m.content, 60)}` : "你还没回答过它。"; })(), intents.question(s.question)]
        : ["有一条追问在等你", s.probe.content, (() => { const t = describeProbeTarget(db, s.probe); return t.quote ? `《${t.bookTitle}》：${clip(t.quote, 50)}` : `《${t.bookTitle}》`; })(), intents.probe(s.probe)];
  return html`<div class="card next"><div>
    <p class="label">下次聊书，可以从这里开始 · ${kind}</p>
    <p class="what">${what}</p>
    ${why ? html`<p class="why">${why}</p>` : ""}
  </div>${chatMenu(choices, { primary: true })}</div>`;
}

/** 书架上只有示例书时，告诉用户怎么换成自己的书。 */
function sampleNotice() {
  return html`<div class="card notice">
    <p class="label">现在看到的是示例书</p>
    <p>接上你自己的书：在终端运行 <code>bookside init</code>，选微信读书或 Kindle。不要示例书了：<code>bookside sample --remove</code>。</p>
  </div>`;
}

const md2 = (d: Date) => `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
const num = (n: number) => n.toLocaleString("en-US");

/** 扉页：一句值得重读的话。有画像时用画像挑的那句和理由；还没有时每天换一句旧划线。 */
function frontis(p: Portrait | undefined, daily: DailyQuote | undefined, total: number, now: Date) {
  const q = p?.reread ?? daily;
  if (!q) return "";
  const hint =
    total < PORTRAIT_MIN_HIGHLIGHTS
      ? `划线攒到 ${PORTRAIT_MIN_HIGHLIGHTS} 条后，智能体会替你挑一句值得重读的话，写下为什么是现在。`
      : "下次和智能体聊书时，它会替你挑一句值得重读的话，写下为什么是现在，以及你的读书画像。";
  return html`<div class="frontis">
    <span class="date">${md2(now)}</span>
    <blockquote${q.text.length > 60 ? raw(' class="long"') : ""}>${q.text}</blockquote>
    <p class="src"><a href="/books/${q.bookId}#h-${q.highlightId}">《${q.bookTitle}》</a> · 你在 ${q.markedAt.getFullYear() === now.getFullYear() ? "" : `${q.markedAt.getFullYear()} 年 `}${md2(q.markedAt)}划下</p>
    <div class="why">
      ${p?.reread ? html`<div><span class="ai-tag">为什么是这一句</span><p>${p.reread.why}</p></div>` : html`<div><p class="hint">${hint}</p></div>`}
      ${chatMenu(intents.highlight(q.bookTitle, { id: q.highlightId, text: q.text }))}
    </div>
  </div>`;
}

/** 那一行数字。 */
function statsRow(o: Overview) {
  const cell = (n: number, k: unknown) => html`<div class="stat"><div class="n">${num(n)}</div><div class="k">${k}</div></div>`;
  return html`<div class="stats">
    ${cell(o.highlights, html`条划线${o.highlightsThisMonth ? html` · 本月 <b>+${o.highlightsThisMonth}</b>` : ""}`)}
    ${cell(o.books, `本书${o.readingNow ? ` · 最近在读 ${o.readingNow} 本` : ""}`)}
    ${cell(o.questions, `个问题${o.resolved ? ` · ${o.resolved} 个想通了` : ""}`)}
    ${cell(o.insights, `条观点${o.mine ? ` · ${o.mine} 条你写的` : ""}`)}
    ${cell(o.streakWeeks, o.streakWeeks ? "周 · 每周都在读" : "周 · 这周还没划线")}
  </div>`;
}

/** 你最近在关心什么：画像里的几个主题，各附你划过的原文。 */
function themesSection(p: Portrait) {
  if (p.themes.length === 0) return "";
  return html`<section>
    <p class="label">你最近在关心什么 <span class="ai-tag">AI 从你的划线里归纳</span></p>
    <div class="themes">${p.themes.map((t, i) => {
      const books = new Set(t.quotes.map((q) => q.bookId)).size;
      return html`<article class="card theme">
        <span class="no">${pad(i + 1)}</span>
        <h3>${t.title}</h3>
        ${t.gist ? html`<p class="gist">${t.gist}</p>` : ""}
        ${t.quotes.map((q) => html`<a class="q" href="/books/${q.bookId}#h-${q.highlightId}"><span>${q.text}</span><cite>《${clip(q.bookTitle, 16)}》${q.chapter ? ` · ${clip(q.chapter, 12)}` : ""}</cite></a>`)}
        <div class="foot"><span>${t.quotes.length} 条划线 · ${books} 本书</span>${chatMenu([
          { label: "说说我的想法", prompt: `用书畔：关于我最近在关心的「${t.title}」，我想说：`, input: true, placeholder: "你怎么看这件事？" },
          { label: "记成问题", prompt: `用书畔：把我最近在关心的「${t.title}」记成一个问题，我想问的是：`, input: true, placeholder: "你想继续想下去的问题" },
        ])}</div>
      </article>`;
    })}</div>
  </section>`;
}

/** 阅读偏好的六个轴：实际读过的分类不够六类时，用这些常见的大类补齐（计 0 条），和微信读书的雷达图一样。 */
const COMMON_CATEGORIES = ["文学", "历史", "心理", "个人成长", "哲学宗教", "经济理财", "社会文化", "科学技术"];
const RADAR_AXES = 6;

/** 阅读偏好：按分类数划线的雷达图；读的种类少时补齐常见大类，图形偏向哪一侧一目了然。 */
function radarCard(read: { label: string; count: number }[]) {
  const top = read[0];
  if (!top) return html`<div class="card radar few"><p class="label">阅读偏好</p><p class="cap">还没有划线。</p></div>`;
  const pad = COMMON_CATEGORIES.filter((c) => !read.some((a) => a.label === c)).map((label) => ({ label, count: 0 }));
  const axes = [...read, ...pad].slice(0, RADAR_AXES);
  const caption =
    read.length === 1
      ? html`你的划线都来自 <b>${top.label}</b>。读的种类多了，图会慢慢撑开`
      : read.length === 2
        ? html`你的划线大多来自 <b>${top.label}</b>，其次是 <b>${read[1]!.label}</b>`
        : html`你最常读 <b>${top.label}</b>，其次是 <b>${read[1]!.label}</b> 和 <b>${read[2]!.label}</b>`;
  const R = 88;
  const max = top.count;
  const pt = (i: number, r: number) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / axes.length;
    return [Math.cos(a) * r, Math.sin(a) * r] as const;
  };
  const poly = (r: (i: number) => number) => axes.map((_, i) => pt(i, r(i)).map((v) => v.toFixed(1)).join(",")).join(" ");
  const vals = axes.map((a, i) => pt(i, R * (0.12 + (0.88 * a.count) / max)));
  return html`<div class="card radar">
    <p class="label">阅读偏好 <span class="aside">按划线数</span></p>
    <svg viewBox="-150 -120 300 244" role="img" aria-label="${axes.map((a) => `${a.label} ${a.count} 条`).join("，")}">
      ${[0.25, 0.5, 0.75, 1].map((f) => html`<polygon class="ring" points="${poly(() => R * f)}"/>`)}
      ${axes.map((_, i) => { const [x, y] = pt(i, R); return html`<line class="spoke" x1="0" y1="0" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`; })}
      <polygon class="area" points="${vals.map((v) => v.map((n) => n.toFixed(1)).join(",")).join(" ")}"/>
      ${vals.map(([x, y], i) => (axes[i]!.count ? html`<circle class="dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3"><title>${axes[i]!.label}：${axes[i]!.count} 条</title></circle>` : ""))}
      ${axes.map((a, i) => {
        const [x, y] = pt(i, R + 18);
        const anchor = Math.abs(x) < 4 ? "middle" : x > 0 ? "start" : "end";
        return html`<text class="ax${a.count ? "" : " none"}" x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="${anchor}">${a.label}</text>`;
      })}
    </svg>
    <p class="cap">${caption}</p>
  </div>`;
}

/** 你的读书画像与下一步；还没有时说明它怎么来。 */
function essayCard(db: Conn, p: Portrait | undefined, total: number, history: number) {
  if (!p) {
    const ready = total >= PORTRAIT_MIN_HIGHLIGHTS;
    return html`<div class="card essay pending">
      <p class="label">你的读书画像</p>
      <p class="hint">${ready
        ? "智能体会读一遍你的划线，写下你最近在关心什么、一句值得重读的话，以及下一步可以做什么。下次和它聊书时会自动写好，也可以现在就请它写。"
        : `划线攒到 ${PORTRAIT_MIN_HIGHLIGHTS} 条后（现在 ${total} 条），智能体会读一遍你的划线，写下你最近在关心什么、一句值得重读的话，以及下一步可以做什么。`}</p>
      ${ready ? html`<div class="actions">${chatMenu([{ label: "请它写", prompt: "用书畔给我写一份读书画像" }], { label: "请它写" })}</div>` : ""}
    </div>`;
  }
  const q = p.next.questionId ? listQuestions(db).find((x) => x.id === p.next.questionId) : undefined;
  return html`<div class="card essay">
    <p class="label">你的读书画像 <span class="ai-tag">AI 写于 ${md2(p.createdAt)}</span>${history > 1 ? html`<a class="aside" href="/portraits">以前的画像 ${history - 1} 份</a>` : ""}</p>
    ${p.change ? html`<p class="change"><span>这段时间的变化</span>${p.change}</p>` : ""}
    ${p.essay.split(/\n\s*\n/).map((para) => html`<p>${para.trim()}</p>`)}
    <div class="nextstep">
      <div><div class="k">下一步可以</div><div class="v">${p.next.text}</div>
        ${q ? html`<div class="m">问题：<a href="/questions/${q.id}">${q.title}</a></div>` : ""}</div>
      ${q ? chatMenu(intents.question(q), { primary: true }) : chatMenu([{ label: "接着聊", prompt: `用书畔：画像里说我下一步可以「${p.next.text}」，我们开始吧` }], { primary: true })}
    </div>
  </div>`;
}

/** 这一年的划线：日历热力图，一列一周。 */
function heatCard(h: YearHeat) {
  const max = Math.max(...h.days.map((d) => d.count), 1);
  const level = (n: number) => (n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4)));
  const weeks = Math.ceil(h.days.length / 7);
  const months = h.days.flatMap((d, i) => (d.date.getDate() === 1 ? [{ col: Math.floor(i / 7) + 1, m: d.date.getMonth() + 1 }] : []));
  const total = h.days.reduce((n, d) => n + d.count, 0);
  const first = h.days[0]!.date;
  return html`<section>
    <p class="label">这一年的划线 <span class="aside">${first.getFullYear()} 年 ${first.getMonth() + 1} 月至今 · ${num(total)} 条</span></p>
    <div class="card heat">
      <div class="heat-scroll" style="--weeks:${weeks}">
        <div class="months">${months.map((m) => html`<span style="grid-column:${m.col} / span 3">${m.m} 月</span>`)}</div>
        <div class="days">${h.days.map((d) => html`<i class="l${level(d.count)}" title="${md2(d.date)}：${d.count} 条"></i>`)}</div>
      </div>
      <div class="heat-foot">
        <span>${h.peak ? html`划线最多的一天是 <b>${md2(h.peak.date)}</b>，你读《${h.peak.bookTitle}》划了 ${h.peak.count} 条` : "这一年还没有划线。"}</span>
        <span class="scale">少 <i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i> 多</span>
      </div>
    </div>
  </section>`;
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
  return html`<a href="/books/${b.id}" title="${b.title}">${cover(b)}<p class="bt">${b.title}</p><p class="ba">${b.author ?? ""}</p></a>`;
}

/** 你最常回到的书：附上它留给你的东西。 */
function weightCard(b: BookWeight) {
  const bits = [b.highlightCount && `划线 ${b.highlightCount}`, b.questionCount && `问题 ${b.questionCount}`, b.insightCount && `观点 ${b.insightCount}`].filter(Boolean).join(" · ");
  return html`<a href="/books/${b.id}" title="${b.title}">${cover(b)}<p class="bt">${b.title}</p><p class="ba">${READING_MODE_LABELS[b.mode]}${bits ? ` · ${bits}` : ""}</p></a>`;
}

export function createViewer(db: Db, opts: { phoneUrl?: () => string | undefined } = {}): Hono {
  const app = new Hono();
  // 开放给局域网时，每页页脚多一个「在手机上看」。
  const page = (o: Parameters<typeof layoutPage>[0]) => layoutPage({ ...o, phone: !!opts.phoneUrl?.() });

  app.get("/phone", (c) => {
    const url = opts.phoneUrl?.();
    const body = url
      ? html`<div class="page-head"><div><h1>在手机上看</h1><p class="sub">手机和这台电脑连着同一个 Wi-Fi，用相机或微信扫一扫。</p></div></div>
          <div class="card phone"><div class="qr">${raw(renderSVG(url, { border: 2 }))}</div><p><code>${url}</code></p>
          <p class="meta">同一网络里的人都能打开它、看到你的读书内容（只能看，不能改）。不想开放了，停掉查看器再用 bookside web 打开。</p></div>`
      : html`<div class="page-head"><div><h1>在手机上看</h1><p class="sub">现在只有这台电脑能打开。想在手机上看，停掉查看器，改用 <code>bookside web --host</code> 打开，再回到这一页扫码。</p></div></div>`;
    return c.html(page({ title: "在手机上看", section: "home", body }));
  });

  app.get("/", (c) => {
    const now = new Date();
    const all = listBooks(db, { includeEmpty: true });
    if (all.length === 0) {
      const body = html`<div class="hero"><h1>你的读书记忆</h1><p class="sub">还没有书。</p></div>${onboarding()}`;
      return c.html(page({ title: "首页", section: "home", body }));
    }
    const books = listBooks(db);
    const questions = listQuestions(db);
    const insights = listInsights(db);
    const o = overview(db, now);
    const portrait = latestPortrait(db);
    const first = nextUp(db).items[0];
    // 上面那张卡片已经提了的问题，列表里不再重复。
    const featured = first?.kind === "revisit" ? first.question.id : undefined;
    const thinking = questions
      .filter((q) => q.id !== featured && (q.status === "exploring" || q.status === "tentative" || q.status === "unexplored"))
      .slice(0, THINKING);
    const onlySample = all.length === 1 && sampleBookId(db) === all[0]!.id;
    const modes = modeDistribution(db);
    const body = html`<div class="home">
      ${onlySample ? html`<div class="lead-in">${sampleNotice()}</div>` : ""}
      ${frontis(portrait, portrait?.reread ? undefined : quoteOfTheDay(db, now), o.highlights, now)}
      ${statsRow(o)}
      ${first ? html`<section>${nextCard(db, first)}</section>` : ""}
      ${portrait ? themesSection(portrait) : ""}
      <section class="portrait">${radarCard(preference(db))}${essayCard(db, portrait, o.highlights, listPortraits(db).length)}</section>
      ${heatCard(yearHeat(db, now))}
      <section class="cols">
        <div>
          <p class="label">正在想的问题</p>
          <div class="card">
            ${thinking.length ? html`<ul class="list">${thinking.map((q) => questionItem(db, q))}</ul>` : empty(featured ? "其他问题都还不急，先聊上面那个。" : "还没有问题。和智能体聊到想继续想的地方，说「这个值得记下来」。")}
            ${questions.length > thinking.length ? html`<p class="meta more"><a href="/questions">全部 ${questions.length} 个问题</a></p>` : ""}
          </div>
        </div>
        <div>
          <p class="label">最近的观点</p>
          <div class="card">
            ${insights.length ? html`<ul class="list">${insights.slice(0, RECENT_INSIGHTS).map((i) => insightItem(db, i))}</ul>` : empty("读完一本书，可以对智能体说「帮我把这本书整理成观点」。")}
            ${insights.length > RECENT_INSIGHTS ? html`<p class="meta more"><a href="/insights">全部 ${insights.length} 条观点</a></p>` : ""}
          </div>
        </div>
      </section>
      ${books.length
        ? html`<section>
            <div class="head-row"><p class="label">你最常回到的书 <span class="aside">问题和观点比划线更算数</span></p>
              <p class="meta">${READING_MODES.filter((m) => modes[m]).map((m, n) => `${n ? " · " : ""}${READING_MODE_LABELS[m]} ${modes[m]}`).join("")} 本 · <a href="/books">全部书架</a></p></div>
            <div class="shelf top">${topBooks(db, TOP_BOOKS).map(weightCard)}</div>
          </section>`
        : ""}
      ${portrait ? html`<p class="colophon">画像和主题由${portrait.model ? `智能体（${portrait.model}）` : "你的智能体"}根据 ${num(portrait.highlightCount)} 条划线写成，引用的每一句都是你划过的原文。新划线攒够了，下次聊书时会自动更新。</p>` : ""}
    </div>`;
    return c.html(page({ title: "首页", section: "home", body }));
  });

  app.get("/portraits", (c) => {
    const all = listPortraits(db);
    const body = html`
      <div class="page-head"><div><h1>读书画像</h1><p class="sub">智能体每隔一段时间根据你的划线写一份，新的在前。翻一翻，看看自己这段时间的变化。</p></div></div>
      ${all.length ? "" : empty("还没有读书画像。划线攒到 20 条后，和智能体聊书时它会写第一份。")}
      ${all.map(
        (p, i) => html`<section class="card history">
          <p class="label">${day(p.createdAt)}${i === 0 ? html` <span class="tag mine">最新</span>` : ""} <span class="aside">根据 ${num(p.highlightCount)} 条划线</span></p>
          ${p.change ? html`<p class="change"><span>这段时间的变化</span>${p.change}</p>` : ""}
          <ul class="theme-titles">${p.themes.map((t) => html`<li><b>${t.title}</b>${t.gist ? html`<span>${t.gist}</span>` : ""}</li>`)}</ul>
          ${p.reread ? html`<p class="quote">${p.reread.text}<span class="meta">　《${p.reread.bookTitle}》</span></p>` : ""}
          <details><summary>画像全文</summary>${p.essay.split(/\n\s*\n/).map((para) => html`<p class="insight">${para.trim()}</p>`)}<p class="meta">下一步可以：${p.next.text}</p></details>
        </section>`,
      )}`;
    return c.html(page({ title: "读书画像", section: "home", body }));
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
      </div>${chatMenu(intents.question(q), { primary: true })}</div>
      <section class="card"><p class="label">起源</p>${origin}</section>
      ${pathOf(db, q, d.messages)}
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
          <div class="row"><h1>《${b.title}》</h1>${chatMenu(intents.book(b), { primary: true })}</div>
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
      ${b.purpose && insights.length
        ? html`<section class="block before-after">
            <div><p class="label">读之前，你想要的</p><p class="insight">${b.purpose}</p></div>
            <div><p class="label">读之后，你留下的</p>${insights.slice(0, 3).map((i) => html`<p class="insight">${clip(i.content, 60)}</p>`)}
              <p class="meta"><a href="#insights">${insights.length} 条观点${insights.length > 3 ? "，看全部" : ""}</a></p></div>
          </section>`
        : b.purpose
          ? html`<section class="block"><p class="label">读前目的</p><p class="insight">${b.purpose}</p></section>`
          : ""}
      ${reviews.map((r) => html`<section class="block"><p class="label">我的书评 · ${day(r.writtenAt)}</p><div class="body">${md(r.content)}</div></section>`)}
      <section class="block" id="guide"><h2>AI 导读</h2>
        ${guides.length
          ? guides.map(
              (g) => html`<details class="guide"${g.depth === "quick" && !g.chapterTitle ? raw(" open") : ""}><summary><span>${g.chapterTitle ? `章节导读：${g.chapterTitle}` : g.depth === "quick" ? "速览" : "全书导读"} <span class="meta">${day(g.createdAt)}</span></span></summary>
                <div class="inner"><p class="ai-note">AI 写的讲解，不是你的笔记。${g.basis === "limited" ? "依据有限：只根据给出的材料（目录、简介、热门划线或你的划线）。" : ""}</p><div class="body">${md(g.content)}</div></div></details>`,
            )
          : html`<div class="card row"><p class="empty">还没有导读。想先了解这本书讲什么，可以请智能体写一份。</p>${chatMenu([{ label: "请它写", prompt: `用书畔给《${b.title}》（${refOf("book", b.id)}）写一份详细导读` }], { label: "请它写" })}</div>`}
      </section>
      ${loose.length ? html`<section class="block"><h2>带着读的追问</h2><ul class="list card">${loose.map((p) => html`<li><div class="row"><p class="title">${p.content}</p>${chatMenu(intents.probe(p))}</div></li>`)}</ul></section>` : ""}
      ${d.questions.length ? html`<section class="block" id="questions"><h2>问题</h2><ul class="list card">${d.questions.map((q) => questionItem(db, q))}</ul></section>` : ""}
      ${insights.length ? html`<section class="block" id="insights"><h2>观点</h2><ul class="list card">${insights.map((i) => insightItem(db, i))}</ul></section>` : ""}
      <section class="block" id="highlights"><h2>划线与想法</h2>
        ${d.chapters.length ? "" : empty("还没有划线。")}
        ${d.chapters.map(
          (ch) => html`<h3>${ch.title || "未分章"}</h3><ul class="list card">${ch.highlights.map(
            (h) => html`<li id="h-${h.id}"><div class="row"><div>
              <p class="quote">${h.text}</p>
              ${h.notes.map((n) => html`<p class="note">想法 · ${n.content}</p>`)}
              ${(probesOf.get(h.id) ?? []).map((p) => html`<div class="probe row"><p><span class="k">追问</span>${p.content}</p>${chatMenu(intents.probe(p), { label: "回答" })}</div>`)}
              <p class="meta">${day(h.markedAt)}${h.kind === "from_note" ? " · 由想法带出" : ""}</p>
            </div>${chatMenu(intents.highlight(b.title, h))}</div></li>`,
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

/** 代理软件的虚拟网卡（如 Clash、Surge 的 198.18.0.0/15）：手机连不上，不算局域网地址。 */
const isProxy = (a: string) => /^198\.1[89]\./.test(a);
/** 家里和公司常见的私有网段排在前面。 */
const isPrivate = (a: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);

/** 本机在局域网里的地址，最可能用得上的在前。 */
export function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal && !isProxy(a.address))
    .map((a) => a!.address)
    .sort((x, y) => Number(isPrivate(y)) - Number(isPrivate(x)));
}

/** 启动查看器；端口被占用时依次试后面几个。开放给局域网时返回手机能打开的地址。 */
export async function startViewer(db: Db, opts: { hostname: string; port: number }): Promise<{ port: number; lanUrls: string[]; close: () => void }> {
  const local = opts.hostname === "127.0.0.1" || opts.hostname === "localhost";
  let lanUrls: string[] = [];
  const app = createViewer(db, { phoneUrl: () => lanUrls[0] });
  for (let port = opts.port; port < opts.port + 10; port++) {
    try {
      const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
        const s = serve({ fetch: app.fetch, hostname: opts.hostname, port }, () => resolve(s));
        s.once("error", reject);
      });
      const bound = (server.address() as AddressInfo).port;
      if (!local) lanUrls = (opts.hostname === "0.0.0.0" ? lanAddresses() : [opts.hostname]).map((a) => `http://${a}:${bound}/`);
      return { port: bound, lanUrls, close: () => server.close() };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    }
  }
  throw new Error(`端口 ${opts.port}–${opts.port + 9} 都被占用了，用 --port 换一个`);
}
