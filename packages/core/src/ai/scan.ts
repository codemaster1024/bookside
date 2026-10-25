// 回溯（Backscan）：为一个问题去读者**已有的**划线里找关联。跨书激活只看新内容，后来提出的问题靠这里补上旧划线。
// 分两步交给智能体：先请它想检索词，本地按词筛出候选，再请它判断哪几条真正回应了问题。
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { LINK_KINDS, books, highlights, messages, notes } from "../db/schema.ts";
import type { Conn } from "../domain/conn.ts";
import { insightsOfQuestion } from "../domain/insights.ts";
import { type Link, linksBetween, proposeLink } from "../domain/links.ts";
import { getQuestion } from "../domain/questions.ts";
import { describeOrigin } from "../domain/threads.ts";
import { type Brief, JSON_QUOTE_RULE, matchRef, parseReply, refOf } from "./brief.ts";

/** 交给智能体判断的候选划线上限。 */
const MAX_CANDIDATES = 60;
const HIGHLIGHT_CHARS = 160;
const MAX_PROPOSALS = 5;

const Reply = z.object({
  links: z.array(z.object({ from: z.string(), kind: z.enum(LINK_KINDS), reason: z.string().min(1) })),
});

/** 问题本身加上读者目前的看法（最新观点，否则最近一次发言）。 */
function describeQuestion(db: Conn, questionId: string) {
  const q = getQuestion(db, questionId);
  const origin = describeOrigin(db, q);
  const gist =
    insightsOfQuestion(db, q.id)[0]?.content ??
    db
      .select({ content: messages.content })
      .from(messages)
      .where(and(eq(messages.questionId, q.id), eq(messages.speaker, "me")))
      .orderBy(desc(messages.createdAt))
      .get()?.content;
  const lines = [`问题：${q.title}`];
  if (origin) lines.push(`起源：《${origin.bookTitle}》`);
  if (gist) lines.push(`读者目前的看法：${gist.slice(0, 200)}`);
  return { q, originBookId: origin?.bookId ?? null, text: lines.join("\n") };
}

/** 按命中的关键词个数给划线（连同其想法）打分，取最高的若干条；同分时新的在前。 */
export function keywordCandidates(db: Conn, keywords: string[], excludeBookId: string | null, limit = MAX_CANDIDATES) {
  const words = [...new Set(keywords.map((k) => k.trim()).filter((k) => k.length >= 2))];
  if (words.length === 0) return [];
  const rows = db
    .select({ id: highlights.id, text: highlights.text, bookId: books.id, bookTitle: books.title, markedAt: highlights.markedAt })
    .from(highlights)
    .innerJoin(books, eq(books.id, highlights.bookId))
    .where(isNull(highlights.deletedAtSourceAt))
    .orderBy(desc(highlights.markedAt))
    .all();
  const noteRows = db.select().from(notes).where(isNull(notes.deletedAtSourceAt)).all();
  const notesOf = new Map<string, string[]>();
  for (const n of noteRows) notesOf.set(n.highlightId, [...(notesOf.get(n.highlightId) ?? []), n.content]);

  return rows
    .filter((r) => r.bookId !== excludeBookId)
    .map((r) => {
      const ns = notesOf.get(r.id) ?? [];
      const haystack = [r.text, ...ns].join("\n");
      return { ...r, notes: ns, score: words.filter((w) => haystack.includes(w)).length };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** 第一步：请智能体想检索词。 */
export function scanKeywordsBrief(db: Conn, questionId: string): Brief {
  const { q, text } = describeQuestion(db, questionId);
  return {
    task: `为问题「${q.title}」想检索词，好在读者已有的划线里找回应`,
    instructions: `读者有一个问题，要在 TA 上万条读书划线里检索可能回应它的段落。请给出 10–15 个中文检索词：
- 每个 2–6 个字，是书里原文可能出现的词，而不是问题的复述。
- 覆盖问题的核心概念、同义说法、相关现象和可能的解释方向。
想好后用下面的命令取第二步的材料，检索词用逗号分开。`,
    material: text,
    writeBack: `bookside q scan ${refOf("question", q.id)} --keywords 词1,词2,词3`,
  };
}

/** 第二步：按检索词筛出候选划线，请智能体判断哪几条真正回应了问题。 */
export function scanBrief(db: Conn, questionId: string, keywords: string[]): Brief & { candidates: number } {
  const { q, originBookId, text } = describeQuestion(db, questionId);
  const found = keywordCandidates(db, keywords, originBookId);
  const lines = [text, "", `检索词：${keywords.join("、")}`, "", found.length ? "读者在其他书里的划线：" : "这些检索词没有命中任何划线，可以换一组词再试。"];
  for (const h of found) {
    lines.push(`[${refOf("highlight", h.id)}] 《${h.bookTitle}》：${h.text.replace(/\s+/g, " ").slice(0, HIGHLIGHT_CHARS)}`);
    for (const n of h.notes) lines.push(`    读者的想法：${n.slice(0, 120)}`);
  }
  if (found.length) lines.push("", `最多提议 ${MAX_PROPOSALS} 条。`);
  return {
    task: `在读者已有的划线里，找真正回应「${q.title}」的段落`,
    instructions: `你是「书畔」的关联助手。读者提出了一个问题，下面是 TA 以前在其他书里划过的线（按关键词粗筛，大多数并不相关）。
挑出真正回应这个问题的划线，并说明关系：
- answers（回答）：给出了答案或答案的关键线索
- supports（印证）：支持读者目前的看法
- conflicts（冲突）：挑战读者目前的看法
- extends（延伸）：把问题推向一个新的方向

要求：
- 宁缺毋滥：只有当你能说出"这段话的哪个意思怎样回应了问题的哪一点"时才提议；只是话题相近、出现了同一个词，都不算。一条都不提是正常结果。
- reason 用一句中文，点出划线里的关键说法和它回应的那一点，供读者判断是否接受。
- 写回之后，把每条提议和理由转述给读者，请 TA 确认或拒绝。`,
    material: lines.join("\n"),
    reply: `只写 JSON（${JSON_QUOTE_RULE}）：{"links":[{"from":"h:a1b2c3d4","kind":"answers","reason":"……"}]}；没有就写 {"links":[]}`,
    writeBack: `bookside q scan ${refOf("question", q.id)} --write -`,
    candidates: found.length,
  };
}

/** 写回回溯的提议：只接受问题起源以外的书里的划线；已有任何关联或提议（含被拒绝的）的不再提。 */
export function writeScan(db: Conn, questionId: string, reply: string, now = new Date()): Link[] {
  const { q, originBookId } = describeQuestion(db, questionId);
  const parsed = parseReply(Reply, reply);
  const among = db
    .select({ id: highlights.id, bookId: highlights.bookId })
    .from(highlights)
    .where(isNull(highlights.deletedAtSourceAt))
    .all()
    .filter((h) => h.bookId !== originBookId);
  const target = { type: "question" as const, id: q.id };
  return db.transaction((tx) => {
    const out: Link[] = [];
    const seen = new Set<string>();
    for (const l of parsed.links) {
      const h = matchRef(l.from, "highlight", among);
      if (!h || seen.has(h.id) || out.length >= MAX_PROPOSALS) continue;
      seen.add(h.id);
      const from = { type: "highlight" as const, id: h.id };
      if (linksBetween(tx, from, target).length) continue;
      out.push(proposeLink(tx, { from, to: target, kind: l.kind, reason: l.reason.trim() }, now));
    }
    return out;
  });
}
