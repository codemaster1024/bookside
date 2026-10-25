// 整理成观点（收拢）：读后把一本书里零散的划线、想法和问题，提炼成几条读者自己的观点。
// 这是一段对话：智能体先提问、再起草，读者采纳或改写，每条观点用 bookside insight new 写回；这里只准备材料。
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { highlights, notes } from "../db/schema.ts";
import { getBook } from "../domain/books.ts";
import type { Conn } from "../domain/conn.ts";
import { DomainError } from "../domain/errors.ts";
import { insightsOfBook } from "../domain/insights.ts";
import { listMessages } from "../domain/questions.ts";
import { describeReadingMode, readingModeOf } from "../domain/reading-mode.ts";
import { listQuestions } from "../domain/threads.ts";
import { type Brief, refOf } from "./brief.ts";
import { MODE_GUIDANCE } from "./modes.ts";

const MAX_HIGHLIGHTS = 60;
const HIGHLIGHT_CHARS = 120;

const instructions = (keep: { name: string; how: string }) => `帮读者把读这本书的收获整理成 2–3 条 TA 自己的${keep.name}（存为观点）。${keep.how}这是一段对话，分两步：

1. 先提 2–3 个问题，帮 TA 用自己的话说出看法：
   - 针对读者本人：引用 TA 划过的句子或说过的话，问 TA 现在怎么想、会怎么做、同不同意。不考书的内容，不总结。
   - 引用时直接写出原句的几个字，不要把 h:、q: 这样的引用念给读者听。
   - 分清谁说的：划线是作者的原话，读者只是划了它，要说"你划过的「……」"或"书里说「……」"；只有"想法"和读者在问题里说的话，才能说"你写过""你说过"。
2. 结合 TA 的回答起草：
   - 观点是读者的看法与打算，不是书的摘要；优先依据读者的回答和想法，用第一人称「我」。
   - 划线是作者的原话，不要把它写成读者自己的主张；可以写"书里说……，我认为……"。
   - 每条一到三句话，具体，可以被以后的经历检验；不要重复读者已经沉淀的观点。

每条观点都要读者点头才写回，并注明依据的划线或问题（至少一个）：
- 读者自己说出的：bookside insight new --as me --highlight h:… -
- 你起草、读者原样接受的：bookside insight new --as ai --question q:… -
- 读者在你的稿子上改：先 --as ai 写入你的稿，再 bookside insight revise i:… --as me -；推倒重写加 --rewrite。`;

/** 整理成观点所需的材料：读前目的、划线（有想法的优先）与问题（附读者最近的话）、已有观点。 */
export function synthesisBrief(db: Conn, bookId: string): Brief {
  const book = getBook(db, bookId);
  const hl = db
    .select()
    .from(highlights)
    .where(and(eq(highlights.bookId, bookId), isNull(highlights.deletedAtSourceAt)))
    .orderBy(desc(highlights.markedAt))
    .all();
  const noteRows = hl.length
    ? db
        .select()
        .from(notes)
        .where(and(inArray(notes.highlightId, hl.map((h) => h.id)), isNull(notes.deletedAtSourceAt)))
        .all()
    : [];
  const withNotes = new Set(noteRows.map((n) => n.highlightId));
  const picked = [...hl.filter((h) => withNotes.has(h.id)), ...hl.filter((h) => !withNotes.has(h.id))].slice(0, MAX_HIGHLIGHTS);
  const qs = listQuestions(db, { bookId });
  if (picked.length === 0 && qs.length === 0) {
    throw new DomainError("no_basis", `《${book.title}》里还没有划线或问题，没有可整理的材料`);
  }

  const mode = readingModeOf(book);
  const lines = [`书：《${book.title}》${book.author ? `，${book.author}` : ""}`, describeReadingMode(mode)];
  if (book.purpose) lines.push(`读前目的：${book.purpose}`);
  if (picked.length) {
    lines.push("", "读者划过的句子（作者原话），缩进的「想法」才是读者自己写的：");
    for (const h of picked) {
      lines.push(`[${refOf("highlight", h.id)}] ${h.text.replace(/\s+/g, " ").slice(0, HIGHLIGHT_CHARS)}`);
      for (const n of noteRows.filter((x) => x.highlightId === h.id)) lines.push(`    想法：${n.content}`);
    }
  }
  if (qs.length) {
    lines.push("", "读者在这本书里提出的问题（附 TA 最近说的话）：");
    for (const q of qs) {
      const mine = listMessages(db, q.id).filter((m) => m.speaker === "me").slice(-2);
      lines.push(`[${refOf("question", q.id)}] ${q.title}`, ...mine.map((m) => `    读者：${m.content.slice(0, 200)}`));
    }
  }
  const existing = insightsOfBook(db, bookId);
  if (existing.length) lines.push("", "读者已经沉淀的观点（不要重复）：", ...existing.map((i) => `- ${i.content}`));
  return { task: `和读者一起把读《${book.title}》的收获整理成观点`, instructions: instructions(MODE_GUIDANCE[mode.mode].keep), material: lines.join("\n") };
}
