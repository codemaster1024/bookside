// 把书畔的全部内容导出为一组互相链接的 Markdown 文件（兑现"数据属于用户"）。
// 按 Obsidian 的习惯写：[[文件名]] 双链（只写文件名，导出目录放进已有的库里也能解析）、
// 划线带块 id（^h-xxxxxxxx）供链接直达、frontmatter 作为属性。
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { highlights } from "../db/schema.ts";
import type { QuestionStatus } from "../db/schema.ts";
import { type Book, getBookDetail, listBooks } from "../domain/books.ts";
import { readingModeOf } from "../domain/reading-mode.ts";
import { listGuides } from "../domain/guides.ts";
import { guides as guidesTable, reviews as reviewsTable, chapters as chaptersTable } from "../db/schema.ts";
import type { Conn } from "../domain/conn.ts";
import { shortId } from "../domain/ids.ts";
import { type InsightView, type InsightWithSources, listInsights } from "../domain/insights.ts";
import type { Link } from "../domain/links.ts";
import type { Question } from "../domain/questions.ts";
import {
  LINK_KIND_LABELS,
  QUESTION_STATUS_LABELS,
  type QuestionDetail,
  describeRef,
  getQuestionDetail,
  listQuestions,
} from "../domain/threads.ts";

/** 导出目录中的标记文件：有它才允许覆盖，避免误删用户自己的目录。 */
export const EXPORT_MARKER = ".bookside-export";
/** 总览与观点总表的文件名（不用 README.md，免得和库里别的文件重名）。 */
const INDEX = "书畔";
const INSIGHTS = "观点";
/** 每次导出会整体重写的子目录与文件。 */
const OWNED = ["books", "questions", `${INDEX}.md`, `${INSIGHTS}.md`];

export type ExportFiles = Map<string, string>;

const pad = (n: number) => String(n).padStart(2, "0");
/** 本地日期 YYYY-MM-DD，与 CLI 展示一致。 */
const day = (d: Date | null | undefined) => (d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : "—");
const authorship = (i: InsightView) => (i.authorship === "mine" ? "我写的" : "AI 协助");
const quoteBlock = (text: string) =>
  text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");

/** YAML frontmatter，Obsidian 读作属性；列表（如 tags）逐行写。 */
function frontmatter(fields: Record<string, string | number | string[] | null | undefined>): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== null && v !== undefined)
    .flatMap(([k, v]) =>
      Array.isArray(v) ? [`${k}:`, ...v.map((x) => `  - ${JSON.stringify(x)}`)] : [`${k}: ${typeof v === "number" ? v : JSON.stringify(v)}`],
    );
  return `---\n${lines.join("\n")}\n---\n`;
}

/** 双链；显示文字里的 | 和换行会破坏语法，换掉。 */
const wiki = (target: string, label?: string) => {
  const text = label?.replace(/[|\n\r]+/g, " ").replace(/[[\]]/g, "");
  return text && text !== target ? `[[${target}|${text}]]` : `[[${target}]]`;
};
/** 划线的块 id，写在引用块末尾，供 [[书#^h-…]] 直达。 */
const blockId = (highlightId: string) => `h-${shortId(highlightId)}`;

