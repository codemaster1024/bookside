import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import { highlights } from "../db/schema.ts";
import { getBook } from "../domain/books.ts";
import type { Conn } from "../domain/conn.ts";
import { type Probe, addProbe } from "../domain/probes.ts";
import { describePosition, describeReadingMode, readingModeOf } from "../domain/reading-mode.ts";
import { type Brief, JSON_QUOTE_RULE, matchRef, parseReply, refOf } from "./brief.ts";
import { MODE_GUIDANCE, spoilerRule } from "./modes.ts";
import { loadCandidates, markConsidered, newTargets, renderCandidates } from "./candidates.ts";

/** 给智能体看的同书既往划线条数上限，用于发现矛盾与呼应。 */
const CONTEXT_HIGHLIGHTS = 30;

const Reply = z.object({
  probes: z.array(z.object({ target: z.string(), probe: z.string().min(1) })),
});

const instructions = (probe: string) => `你是「书畔」里陪读者深度读书的对话者，不是答案机。
从读者刚留下的划线和想法中，挑出最值得追问的几处，各写一条追问。

追问的要求：
- 针对读者本人：问 TA 为什么划这句、怎么看，而不是考 TA 书的内容。
- ${probe}
- 不总结、不解释、不给答案；一条只问一件事，60 字以内，用中文。
- 宁缺毋滥：没有值得追问的就少写，一条都不写也可以，最多不超过给定上限。优先挑读者写了想法的、与既往划线有张力的。
- target 只能是标了「新」的划线（h:）或想法（n:）。
- 材料里写了这本书的读法；读法未定时先按思辨写，并判断这本书该用哪种读法（思辨 / 实践 / 知识 / 叙事），用 bookside book mode 写回。`;

/** 为一本书里尚未考虑过的划线和想法写追问：交出材料。 */
export function probeBrief(db: Conn, bookId: string, opts: { perBookLimit: number }, now = new Date()): Brief {
  const book = getBook(db, bookId);
  const candidates = loadCandidates(db, bookId, "probe", now);
  const earlier = db
    .select({ text: highlights.text })
    .from(highlights)
    .where(and(eq(highlights.bookId, bookId), isNotNull(highlights.probeConsideredAt), isNull(highlights.deletedAtSourceAt)))
    .orderBy(desc(highlights.markedAt))
    .limit(CONTEXT_HIGHLIGHTS)
    .all()
    .reverse();

  const mode = readingModeOf(book);
  const position = describePosition(db, bookId);
  const lines = [`书：《${book.title}》${book.author ? `，${book.author}` : ""}`, describeReadingMode(mode)];
  if (position) lines.push(`读者${position}`);
  if (book.purpose) lines.push(`读者的读前目的：${book.purpose}`);
  if (earlier.length) {
    lines.push("", "读者在这本书里更早的划线（仅供参考，不可作为 target）：");
    for (const e of earlier) lines.push(`- ${e.text}`);
  }
  lines.push("", "新内容：", ...renderCandidates(candidates), "", `最多写 ${opts.perBookLimit} 条追问。`);
  return {
    task: `为《${book.title}》的新划线和想法写追问`,
    instructions: instructions(MODE_GUIDANCE[mode.mode].probe) + spoilerRule(mode.mode, position),
    material: lines.join("\n"),
    reply: `只写 JSON（${JSON_QUOTE_RULE}）：{"probes":[{"target":"h:a1b2c3d4","probe":"……"}]}；没有值得追问的就写 {"probes":[]}`,
    writeBack: `bookside probes write ${refOf("book", bookId)} --as-of ${now.getTime()} -`,
  };
}

/**
 * 写回追问：只接受 brief 里标了新的对象，至多 perBookLimit 条。
 * 写回后这一批候选全部记为已考虑（无论是否选中）；brief 之后新同步进来的留到下一批。
 */
export function writeProbes(
  db: Conn,
  bookId: string,
  reply: string,
  opts: { perBookLimit: number; asOf: Date },
  now = new Date(),
): Probe[] {
  getBook(db, bookId);
  const parsed = parseReply(Reply, reply);
  const candidates = loadCandidates(db, bookId, "probe", opts.asOf);
  const targets = newTargets(candidates);
  const used = new Set<string>();
  return db.transaction((tx) => {
    const out: Probe[] = [];
    for (const p of parsed.probes) {
      const target = matchRef(p.target, "highlight", targets.highlights) ?? matchRef(p.target, "note", targets.notes);
      if (!target || used.has(target.id) || out.length >= opts.perBookLimit) continue;
      used.add(target.id);
      out.push(addProbe(tx, { target: { type: target.type, id: target.id }, content: p.probe.trim() }, now));
    }
    markConsidered(tx, candidates, "probe", now);
    return out;
  });
}
