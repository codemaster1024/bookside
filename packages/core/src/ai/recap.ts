// 关于读者自己的几件活：回顾 TA 在一本书里划了什么、用 TA 的划线出题考考 TA、用 TA 自己的话起草一篇读后感。都是对话，不写回。
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { chapters, highlights, notes } from "../db/schema.ts";
import { getBook } from "../domain/books.ts";
import type { Conn } from "../domain/conn.ts";
import { DomainError } from "../domain/errors.ts";
import { latestGuide } from "../domain/guides.ts";
import { insightsOfBook } from "../domain/insights.ts";
import { listMessages } from "../domain/questions.ts";
import { describePosition, describeReadingMode, readingModeOf } from "../domain/reading-mode.ts";
import { listQuestions } from "../domain/threads.ts";
import { type Brief, refOf } from "./brief.ts";
import { spoilerRule } from "./modes.ts";

const MAX_HIGHLIGHTS = 120;
const HIGHLIGHT_CHARS = 200;
const GUIDE_CHARS = 2500;

/** 这本书里读者的划线（按章）、想法、问题与观点，给两件活共用。 */
function readerMaterial(db: Conn, bookId: string): { lines: string[]; count: number } {
  const book = getBook(db, bookId);
  const rows = db
    .select({ h: highlights, chapter: chapters.title })
    .from(highlights)
    .leftJoin(chapters, eq(chapters.id, highlights.chapterId))
    .where(and(eq(highlights.bookId, bookId), isNull(highlights.deletedAtSourceAt)))
    .orderBy(desc(highlights.markedAt))
    .limit(MAX_HIGHLIGHTS)
    .all()
    .reverse();
  const noteRows = rows.length
    ? db.select().from(notes).where(and(inArray(notes.highlightId, rows.map((r) => r.h.id)), isNull(notes.deletedAtSourceAt))).all()
    : [];
  const lines = [`书：《${book.title}》${book.author ? `，${book.author}` : ""}`, describeReadingMode(readingModeOf(book))];
  const position = describePosition(db, bookId);
  if (position) lines.push(`读者${position}`);
  if (book.purpose) lines.push(`读前目的：${book.purpose}`);
  if (rows.length) {
    lines.push("", `读者划过的句子（作者原话，共 ${rows.length} 条），缩进的「想法」是读者自己写的：`);
    let last: string | null | undefined;
    for (const { h, chapter } of rows) {
      if (chapter !== last && chapter) lines.push(`【${chapter}】`);
      last = chapter;
      lines.push(`[${refOf("highlight", h.id)}] ${h.text.replace(/\s+/g, " ").slice(0, HIGHLIGHT_CHARS)}`);
      for (const n of noteRows.filter((x) => x.highlightId === h.id)) lines.push(`    想法：${n.content}`);
    }
  }
  const qs = listQuestions(db, { bookId });
  if (qs.length) {
    lines.push("", "读者在这本书里提出的问题（附 TA 最近说的话）：");
    for (const q of qs) {
      const mine = listMessages(db, q.id).filter((m) => m.speaker === "me").at(-1);
      lines.push(`[${refOf("question", q.id)}] ${q.title}${mine ? `\n    读者：${mine.content.slice(0, 200)}` : ""}`);
    }
  }
  const insights = insightsOfBook(db, bookId);
  if (insights.length) lines.push("", "读者已经沉淀的观点：", ...insights.map((i) => `- ${i.content}`));
  return { lines, count: rows.length };
}

/** 我的划线回顾：读者在这本书里划了什么、反复关注什么。 */
export function recapBrief(db: Conn, bookId: string): Brief {
  const book = getBook(db, bookId);
  const m = readerMaterial(db, bookId);
  if (m.count === 0) throw new DomainError("no_basis", `《${book.title}》里还没有划线，没有可回顾的`);
  return {
    task: `回顾读者在《${book.title}》里划了什么`,
    instructions: `这是关于读者自己的回顾，不是书的摘要。直接讲给读者听，不用写回：
- 你反复关注的 2–4 件事：每件一两句话说清，各附一两句 TA 划过的原句（用「」引，只用材料里的原文）。
- 最打动你的几句：优先挑 TA 写了想法的划线，说说这些想法连起来透露了 TA 在意什么。
- 和你的问题的联系：哪些划线可能回应了 TA 提过的问题；没有就不写这一节。
- 分清谁说的：划线是作者的原话，读者只是划了它；只有「想法」和问题里的话是读者自己说的。
- 不评价读者，不总结书的内容。最后问 TA 一个问题，比如这些关注点里哪个最想继续想下去；TA 想继续时按记录规则记成问题。`,
    material: m.lines.join("\n"),
  };
}

