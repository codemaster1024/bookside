import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { LINK_KINDS, messages, questions } from "../db/schema.ts";
import { getBook } from "../domain/books.ts";
import type { Conn } from "../domain/conn.ts";
import { insightsOfQuestion } from "../domain/insights.ts";
import { type Link, linksBetween, proposeLink } from "../domain/links.ts";
import { QUESTION_STATUS_LABELS, describeOrigin } from "../domain/threads.ts";
import { type Brief, JSON_QUOTE_RULE, matchRef, parseReply, refOf } from "./brief.ts";
import { type Candidate, loadCandidates, markConsidered, newTargets, renderCandidates } from "./candidates.ts";

/** 一份 brief 最多带多少条候选划线；更多的留到下一份。 */
const BATCH_SIZE = 40;
/** 问题现状摘要的长度上限。 */
const GIST_CHARS = 150;
/** 每份 brief 最多提议几条。 */
const MAX_PROPOSALS = 3;

const Reply = z.object({
  links: z.array(z.object({ from: z.string(), question: z.string(), kind: z.enum(LINK_KINDS), reason: z.string().min(1) })),
});

const INSTRUCTIONS = `你是「书畔」的关联助手。读者在不同的书里提出过一些问题；现在 TA 在读新内容。
判断哪些新划线或想法与 TA 在**其他书**里的旧问题真正相关，并说明关系：
- answers（回答）：给出了答案或答案的关键线索
- supports（印证）：支持 TA 目前的看法
- conflicts（冲突）：挑战 TA 目前的看法
- extends（延伸）：把问题推向一个新的方向

要求：
- 宁缺毋滥：只有当你能说出"这段话的哪个意思，怎样回应了问题的哪一点"时才提议；只是话题相近、出现了同一个词，都不算。一条都不提是正常结果。
- 下面列出的问题都起源于其他书或是长期问题，可以放心关联。
- reason 用一句中文，点出划线里的关键说法和它回应的那一点，供读者判断是否接受。
- from 只能是标了「新」的划线（h:）或想法（n:），question 是问题（q:）。`;

type QuestionRow = { id: string; line: string };

/** 不起源于这本书的问题的一行摘要：状态、起源、读者目前的看法（最新观点，否则最近一次发言）。 */
function otherQuestions(db: Conn, bookId: string): QuestionRow[] {
  return db
    .select()
    .from(questions)
    .orderBy(desc(questions.createdAt))
    .all()
    .flatMap((q) => {
      const origin = describeOrigin(db, q);
      if (origin?.bookId === bookId) return [];
      const gist =
        insightsOfQuestion(db, q.id)[0]?.content ??
        db
          .select({ content: messages.content })
          .from(messages)
          .where(and(eq(messages.questionId, q.id), eq(messages.speaker, "me")))
          .orderBy(desc(messages.createdAt))
          .get()?.content;
      const where = origin ? `起源《${origin.bookTitle}》` : "长期问题";
      const line = [
        `[${refOf("question", q.id)}] ${q.title}（${QUESTION_STATUS_LABELS[q.status]}，${where}）`,
        ...(gist ? [`    读者目前的看法：${gist.slice(0, GIST_CHARS)}`] : []),
      ].join("\n");
      return [{ id: q.id, line }];
    });
}

const batchOf = (db: Conn, bookId: string, asOf: Date): Candidate[] => loadCandidates(db, bookId, "activation", asOf).slice(0, BATCH_SIZE);

/**
 * 跨书激活：把一本书里尚未考虑过的划线和想法连同其他书里的问题交出去。
 * 没有可关联的问题时返回空，调用方直接把候选记为已考虑（见 settleTodos）。
 */
export function activationBrief(db: Conn, bookId: string, now = new Date()): Brief | undefined {
  const book = getBook(db, bookId);
  const qs = otherQuestions(db, bookId);
  if (qs.length === 0) return undefined;
  const lines = [
    "读者的问题：",
    ...qs.map((q) => q.line),
    "",
    `新内容，来自《${book.title}》${book.author ? ` ${book.author}` : ""}：`,
    ...renderCandidates(batchOf(db, bookId, now)),
    "",
    `最多提议 ${MAX_PROPOSALS} 条。`,
  ];
  return {
    task: `看看《${book.title}》的新内容有没有回应其他书里的旧问题`,
    instructions: INSTRUCTIONS,
    material: lines.join("\n"),
    reply: `只写 JSON（${JSON_QUOTE_RULE}）：{"links":[{"from":"h:a1b2c3d4","question":"q:e5f6a7b8","kind":"answers","reason":"……"}]}；没有就写 {"links":[]}`,
    writeBack: `bookside activate write ${refOf("book", bookId)} --as-of ${now.getTime()} -`,
  };
}

/** 写回跨书激活的提议；这一批候选随后记为已考虑。已有任何关联或提议（含被拒绝的）的一对不再提。 */
export function writeActivations(db: Conn, bookId: string, reply: string, opts: { asOf: Date }, now = new Date()): Link[] {
  getBook(db, bookId);
  const parsed = parseReply(Reply, reply);
  const candidates = batchOf(db, bookId, opts.asOf);
  const targets = newTargets(candidates);
  const qs = otherQuestions(db, bookId);
  const seen = new Set<string>();
  return db.transaction((tx) => {
    const out: Link[] = [];
    for (const l of parsed.links) {
      const from = matchRef(l.from, "highlight", targets.highlights) ?? matchRef(l.from, "note", targets.notes);
      const q = matchRef(l.question, "question", qs);
      if (!from || !q || out.length >= MAX_PROPOSALS) continue;
      const key = `${from.id}→${q.id}`;
      const to = { type: "question" as const, id: q.id };
      if (seen.has(key) || linksBetween(tx, from, to).length) continue;
      seen.add(key);
      out.push(proposeLink(tx, { from, to, kind: l.kind, reason: l.reason.trim() }, now));
    }
    markConsidered(tx, candidates, "activation", now);
    return out;
  });
}
