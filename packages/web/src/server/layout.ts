// 页面框架：导航、样式与「接着聊」的一小段脚本。查看器只读，所有改动都在智能体里做。
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;
export type Section = "home" | "questions" | "books" | "insights" | "search";

const NAV: { key: Section; href: string; label: string }[] = [
  { key: "home", href: "/", label: "首页" },
  { key: "questions", href: "/questions", label: "问题" },
  { key: "insights", href: "/insights", label: "观点" },
  { key: "books", href: "/books", label: "书架" },
];

const CHAT_ICON = raw(
  '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
);

/** 复制一句话，贴给智能体就能从这里接着聊。primary 用在页面上最主要的那一处。 */
export const copyButton = (prompt: string, opts: { primary?: boolean; label?: string } = {}) =>
  html`<button type="button" class="chat${opts.primary ? " primary" : ""}" data-copy="${prompt}" title="复制这句话，贴给智能体：${prompt}">${CHAT_ICON}<span>${opts.label ?? "接着聊"}</span></button>`;

export function page(opts: { title: string; section: Section; body: Html; query?: string }): Html {
  return html`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title} · 书畔</title>
<style>${raw(CSS)}</style>
</head>
<body>
<div class="shell">
  <header class="topbar">
    <a class="brand" href="/">书畔</a>
    <nav class="nav">${NAV.map((n) => html`<a href="${n.href}"${n.key === opts.section ? raw(' aria-current="page"') : ""}>${n.label}</a>`)}</nav>
    <form class="search" action="/search" role="search"><input name="q" type="search" placeholder="搜索划线、问题、观点" value="${opts.query ?? ""}" aria-label="搜索"></form>
  </header>
  <main>${opts.body}</main>
  <footer class="foot">这里只能看。想聊、想记、想改，点「接着聊」把那句话贴给智能体。</footer>
</div>
<div class="toast" role="status" aria-live="polite"></div>
<script>${raw(SCRIPT)}</script>
</body>
</html>`;
}

const SCRIPT = `
const toast = document.querySelector(".toast");
let timer;
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-copy]");
  if (!b) return;
  const text = b.dataset.copy;
  try { await navigator.clipboard.writeText(text); }
  catch {
    const t = document.createElement("textarea");
    t.value = text; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove();
  }
  b.classList.add("done");
  toast.textContent = "已复制，贴给智能体就能接着聊";
  toast.classList.add("show");
  clearTimeout(timer);
  timer = setTimeout(() => { toast.classList.remove("show"); b.classList.remove("done"); }, 1800);
});`;