/** 考考我：用读者的划线、导读和 TA 写下的理解出题。 */
export function quizBrief(db: Conn, bookId: string): Brief {
  const book = getBook(db, bookId);
  const m = readerMaterial(db, bookId);
  const guide = latestGuide(db, bookId, undefined, "full") ?? latestGuide(db, bookId, undefined, "quick");
  if (m.count === 0 && !guide) throw new DomainError("no_basis", `《${book.title}》里还没有划线或导读，出不了题`);
  const lines = [...m.lines];
  if (guide) lines.push("", "这本书的 AI 导读（只作出题参考，不是读者的笔记）：", guide.content.slice(0, GUIDE_CHARS));
  const mode = readingModeOf(book);
  return {
    task: `用读者在《${book.title}》里的划线考考 TA`,
    instructions:
      `出 3 道题考考读者，一次只问一道，等 TA 答完再给反馈、再问下一道。直接在对话里进行，不用写回：
- 考理解，不考记忆：请 TA 用自己的话解释一个概念、举一个书以外的例子、判断一个说法对不对并说明理由，或者把两条划线联系起来。
- 只用材料里有的内容出题；题目引用原句时用「」，只用材料里的原文。
- 答得好就具体说好在哪，再补一点 TA 没提到的；答得不对或含糊，指出哪里不对、给一个提示，请 TA 再试一次，第二次仍不对再讲清楚。
- 三道问完，问 TA 要不要把讲得最清楚的那一条用自己的话存下来：bookside insight new --as me --book ${refOf("book", bookId)} -（落在某条划线上时用 --highlight）。` + spoilerRule(mode.mode, describePosition(db, bookId)),
    material: lines.join("\n"),
  };
}

/** 不同读法的书，写出来的东西叫法不同。 */
const DRAFT_KIND = { argument: "书评", practice: "实践心得", knowledge: "读书笔记", narrative: "读后感" } as const;

/** 读后感草稿：用读者自己写下的想法、问题里的发言和观点拼成一篇，AI 只排顺序、写过渡。 */
export function draftBrief(db: Conn, bookId: string, opts: { for?: string } = {}): Brief {
  const book = getBook(db, bookId);
  const m = readerMaterial(db, bookId);
  const said = listQuestions(db, { bookId }).flatMap((q) =>
    listMessages(db, q.id)
      .filter((x) => x.speaker === "me")
      .map((x) => `[${refOf("question", q.id)}] 关于「${q.title}」，读者说：${x.content.slice(0, 400)}`),
  );
  const insights = insightsOfBook(db, bookId);
  const notes = m.lines.filter((l) => l.startsWith("    想法："));
  if (said.length + insights.length + notes.length === 0) {
    throw new DomainError("no_basis", `《${book.title}》里你还没写下自己的想法、问题或观点，没有可以拼成文章的话。先聊一聊，或者先说说你读完最想讲的一件事`);
  }
  const lines = [...m.lines];
  if (said.length) lines.push("", "读者在问题线程里说过的话（原话）：", ...said);
  const kind = DRAFT_KIND[readingModeOf(book).mode];
  return {
    task: `用读者自己的话起草一篇《${book.title}》的${kind}`,
    instructions: `起草一篇${kind}${opts.for ? `，发在${opts.for}` : ""}，篇幅按平台习惯（没说就 600–1000 字）。这是读者的文章，不是你的：
- 主体用读者自己的话：观点、划线旁的「想法」、问题线程里的发言，原样或只做最小的改动（去口语、补主语）。书里的原文可以引用，用「」并注明出自书中。
- 你只做三件事：定一个结构和标题、排顺序、写段落之间的过渡句。读者没说过的判断不要替 TA 写；某处缺一句关键的话时，留「【这里你怎么看？】」请 TA 补。
- 写完在文末另起一段，列出：用到了 TA 的哪几句话（附引用号），以及还缺什么、补上会更好。
- 直接在对话里给 TA，不用写回。TA 改好后想把其中的结论留下来，按记录规则存成观点（--as me）。`,
    material: lines.join("\n"),
  };
}
