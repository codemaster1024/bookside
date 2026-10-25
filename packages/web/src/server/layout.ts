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

/**
 * 一种「接着聊」的意图：复制出去的是用户对智能体说的第一人称的话。
 * input：这句话以冒号结尾，先在网页上写完后半句再复制。
 */
export type Intent = { label: string; prompt: string; input?: boolean; placeholder?: string };

/**
 * 「接着聊」：只有一种意图时直接复制；有几种时先选意图。primary 用在页面上最主要的那一处。
 * 网页不写入任何东西，复制出的话贴给智能体，由它来记。
 */
export function chatMenu(intents: Intent[], opts: { primary?: boolean; label?: string } = {}) {
  const cls = `chat${opts.primary ? " primary" : ""}`;
  const label = opts.label ?? "接着聊";
  const item = (i: Intent, asButton: boolean) =>
    html`<button type="button" class="${asButton ? cls : "item"}" data-copy="${i.prompt}" data-label="${i.label}"${i.input ? raw(" data-input") : ""}${i.placeholder ? html` data-placeholder="${i.placeholder}"` : ""}>${asButton ? html`${CHAT_ICON}<span>${label}</span>` : i.label}</button>`;
  if (intents.length === 1) return item(intents[0]!, true);
  return html`<div class="chat-wrap"><button type="button" class="${cls}" aria-haspopup="menu" aria-expanded="false">${CHAT_ICON}<span>${label}</span><span class="caret" aria-hidden="true">▾</span></button><div class="menu" role="menu" hidden>${intents.map((i) => item(i, false))}</div></div>`;
}

export function page(opts: { title: string; section: Section; body: Html; query?: string; phone?: boolean }): Html {
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
  <footer class="foot">这里只能看。想聊、想记、想改，点「接着聊」把那句话贴给智能体。${opts.phone ? html` · <a href="/phone">在手机上看</a>` : ""}</footer>
</div>
<div class="toast" role="status" aria-live="polite"></div>
<dialog class="composer">
  <form method="dialog">
    <p class="label"></p>
    <p class="lead"></p>
    <textarea rows="5"></textarea>
    <p class="meta">复制后贴给智能体。没写完也没关系，草稿会留在这台电脑的浏览器里。</p>
    <div class="actions"><button value="cancel" class="chat">取消</button><button type="button" class="chat primary" data-action="copy">复制，去智能体里粘贴</button></div>
  </form>
</dialog>
<script>${raw(SCRIPT)}</script>
</body>
</html>`;
}

const SCRIPT = `
const toast = document.querySelector(".toast");
const dialog = document.querySelector("dialog.composer");
const area = dialog.querySelector("textarea");
let timer, lead = "";
const draftKey = () => "bookside-draft:" + lead;
const store = {
  get(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },
};
async function copy(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const t = document.createElement("textarea");
    t.value = text; document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove();
  }
  toast.textContent = "已复制，贴给智能体就能接着聊";
  toast.classList.add("show");
  clearTimeout(timer);
  timer = setTimeout(() => toast.classList.remove("show"), 1800);
}
function closeMenus(except) {
  document.querySelectorAll(".chat-wrap .menu").forEach((m) => {
    if (m === except) return;
    m.hidden = true;
    m.previousElementSibling.setAttribute("aria-expanded", "false");
  });
}
document.addEventListener("click", (e) => {
  const toggle = e.target.closest("button[aria-haspopup]");
  if (toggle) {
    const menu = toggle.nextElementSibling;
    closeMenus(menu);
    menu.hidden = !menu.hidden;
    toggle.setAttribute("aria-expanded", String(!menu.hidden));
    return;
  }
  const b = e.target.closest("button[data-copy]");
  closeMenus();
  if (!b) return;
  if (b.hasAttribute("data-input")) {
    lead = b.dataset.copy;
    dialog.querySelector(".label").textContent = b.dataset.label;
    dialog.querySelector(".lead").textContent = lead;
    area.placeholder = b.dataset.placeholder || "接着写下你的话";
    area.value = store.get(draftKey());
    dialog.showModal();
    area.focus();
  } else {
    copy(b.dataset.copy);
  }
});
area.addEventListener("input", () => store.set(draftKey(), area.value));
dialog.querySelector("[data-action=copy]").addEventListener("click", () => {
  copy(lead + area.value.trim());
  store.set(draftKey(), "");
  dialog.close();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenus(); });