const CSS = `
:root {
  --bg: #f7f6f3; --surface: #fff; --sunk: #f1efea; --ink: #2f3437; --strong: #111; --muted: #787774; --faint: #a3a29e;
  --line: #eaeaea; --line-strong: #dcdad5;
  --blue-bg: #e1f3fe; --blue: #1f6c9f; --green-bg: #edf3ec; --green: #346538;
  --yellow-bg: #fbf3db; --yellow: #956400; --red-bg: #fdebec; --red: #9f2f2d;
  --serif: "Songti SC", "Noto Serif SC", "Source Han Serif SC", "Newsreader", Georgia, serif;
  --sans: -apple-system, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Helvetica Neue", "Microsoft YaHei", sans-serif;
  --mono: "SF Mono", "JetBrains Mono", ui-monospace, monospace;
  --ease: cubic-bezier(0.16, 1, 0.3, 1);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #191918; --surface: #202020; --sunk: #262625; --ink: #e3e2df; --strong: #f5f5f4; --muted: #a3a29e; --faint: #7a7975;
    --line: #2e2e2d; --line-strong: #3a3a38;
    --blue-bg: #1c2f3c; --blue: #7cc4f5; --green-bg: #1e2b1f; --green: #8fc493;
    --yellow-bg: #33291a; --yellow: #e0b45a; --red-bg: #3a2020; --red: #f0a09e;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.7 var(--sans); -webkit-font-smoothing: antialiased; overflow-wrap: anywhere; }
a { color: inherit; text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--faint); }
p { margin: 0; }
.shell { max-width: 60rem; margin: 0 auto; padding: 0 1rem 5rem; }

.topbar { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1.75rem; padding: 1.5rem 0 1.25rem; border-bottom: 1px solid var(--line); }
.brand { font: 600 1.3rem/1 var(--serif); letter-spacing: .12em; color: var(--strong); }
.brand:hover { text-decoration: none; }
.nav { display: flex; gap: 1.25rem; color: var(--muted); font-size: 14px; }
.nav a[aria-current] { color: var(--strong); text-decoration: underline; text-underline-offset: 8px; text-decoration-color: var(--strong); text-decoration-thickness: 1.5px; }
.search { margin-left: auto; }
.search input { width: 14rem; max-width: 46vw; padding: .4rem .75rem; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--ink); font: inherit; font-size: 13px; outline: none; }
.search input:focus { border-color: var(--line-strong); }

.hero { padding: 3rem 0 2rem; }
.hero h1, h1 { font: 600 2rem/1.15 var(--serif); letter-spacing: -0.02em; color: var(--strong); margin: 0; }
.hero .sub, .sub { color: var(--muted); font-size: 14px; margin-top: .6rem; }
.page-head { padding: 2.75rem 0 1.5rem; display: flex; gap: 1rem; align-items: flex-start; justify-content: space-between; }
.label { font-size: 12px; font-weight: 600; letter-spacing: .08em; color: var(--muted); margin: 0 0 .75rem; }
section + section, .block + .block { margin-top: 2.5rem; }

.card { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 1.5rem; }
.next { display: flex; gap: 1.25rem; align-items: flex-end; justify-content: space-between; }
.next .what { font: 1.15rem/1.6 var(--serif); color: var(--strong); margin-top: .35rem; }
.next .why { color: var(--muted); font-size: 13px; margin-top: .5rem; }
.bento { display: grid; grid-template-columns: 3fr 2fr; gap: 1rem; margin-top: 1rem; }
.bento > * { margin: 0 !important; min-width: 0; }
.bento .wide { grid-column: 1 / -1; }
.bento section:not(.wide) .row { flex-direction: column; gap: .65rem; }

.list { list-style: none; margin: 0; padding: 0; }
.list.card { padding: .25rem 1.5rem; }
.list > li { padding: 1rem 0; border-bottom: 1px solid var(--line); }
.card > .list > li:first-child { padding-top: 0; }
.card > .list > li:last-child { padding-bottom: 0; }
.list > li:last-child { border-bottom: 0; }
.row { display: flex; gap: .75rem; align-items: flex-start; justify-content: space-between; }
.row > :first-child { min-width: 0; flex: 1; }
.title { color: var(--strong); font-weight: 500; }
.meta { color: var(--faint); font-size: 12.5px; margin-top: .2rem; }
.said { color: var(--muted); font-size: 13.5px; margin-top: .35rem; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.quote { font-family: var(--serif); color: var(--ink); border-left: 2px solid var(--line-strong); padding-left: .9rem; margin: .1rem 0; }
.note { color: var(--muted); font-size: 14px; margin: .5rem 0 0 .9rem; }
.probe { margin: .6rem 0 0 .9rem; padding: .6rem .8rem; background: var(--yellow-bg); border-radius: 6px; font-size: 14px; color: var(--ink); }
.probe .k { color: var(--yellow); font-size: 12px; font-weight: 600; margin-right: .4rem; }
.insight { font: 1.02rem/1.75 var(--serif); color: var(--strong); }

.tag { display: inline-block; font-size: 11.5px; line-height: 1.6; padding: 0 .55rem; border-radius: 9999px; background: var(--sunk); color: var(--muted); letter-spacing: .03em; white-space: nowrap; vertical-align: 1px; }
.tag.mine { background: var(--green-bg); color: var(--green); }
.tag.ai { background: var(--blue-bg); color: var(--blue); }
.tag.mode { background: var(--yellow-bg); color: var(--yellow); }
.tag.link { background: var(--red-bg); color: var(--red); }

.chat { flex: none; display: inline-flex; align-items: center; gap: .35rem; font: inherit; font-size: 12.5px; color: var(--muted); background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: .3rem .65rem; cursor: pointer; white-space: nowrap; transition: color .2s, border-color .2s, transform .1s; }
.chat:hover { color: var(--strong); border-color: var(--line-strong); }
.chat:active { transform: scale(0.98); }
.chat.primary { background: var(--strong); color: var(--bg); border-color: var(--strong); padding: .55rem 1rem; font-size: 14px; }
.chat.primary:hover { opacity: .88; color: var(--bg); }
.chat.done { color: var(--green); border-color: var(--green); }
.chat.primary.done { background: var(--green); border-color: var(--green); color: #fff; }

.shelf { display: grid; grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr)); gap: 1.5rem 1rem; }
.shelf a:hover { text-decoration: none; }
.shelf a:hover .bt { text-decoration: underline; text-underline-offset: 3px; }
.cover { aspect-ratio: 3 / 4.2; border-radius: 4px; border: 1px solid var(--line); background: var(--sunk); overflow: hidden; display: flex; align-items: center; justify-content: center; }
.cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.cover.blank { align-items: stretch; padding: 10% 12%; background: var(--surface); }
.cover.blank span { flex: 1; display: flex; align-items: center; justify-content: center; text-align: center; border-top: 1px solid var(--line-strong); border-bottom: 1px solid var(--line-strong); font: 500 .95rem/1.5 var(--serif); color: var(--ink); letter-spacing: .04em; }
.bt { color: var(--strong); font-size: 14px; margin-top: .6rem; line-height: 1.45; }
.ba { color: var(--faint); font-size: 12.5px; }
.book-head { display: grid; grid-template-columns: 7rem 1fr; gap: 1.5rem; padding: 2.75rem 0 1.5rem; align-items: start; }
.book-head .cover { width: 7rem; }
.progress { height: 3px; background: var(--line); border-radius: 2px; margin-top: .9rem; max-width: 16rem; overflow: hidden; }
.progress i { display: block; height: 100%; background: var(--strong); }
.toc { display: flex; flex-wrap: wrap; gap: .25rem 1.1rem; font-size: 13px; color: var(--muted); padding-bottom: 1.25rem; border-bottom: 1px solid var(--line); margin-bottom: 2rem; }
h2 { font: 600 1.15rem/1.4 var(--serif); color: var(--strong); margin: 0 0 1rem; }
h3 { font-size: 13px; font-weight: 600; letter-spacing: .06em; color: var(--muted); margin: 2rem 0 .75rem; }

.msg { padding: 1rem 0; border-bottom: 1px solid var(--line); }
.msg:last-child { border-bottom: 0; }
.msg .who { font-size: 12px; color: var(--faint); margin-bottom: .3rem; }
.msg.me .who { color: var(--green); }
.msg.ai .body { color: var(--muted); }
.body p { margin: .4rem 0; }
.body h3, .body h4, .body h5, .body h6 { font-size: 14.5px; letter-spacing: 0; color: var(--strong); margin: 1.1rem 0 .3rem; }
.body ul, .body ol { margin: .4rem 0; padding-left: 1.3rem; }
.body blockquote { font-family: var(--serif); border-left: 2px solid var(--line-strong); margin: .5rem 0; padding-left: .9rem; }
.body code, code { font: 12.5px var(--mono); background: var(--sunk); padding: .05rem .35rem; border-radius: 4px; }
details.guide { border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
details.guide + details.guide { margin-top: .75rem; }
details.guide summary { list-style: none; cursor: pointer; padding: 1rem 1.25rem; display: flex; justify-content: space-between; gap: 1rem; color: var(--strong); }
details.guide summary::-webkit-details-marker { display: none; }
details.guide summary::after { content: "+"; color: var(--muted); font-size: 18px; line-height: 1; }
details.guide[open] summary::after { content: "−"; }
details.guide .inner { padding: 0 1.25rem 1.25rem; }
.ai-note { font-size: 12.5px; color: var(--blue); margin-bottom: .5rem; }

.empty { color: var(--muted); font-size: 14px; }
.steps { counter-reset: s; list-style: none; padding: 0; margin: 1rem 0 0; display: grid; gap: 1rem; }
.steps li { counter-increment: s; display: grid; grid-template-columns: 2rem 1fr; gap: .25rem .75rem; }
.steps li::before { content: counter(s); grid-row: span 2; width: 1.75rem; height: 1.75rem; border-radius: 6px; background: var(--sunk); color: var(--strong); font: 600 13px/1.75rem var(--sans); text-align: center; }
.steps .t { color: var(--strong); font-weight: 500; }
.foot { margin-top: 4rem; padding-top: 1.25rem; border-top: 1px solid var(--line); color: var(--faint); font-size: 12.5px; }
.toast { position: fixed; left: 50%; bottom: 1.5rem; transform: translate(-50%, 8px); opacity: 0; pointer-events: none; background: var(--strong); color: var(--bg); font-size: 13px; padding: .55rem 1rem; border-radius: 6px; transition: opacity .25s var(--ease), transform .25s var(--ease); }
.toast.show { opacity: 1; transform: translate(-50%, 0); }


@media (max-width: 44rem) {
  .bento { grid-template-columns: 1fr; }
  .next { flex-direction: column; align-items: stretch; }
  .next .chat.primary { justify-content: center; }
  .book-head { grid-template-columns: 5rem 1fr; gap: 1rem; }
  .book-head .cover { width: 5rem; }
  .hero h1, h1 { font-size: 1.6rem; }
}
@media (max-width: 32rem) {
  .search { margin-left: 0; width: 100%; }
  .search input { width: 100%; max-width: none; }
  .row { flex-direction: column; }
  .shelf { grid-template-columns: repeat(3, 1fr); gap: 1rem .75rem; }
  .cover.blank span { font-size: .8rem; }
}
`;