/** 文件名：去掉文件系统不允许的字符并截短；重名时追加短 id。 */
function fileNames<T extends { id: string }>(items: T[], title: (t: T) => string): Map<string, string> {
  const base = (t: T) =>
    title(t)
      .replace(/[\\/:*?"<>|#^[\]\n\r\t]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40)
      .trim() || shortId(t.id);
  const counts = new Map<string, number>();
  for (const t of items) counts.set(base(t), (counts.get(base(t)) ?? 0) + 1);
  return new Map(items.map((t) => [t.id, counts.get(base(t))! > 1 ? `${base(t)} (${shortId(t.id)})` : base(t)]));
}

export function buildExport(db: Conn, now = new Date()): ExportFiles {
  const files: ExportFiles = new Map();
  // 书单中的书，加上只写了导读、还没有划线的书。
  const guided = new Set(db.select({ b: guidesTable.bookId }).from(guidesTable).all().map((r) => r.b));
  const shown = new Set(listBooks(db).map((b) => b.id));
  const books = listBooks(db, { includeEmpty: true }).filter((b) => shown.has(b.id) || guided.has(b.id));
  const questions = listQuestions(db);
  const details = new Map(questions.map((q) => [q.id, getQuestionDetail(db, q.id)]));
  const insights = listInsights(db);
  const bookFile = fileNames(books, (b) => `《${b.title}》`);
  const questionFile = fileNames(questions, (q) => q.title);

  const bookOfHighlight = (id: string) => db.select({ b: highlights.bookId }).from(highlights).where(eq(highlights.id, id)).get()?.b;
  const bookOfQuestion = (id: string) => details.get(id)?.origin?.bookId;
  const insightBooks = (i: InsightWithSources) =>
    new Set(
      i.sources
        .map((s) => s.bookId ?? (s.highlightId ? bookOfHighlight(s.highlightId) : s.questionId ? bookOfQuestion(s.questionId) : undefined))
        .filter((b): b is string => !!b),
    );

  /** 指向某个对象的双链：问题、书直接链到文件，划线链到书里的那一块。 */
  const linkTo = (type: string, id: string): string => {
    const label = describeRef(db, { type: type as Parameters<typeof describeRef>[1]["type"], id }, Number.POSITIVE_INFINITY);
    if (type === "question" && questionFile.has(id)) return wiki(questionFile.get(id)!, label);
    if (type === "book" && bookFile.has(id)) return wiki(bookFile.get(id)!, label);
    const bookId = type === "highlight" ? bookOfHighlight(id) : undefined;
    if (bookId && bookFile.has(bookId)) return wiki(`${bookFile.get(bookId)}#^${blockId(id)}`, label);
    return label;
  };

  const renderLinks = (links: Link[], self: { type: string; id: string }) =>
    links.map((l) => {
      const other = l.fromType === self.type && l.fromId === self.id ? { type: l.toType, id: l.toId } : { type: l.fromType, id: l.fromId };
      return `- ${LINK_KIND_LABELS[l.kind]}：${linkTo(other.type, other.id)}${l.reason ? `——${l.reason}` : ""}`;
    });

  const renderInsight = (i: InsightView, heading: string) => [
    `${heading} ${authorship(i)}`,
    "",
    i.content,
    "",
    `版本历史：${i.versions.map((v, n) => `v${n + 1} ${day(v.createdAt)} ${v.author === "me" ? "我" : "AI"}${v.rewrite && n > 0 ? "（重写）" : ""}`).join("；")}`,
    "",
  ];

  // —— 书 ——
  for (const summary of books) {
    const d = getBookDetail(db, summary.id, { includeDeleted: true });
    const b: Book = d.book;
    const lines = [
      frontmatter({
        type: "book",
        bookside_id: b.id,
        title: b.title,
        author: b.author,
        source: b.source,
        category: b.category,
        reading_mode: readingModeOf(b).label,
        progress: b.progress,
        finished: b.finishedAt ? day(b.finishedAt) : null,
        tags: ["bookside/book"],
      }),
      `# 《${b.title}》`,
      "",
      ...(b.author ? [`- 作者：${b.author}`] : []),
      `- 读法：${readingModeOf(b).label}`,
      ...(b.progress === null ? [] : [`- 进度：${b.progress}%`]),
      ...(b.finishedAt ? [`- 读完：${day(b.finishedAt)}`] : []),
      `- 来源：${{ weread: "微信读书", kindle: "Kindle", local: "本地" }[b.source]}`,
      "",
      "## 读前目的",
      "",
      b.purpose ?? "（未填写）",
      "",
      "## 划线与想法",
      "",
    ];
    if (d.chapters.length === 0) lines.push("（还没有划线）", "");
    for (const c of d.chapters) {
      lines.push(`### ${c.title || "未分章"}`, "");
      for (const h of c.highlights) {
        const flags = [h.kind === "from_note" ? "由想法带出" : "", h.deletedAtSourceAt ? "源端已删除" : ""].filter(Boolean);
        lines.push(`${quoteBlock(h.text)} ^${blockId(h.id)}`, "");
        if (flags.length) lines.push(`*${flags.join("，")}* · ${day(h.markedAt)}`, "");
        for (const n of h.notes) {
          lines.push(`- 想法（${day(n.writtenAt)}${n.deletedAtSourceAt ? "，源端已删除" : ""}）：${n.content}`);
        }
        if (h.notes.length) lines.push("");
      }
    }
    if (d.questions.length) {
      lines.push("## 问题", "");
      for (const q of d.questions) {
        lines.push(`- ${wiki(questionFile.get(q.id)!, q.title)} · ${QUESTION_STATUS_LABELS[q.status]}`);
      }
      lines.push("");
    }
    const bookReviews = db
      .select({ r: reviewsTable, chapter: chaptersTable.title })
      .from(reviewsTable)
      .leftJoin(chaptersTable, eq(chaptersTable.id, reviewsTable.chapterId))
      .where(eq(reviewsTable.bookId, b.id))
      .all();
    if (bookReviews.length) {
      lines.push("## 我的书评", "");
      for (const { r, chapter } of bookReviews) {
        const where = chapter ? `章节点评：${chapter}` : "全书书评";
        const flags = [r.star ? `${"★".repeat(r.star)}` : "", r.deletedAtSourceAt ? "源端已删除" : ""].filter(Boolean);
        lines.push(`### ${where}（${day(r.writtenAt)}${flags.length ? `，${flags.join("，")}` : ""}）`, "", r.content || "（只评了分）", "");
      }
    }
    const bookGuides = listGuides(db, b.id);
    if (bookGuides.length) {
      lines.push("## AI 导读", "", "> 以下由 AI 写成，不是你的笔记。", "");
      for (const g of bookGuides) {
        const basis = g.basis === "familiar" ? "依据写作者对本书的了解" : "依据有限：只根据给出的材料（目录、简介、热门划线或你的划线）";
        lines.push(`### ${g.chapterTitle ? `章节导读：${g.chapterTitle}` : g.depth === "quick" ? "速览" : "全书导读"}（${day(g.createdAt)}，${basis}）`, "");
        // 导读正文的标题降两级，嵌在本节之下。
        lines.push(g.content.replace(/^(#{1,4})\s/gm, (_m, h: string) => `${"#".repeat(Math.min(6, h.length + 2))} `), "");
      }
    }
    const related = insights.filter((i) => insightBooks(i).has(b.id));
    if (related.length) {
      lines.push("## 观点", "");
      for (const i of related) lines.push(...renderInsight(i, "###"));
    }
    files.set(`books/${bookFile.get(b.id)}.md`, lines.join("\n"));
  }

  // —— 问题 ——
  for (const q of questions) {
    const d = details.get(q.id)!;
    files.set(`questions/${questionFile.get(q.id)}.md`, renderQuestion(d, linkTo, renderLinks, renderInsight));
  }

  // —— 观点总表 ——
  const insightLines = [frontmatter({ tags: ["bookside/insights"] }), "# 观点", "", `共 ${insights.length} 条。`, ""];
  for (const i of insights) {
    insightLines.push(...renderInsight(i, `## ${day(i.createdAt)} ·`));
    const srcs = i.sources.map((s) =>
      s.questionId
        ? linkTo("question", s.questionId)
        : s.highlightId
          ? linkTo("highlight", s.highlightId)
          : linkTo("book", s.bookId!),
    );
    insightLines.push(`来源：${srcs.join("；")}`, "");
  }
  files.set(`${INSIGHTS}.md`, insightLines.join("\n"));

  // —— 总览 ——
  const readme = [
    frontmatter({ tags: ["bookside/index"], exported: `${day(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}` }),
    "# 书畔",
    "",
    `导出于 ${day(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}。书 ${books.length} 本，问题 ${questions.length} 个，观点 ${insights.length} 条（${wiki(INSIGHTS, "全部观点")}）。`,
    "",
    "线程中的「我」是你的原话，「AI」是 AI 的回应；观点标注「我写的」或「AI 协助」。",
    "",
    "## 问题",
    "",
  ];
  const order: QuestionStatus[] = ["exploring", "unexplored", "tentative", "resolved", "abandoned"];
  for (const status of order) {
    const group = questions.filter((q) => q.status === status);
    if (group.length === 0) continue;
    readme.push(`### ${QUESTION_STATUS_LABELS[status]}`, "");
    for (const q of group) readme.push(`- ${wiki(questionFile.get(q.id)!, q.title)}`);
    readme.push("");
  }
  readme.push("## 书", "");
  for (const b of books) {
    readme.push(`- ${wiki(bookFile.get(b.id)!)}${b.author ? ` ${b.author}` : ""} · 划线 ${b.highlightCount}`);
  }
  files.set(`${INDEX}.md`, `${readme.join("\n")}\n`);
  return files;
}

function renderQuestion(
  d: QuestionDetail,
  linkTo: (type: string, id: string) => string,
  renderLinks: (links: Link[], self: { type: string; id: string }) => string[],
  renderInsight: (i: InsightView, heading: string) => string[],
): string {
  const q: Question = d.question;
  const origin = d.origin
    ? d.origin.type === "highlight"
      ? linkTo("highlight", d.origin.id)
      : d.origin.type === "chapter"
        ? `${linkTo("book", d.origin.bookId)} ${d.origin.chapterTitle}`
        : linkTo("book", d.origin.bookId)
    : "长期问题";
  const lines = [
    frontmatter({
      type: "question",
      bookside_id: q.id,
      status: q.status,
      created: day(q.createdAt),
      next_revisit: q.nextRevisitAt ? day(q.nextRevisitAt) : null,
      origin: d.origin ? linkTo("book", d.origin.bookId) : null,
      tags: ["bookside/question"],
    }),
    `# ${q.title}`,
    "",
    `- 状态：${QUESTION_STATUS_LABELS[q.status]}`,
    `- 起源：${origin}`,
    `- 创建：${day(q.createdAt)}${q.nextRevisitAt ? ` · 下次回访：${day(q.nextRevisitAt)}` : ""}`,
    "",
    "## 线程",
    "",
  ];
  if (d.messages.length === 0) lines.push("（还没有发言）", "");
  for (const m of d.messages) {
    lines.push(`**${m.speaker === "me" ? "我" : "AI"}** · ${day(m.createdAt)}`, "", m.content, "");
    for (const c of m.cited) lines.push(quoteBlock(`引用：${c.text}`), "");
  }
  if (d.insights.length) {
    lines.push("## 观点", "");
    for (const i of d.insights) lines.push(...renderInsight(i, "###"));
  }
  if (d.links.length) {
    lines.push("## 关联", "", ...renderLinks(d.links, { type: "question", id: q.id }), "");
  }
  return lines.join("\n");
}

/**
 * 写入导出目录。目录非空且不是书畔导出目录时拒绝；
 * 是导出目录时先清掉上次导出的文件，避免改名后留下陈旧文件。
 */
export function writeExport(files: ExportFiles, dir: string): void {
  if (existsSync(dir) && readdirSync(dir).length > 0 && !existsSync(join(dir, EXPORT_MARKER))) {
    throw new Error(`${dir} 不是空目录，也不是书畔的导出目录；请换一个目录`);
  }
  mkdirSync(dir, { recursive: true });
  for (const name of OWNED) rmSync(join(dir, name), { recursive: true, force: true });
  writeFileSync(join(dir, EXPORT_MARKER), `此目录由 bookside export 生成；${OWNED.join("、")} 每次导出都会被覆盖。\n`);
  for (const [path, content] of files) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content.endsWith("\n") ? content : `${content}\n`);
  }
}