// 窄屏上热力图横向滚动时，先露出最近的几个月。
document.querySelectorAll(".heat-scroll").forEach((el) => { el.scrollLeft = el.scrollWidth; });`;

const CSS = `
:root {
  --bg: #f7f6f3; --surface: #fff; --sunk: #f1efea; --ink: #2f3437; --strong: #111; --muted: #787774; --faint: #a3a29e;
  --line: #eaeaea; --line-strong: #dcdad5;
  --blue-bg: #e1f3fe; --blue: #1f6c9f; --green-bg: #edf3ec; --green: #346538;
  --yellow-bg: #fbf3db; --yellow: #956400; --red-bg: #fdebec; --red: #9f2f2d;
  --paper: #fbfaf7; --heat-0: #eceae4; --heat-1: #dfe7d6; --heat-2: #b9cfae; --heat-3: #86ab7c; --heat-4: #4f7a4a;
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
    --paper: #1d1d1c; --heat-0: #262625; --heat-1: #24331f; --heat-2: #35502f; --heat-3: #557d4c; --heat-4: #86b47b;
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
.chat .caret { font-size: 10px; opacity: .7; }
.chat-wrap { position: relative; flex: none; }
.chat-wrap .menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 10; min-width: 11rem; background: var(--surface); border: 1px solid var(--line-strong); border-radius: 8px; padding: .3rem; box-shadow: 0 6px 20px rgba(0, 0, 0, .06); }
.chat-wrap .menu .item { display: block; width: 100%; text-align: left; font: inherit; font-size: 13.5px; color: var(--ink); background: none; border: 0; border-radius: 5px; padding: .45rem .65rem; cursor: pointer; white-space: nowrap; }
.chat-wrap .menu .item:hover, .chat-wrap .menu .item:focus-visible { background: var(--sunk); outline: none; }
dialog.composer { width: min(36rem, calc(100vw - 2rem)); border: 1px solid var(--line-strong); border-radius: 12px; padding: 1.5rem; background: var(--surface); color: var(--ink); }
dialog.composer::backdrop { background: rgba(20, 20, 18, .35); }
dialog.composer .lead { font: 1rem/1.7 var(--serif); color: var(--strong); margin: .25rem 0 .75rem; }
dialog.composer textarea { width: 100%; font: inherit; font-size: 15px; line-height: 1.7; color: var(--ink); background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: .65rem .8rem; resize: vertical; outline: none; }
dialog.composer textarea:focus { border-color: var(--line-strong); }
dialog.composer .actions { display: flex; justify-content: flex-end; gap: .5rem; margin-top: 1rem; }
.head-row { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; flex-wrap: wrap; }
.notice { border-style: dashed; }

.shelf { display: grid; grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr)); gap: 1.5rem 1rem; }
.shelf a:hover { text-decoration: none; }
.shelf a:hover .bt { text-decoration: underline; text-underline-offset: 3px; }
.cover { aspect-ratio: 3 / 4.2; border-radius: 4px; border: 1px solid var(--line); background: var(--sunk); overflow: hidden; display: flex; align-items: center; justify-content: center; }
.cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.cover.blank { position: relative; align-items: flex-start; padding-top: 14%; border: 0; border-radius: 3px 6px 6px 3px; box-shadow: inset 6px 0 0 rgba(0, 0, 0, .06), inset 7px 0 0 rgba(255, 255, 255, .18); }
.cover.blank span { writing-mode: vertical-rl; max-height: 72%; overflow: hidden; font: 600 1.02rem/1.3 var(--serif); letter-spacing: .16em; }
.cover.blank small { position: absolute; left: 0; right: 0; bottom: 8%; text-align: center; font-size: 10.5px; letter-spacing: .08em; opacity: .7; }
.c1 { background: #e7dccb; color: #5b4630; } .c2 { background: #d6e0d5; color: #34503a; } .c3 { background: #d9e2ea; color: #2e4a63; }
.c4 { background: #ead6d3; color: #6e3532; } .c5 { background: #e3e0d0; color: #514c2c; } .c6 { background: #dcd7e4; color: #463d5c; }
@media (prefers-color-scheme: dark) {
  .c1 { background: #3a3126; color: #e8d3b4; } .c2 { background: #26332a; color: #b9d6bd; } .c3 { background: #232f3a; color: #b6cde2; }
  .c4 { background: #3a2826; color: #ecbcb7; } .c5 { background: #33311f; color: #dcd5a8; } .c6 { background: #2d2838; color: #cdc1e2; }
}
.bt { color: var(--strong); font-size: 14px; margin-top: .6rem; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
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

/* 首页 */
.lead-in { margin-top: 2rem; }
.label .aside { font-weight: 400; letter-spacing: 0; color: var(--faint); margin-left: .5rem; }
.ai-tag { display: inline-flex; align-items: center; gap: .3rem; font-size: 11px; font-weight: 500; letter-spacing: .04em; color: var(--blue); background: var(--blue-bg); padding: 0 .5rem; border-radius: 9999px; line-height: 1.7; vertical-align: 1px; margin-left: .35rem; }
.ai-tag::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.hint { color: var(--muted); font-size: 14px; }
.frontis { position: relative; margin-top: 2.5rem; padding: 4rem 3.5rem 2.5rem; background: var(--paper); border: 1px solid var(--line); border-radius: 12px; }
.frontis::before { content: "“"; position: absolute; left: 1.9rem; top: .3rem; font: 8rem/1 var(--serif); color: var(--line-strong); pointer-events: none; }
.frontis .date { position: absolute; right: 1.75rem; top: 1.4rem; font: 12px var(--mono); color: var(--faint); letter-spacing: .05em; }
.frontis blockquote { position: relative; margin: 0; font: 500 2rem/1.6 var(--serif); letter-spacing: .01em; color: var(--strong); max-width: 32em; }
.frontis blockquote.long { font-size: 1.45rem; line-height: 1.75; }
.frontis .src { margin-top: 1.25rem; color: var(--muted); font: 14px var(--serif); }
.frontis .src::before { content: "—— "; }
.frontis .why { margin-top: 2rem; padding-top: 1.25rem; border-top: 1px solid var(--line); display: flex; gap: 1.5rem; align-items: flex-end; justify-content: space-between; }
.frontis .why > div:first-child { min-width: 0; }
.frontis .why p { margin-top: .45rem; max-width: 46em; font-size: 14.5px; }
.frontis .why .ai-tag { margin-left: 0; }
.stats { display: grid; grid-template-columns: repeat(5, 1fr); margin-top: 2rem; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.stat { padding: 1.25rem 0 1.15rem 1.25rem; border-left: 1px solid var(--line); min-width: 0; }
.stat:first-child { border-left: 0; padding-left: 0; }
.stat .n { font: 500 2.3rem/1 var(--serif); color: var(--strong); letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.stat .k { margin-top: .55rem; font-size: 12.5px; color: var(--muted); }
.stat .k b { color: var(--green); font-weight: 500; }
.home > section { margin-top: 3.5rem; }
.themes { display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap: 1rem; }
.theme { display: flex; flex-direction: column; }
.theme .no { font: 12px var(--mono); color: var(--faint); }
.theme h3 { font: 600 1.2rem/1.45 var(--serif); letter-spacing: 0; color: var(--strong); margin: .3rem 0 .4rem; }
.theme .gist { color: var(--muted); font-size: 13.5px; margin-bottom: 1.1rem; }
.theme .q { display: block; font: 14.5px/1.75 var(--serif); color: var(--ink); border-left: 2px solid var(--line-strong); padding-left: .85rem; margin-bottom: .9rem; }
.theme .q span { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.theme .q:hover { text-decoration: none; border-left-color: var(--strong); }
.theme .q cite { display: block; font: 12px var(--sans); color: var(--faint); font-style: normal; margin-top: .15rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.theme .foot { margin-top: auto; padding-top: .5rem; font-size: 12.5px; color: var(--faint); display: flex; justify-content: space-between; align-items: center; gap: .75rem; }
.portrait { display: grid; grid-template-columns: 19rem 1fr; gap: 1rem; }
.portrait > * { min-width: 0; }
.radar svg { display: block; width: 100%; max-width: 19rem; margin: 0 auto; overflow: visible; }
.radar .ax { font: 12.5px var(--sans); fill: var(--muted); }
.radar .ax.none { fill: var(--faint); }
.radar .ring { fill: none; stroke: var(--line); }
.radar .spoke { stroke: var(--line); }
.radar .area { fill: var(--green); fill-opacity: .16; stroke: var(--green); stroke-width: 1.5; stroke-linejoin: round; }
.radar .dot { fill: var(--surface); stroke: var(--green); stroke-width: 1.5; }
.radar .cap { margin-top: .75rem; font-size: 13px; color: var(--muted); text-align: center; }
.radar.few { align-self: start; }
.radar.few .cap { text-align: left; }
.radar .cap b { color: var(--strong); font-weight: 500; }
.essay > p:not(.label) { font: 1.04rem/1.95 var(--serif); color: var(--strong); margin-bottom: .9rem; }
.essay.pending { display: flex; flex-direction: column; }
.essay.pending .hint { font: 14.5px/1.85 var(--sans); color: var(--muted); }
.essay .actions { margin-top: auto; padding-top: 1rem; }
.change { margin: .1rem 0 1rem; padding: .7rem .9rem; border-left: 2px solid var(--blue); background: var(--blue-bg); border-radius: 0 6px 6px 0; font-size: 14px; color: var(--ink); }
.change span { display: block; font-size: 11.5px; font-weight: 600; letter-spacing: .06em; color: var(--blue); margin-bottom: .15rem; }
a.aside:hover { color: var(--strong); }
.history + .history { margin-top: 1rem; }
.history .theme-titles { list-style: none; padding: 0; margin: 0 0 1rem; display: grid; gap: .35rem; }
.history .theme-titles b { font: 600 1.02rem var(--serif); color: var(--strong); margin-right: .6rem; }
.history .theme-titles span { color: var(--muted); font-size: 13.5px; }
.history details { margin-top: .9rem; }
.history summary { cursor: pointer; color: var(--muted); font-size: 13px; }
.history details .insight { margin-top: .6rem; }
.path ol { list-style: none; margin: 0; padding: 0 0 0 .2rem; }
.path li { position: relative; display: flex; gap: 1rem; padding: 0 0 .8rem 1.1rem; font-size: 14px; }
.path li::before { content: ""; position: absolute; left: 0; top: .55rem; width: 7px; height: 7px; border-radius: 50%; background: var(--line-strong); }
.path li:not(:last-child)::after { content: ""; position: absolute; left: 3px; top: 1.1rem; bottom: -.1rem; width: 1px; background: var(--line); }
.path li.resolved::before { background: var(--green); } .path li.tentative::before { background: var(--yellow); } .path li.said::before { background: var(--strong); }
.path .d { flex: none; width: 6.5rem; color: var(--faint); font: 12.5px/1.7 var(--mono); }
.path b { color: var(--strong); font-weight: 500; }
.versions { margin-top: .5rem; }
.versions summary { cursor: pointer; color: var(--muted); font-size: 12.5px; }
.versions ol { list-style: none; margin: .5rem 0 0; padding: 0 0 0 .9rem; border-left: 2px solid var(--line); }
.versions li { padding: .35rem 0; }
.versions li p { font: 14px/1.7 var(--serif); color: var(--muted); }
.before-after { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
.before-after > div { padding: 1.25rem 1.5rem; min-width: 0; }
.before-after > div + div { border-left: 1px solid var(--line); background: var(--paper); border-radius: 0 10px 10px 0; }
.before-after .insight + .insight { margin-top: .5rem; }
.phone { text-align: center; }
.phone .qr { width: min(16rem, 70vw); margin: .5rem auto 1rem; background: #fff; padding: .5rem; border-radius: 8px; }
.phone .qr svg { display: block; width: 100%; height: auto; }
.phone .meta { margin-top: .75rem; }
.nextstep { margin-top: 1.25rem; padding: 1rem 1.15rem; background: var(--sunk); border-radius: 8px; display: flex; gap: 1rem; align-items: center; justify-content: space-between; }
.nextstep > div:first-child { min-width: 0; }
.nextstep .k { font-size: 12px; font-weight: 600; letter-spacing: .08em; color: var(--muted); }
.nextstep .v { margin-top: .2rem; color: var(--strong); }
.nextstep .m { margin-top: .2rem; font-size: 12.5px; color: var(--faint); }
.heat-scroll { overflow-x: auto; padding-bottom: .25rem; }
.heat .months, .heat .days { display: grid; grid-template-columns: repeat(var(--weeks), minmax(11px, 1fr)); gap: 3px; min-width: calc(var(--weeks) * 14px); }
.heat .months { font-size: 11.5px; color: var(--faint); margin-bottom: .35rem; height: 1.2em; }
.heat .months span { white-space: nowrap; }
.heat .days { grid-template-rows: repeat(7, auto); grid-auto-flow: column; }
.heat i { display: block; aspect-ratio: 1; border-radius: 3px; }
.heat .l0 { background: var(--heat-0); } .heat .l1 { background: var(--heat-1); } .heat .l2 { background: var(--heat-2); } .heat .l3 { background: var(--heat-3); } .heat .l4 { background: var(--heat-4); }
.heat-foot { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; margin-top: .9rem; font-size: 13px; color: var(--muted); }
.heat-foot b { color: var(--strong); font-weight: 500; }
.heat .scale { display: inline-flex; align-items: center; gap: 3px; font-size: 11.5px; color: var(--faint); }
.heat .scale i { width: 11px; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
.cols > * { min-width: 0; }
.cols .row { flex-direction: column; gap: .65rem; }
.cols .chat-wrap .menu { right: auto; left: 0; }
.more { margin-top: 1rem; }
.shelf.top { grid-template-columns: repeat(6, 1fr); }
.colophon { margin-top: 3rem; color: var(--faint); font-size: 12.5px; }

@media (max-width: 44rem) {
  .frontis { padding: 3.25rem 1.5rem 1.75rem; }
  .frontis::before { left: 1rem; font-size: 6rem; }
  .frontis blockquote { font-size: 1.45rem; }
  .frontis blockquote.long { font-size: 1.15rem; }
  .frontis .why, .change { margin: .1rem 0 1rem; padding: .7rem .9rem; border-left: 2px solid var(--blue); background: var(--blue-bg); border-radius: 0 6px 6px 0; font-size: 14px; color: var(--ink); }
.change span { display: block; font-size: 11.5px; font-weight: 600; letter-spacing: .06em; color: var(--blue); margin-bottom: .15rem; }
a.aside:hover { color: var(--strong); }
.history + .history { margin-top: 1rem; }
.history .theme-titles { list-style: none; padding: 0; margin: 0 0 1rem; display: grid; gap: .35rem; }
.history .theme-titles b { font: 600 1.02rem var(--serif); color: var(--strong); margin-right: .6rem; }
.history .theme-titles span { color: var(--muted); font-size: 13.5px; }
.history details { margin-top: .9rem; }
.history summary { cursor: pointer; color: var(--muted); font-size: 13px; }
.history details .insight { margin-top: .6rem; }
.path ol { list-style: none; margin: 0; padding: 0 0 0 .2rem; }
.path li { position: relative; display: flex; gap: 1rem; padding: 0 0 .8rem 1.1rem; font-size: 14px; }
.path li::before { content: ""; position: absolute; left: 0; top: .55rem; width: 7px; height: 7px; border-radius: 50%; background: var(--line-strong); }
.path li:not(:last-child)::after { content: ""; position: absolute; left: 3px; top: 1.1rem; bottom: -.1rem; width: 1px; background: var(--line); }
.path li.resolved::before { background: var(--green); } .path li.tentative::before { background: var(--yellow); } .path li.said::before { background: var(--strong); }
.path .d { flex: none; width: 6.5rem; color: var(--faint); font: 12.5px/1.7 var(--mono); }
.path b { color: var(--strong); font-weight: 500; }
.versions { margin-top: .5rem; }
.versions summary { cursor: pointer; color: var(--muted); font-size: 12.5px; }
.versions ol { list-style: none; margin: .5rem 0 0; padding: 0 0 0 .9rem; border-left: 2px solid var(--line); }
.versions li { padding: .35rem 0; }
.versions li p { font: 14px/1.7 var(--serif); color: var(--muted); }
.before-after { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
.before-after > div { padding: 1.25rem 1.5rem; min-width: 0; }
.before-after > div + div { border-left: 1px solid var(--line); background: var(--paper); border-radius: 0 10px 10px 0; }
.before-after .insight + .insight { margin-top: .5rem; }
.phone { text-align: center; }
.phone .qr { width: min(16rem, 70vw); margin: .5rem auto 1rem; background: #fff; padding: .5rem; border-radius: 8px; }
.phone .qr svg { display: block; width: 100%; height: auto; }
.phone .meta { margin-top: .75rem; }
.nextstep { flex-direction: column; align-items: stretch; }
  .stats { grid-template-columns: repeat(3, 1fr); }
  .stat:nth-child(4) { border-left: 0; padding-left: 0; }
  .stat:nth-child(n+4) { border-top: 1px solid var(--line); }
  .stat .n { font-size: 1.85rem; }
  .portrait, .cols, .before-after { grid-template-columns: 1fr; }
  .before-after > div + div { border-left: 0; border-top: 1px solid var(--line); border-radius: 0 0 10px 10px; }
  .shelf.top { grid-template-columns: repeat(3, 1fr); }
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
