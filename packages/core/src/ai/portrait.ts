// 读书画像：智能体读一遍读者的划线，写下一句值得重读的话、最近在关心的几件事、一段画像和一条建议，显示在查看器首页。
// 引用的每一句都必须是材料里读者划过的原文，写回时逐条核对。
import { type SQL, and, count, desc, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { books, chapters, highlights, notes, portraits, questionStatusChanges, questions as questionsTable } from "../db/schema.ts";
import type { Conn } from "../domain/conn.ts";
import { DomainError } from "../domain/errors.ts";
import { listMessages } from "../domain/questions.ts";
import { READING_MODE_LABELS, readingModeOf } from "../domain/reading-mode.ts";
import { preference } from "../domain/stats.ts";
import { QUESTION_STATUS_LABELS, listQuestions } from "../domain/threads.ts";
import { type Brief, JSON_QUOTE_RULE, ReplyError, matchRef, parseReply, refOf } from "./brief.ts";

const DAY = 24 * 60 * 60 * 1000;
/** 划线少于这些时写不出像样的画像。 */
export const PORTRAIT_MIN_HIGHLIGHTS = 20;
/** 上次写过之后，新划线攒够这些条就重写。 */
const REFRESH_NEW = 30;
/** 或者过了这些天、其间有新划线。 */
const REFRESH_DAYS = 7;
const RECENT = 150;
/** 一口气划了很多的那本书，最多占这么多条，免得画像只剩一本书。 */
const RECENT_PER_BOOK = 30;
const OLDER = 40;
const OLD_DAYS = 30;
const HIGHLIGHT_CHARS = 160;

export type PortraitQuote = { highlightId: string; text: string; bookId: string; bookTitle: string; chapter: string | null; markedAt: Date };

export type Portrait = {
  id: string;
  createdAt: Date;
  highlightCount: number;
  model: string | null;
  /** 一句值得重读的话，以及为什么是现在。 */
  reread?: PortraitQuote & { why: string };
  /** 最近在关心的几件事，各附读者划过的原文。 */
  themes: { title: string; gist: string; quotes: PortraitQuote[] }[];
  /** 一两段画像。 */
  essay: string;
  /** 下一步可以做的一件事；落在某个问题上时带上它。 */
  next: { text: string; questionId?: string; questionTitle?: string };
  /** 和上一份比，有什么变化；第一份没有。 */
  change?: string;
};

/** 存在库里的样子：引用都是完整 id。 */
const Stored = z.object({
  reread: z.object({ highlightId: z.string(), why: z.string() }),
  themes: z.array(z.object({ title: z.string(), gist: z.string(), highlightIds: z.array(z.string()) })),
  essay: z.string(),
  next: z.object({ text: z.string(), questionId: z.string().optional() }),
  change: z.string().optional(),
});

const Reply = z.object({
  reread: z.object({ highlight: z.string(), why: z.string().min(1) }),
  themes: z.array(z.object({ title: z.string().min(1), gist: z.string().default(""), highlights: z.array(z.string()) })).min(1),
  portrait: z.string().min(1),
  next: z.object({ text: z.string().min(1), question: z.string().optional() }),
  change: z.string().optional(),
});

const countHighlights = (db: Conn, where: SQL | undefined) => db.select({ n: count() }).from(highlights).where(where).get()!.n;
const liveCount = (db: Conn) => countHighlights(db, isNull(highlights.deletedAtSourceAt));

function latestRow(db: Conn) {
  return db.select().from(portraits).orderBy(desc(portraits.createdAt)).limit(1).get();
}

/** 该不该（重新）写画像：划线够了，且从没写过、或上次之后新划线攒够了、或隔了一周又有新划线。 */
export function portraitDue(db: Conn, now = new Date()): { due: boolean; newHighlights: number } {
  const total = liveCount(db);
  if (total < PORTRAIT_MIN_HIGHLIGHTS) return { due: false, newHighlights: 0 };
  const last = latestRow(db);
  if (!last) return { due: true, newHighlights: total };
  const fresh = countHighlights(db, and(isNull(highlights.deletedAtSourceAt), gt(highlights.createdAt, last.createdAt)));
  const due = fresh >= REFRESH_NEW || (fresh > 0 && now.getTime() - last.createdAt.getTime() >= REFRESH_DAYS * DAY);
  return { due, newHighlights: fresh };
}

type Row = { id: string; text: string; bookId: string; bookTitle: string; chapter: string | null; markedAt: Date };

function selectHighlights(db: Conn) {
  return db
    .select({ id: highlights.id, text: highlights.text, bookId: highlights.bookId, bookTitle: books.title, chapter: chapters.title, markedAt: highlights.markedAt })
    .from(highlights)
    .innerJoin(books, eq(books.id, highlights.bookId))
    .leftJoin(chapters, eq(chapters.id, highlights.chapterId));
}

/** 材料里的划线：最近划的一批（每本书有上限），加上更早的一些（写过想法的优先、各本书轮流），给「值得重读的话」挑。 */
function materialHighlights(db: Conn, now: Date): { recent: Row[]; older: Row[] } {
  const perBook = new Map<string, number>();
  const recent: Row[] = [];
  for (const r of selectHighlights(db).where(isNull(highlights.deletedAtSourceAt)).orderBy(desc(highlights.markedAt)).all()) {
    const n = perBook.get(r.bookId) ?? 0;
    if (n >= RECENT_PER_BOOK) continue;
    perBook.set(r.bookId, n + 1);
    recent.push(r);
    if (recent.length >= RECENT) break;
  }
  const seen = new Set(recent.map((r) => r.id));
  const cutoff = new Date(now.getTime() - OLD_DAYS * DAY);
  const pool = selectHighlights(db)
    .where(and(isNull(highlights.deletedAtSourceAt), lt(highlights.markedAt, cutoff)))
    .all()
    .filter((r) => !seen.has(r.id));
  const noted = notedSet(db, pool.map((r) => r.id));
  // 每本书里写过想法的在前，其余按 id 打散（稳定，便于重试时拿到同一份材料）；各本书轮流取。
  const byBook = new Map<string, Row[]>();
  for (const r of pool.sort((a, b) => Number(noted.has(b.id)) - Number(noted.has(a.id)) || a.id.localeCompare(b.id))) {
    byBook.set(r.bookId, [...(byBook.get(r.bookId) ?? []), r]);
  }
  const queues = [...byBook.values()];
  const older: Row[] = [];
  for (let i = 0; older.length < OLDER && queues.some((q) => i < q.length); i++) {
    for (const q of queues) if (i < q.length && older.length < OLDER) older.push(q[i]!);
  }
  return { recent: recent.sort((a, b) => b.markedAt.getTime() - a.markedAt.getTime()), older };
}

function notedSet(db: Conn, ids: string[]): Set<string> {
  if (ids.length === 0) return new Set();
  return new Set(
    db.select({ h: notes.highlightId }).from(notes).where(and(inArray(notes.highlightId, ids), isNull(notes.deletedAtSourceAt))).all().map((r) => r.h),
  );
}

function notesOf(db: Conn, ids: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  for (const n of db.select().from(notes).where(and(inArray(notes.highlightId, ids), isNull(notes.deletedAtSourceAt))).all()) {
    out.set(n.highlightId, [...(out.get(n.highlightId) ?? []), n.content]);
  }
  return out;
}

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function portraitBrief(db: Conn, now = new Date()): Brief {
  const total = liveCount(db);
  if (total < PORTRAIT_MIN_HIGHLIGHTS) {
    throw new DomainError("no_basis", `一共只有 ${total} 条划线，攒到 ${PORTRAIT_MIN_HIGHLIGHTS} 条再写读书画像`);
  }
  const { recent, older } = materialHighlights(db, now);
  const ns = notesOf(db, [...recent, ...older].map((r) => r.id));
  const modeOf = new Map(db.select().from(books).all().map((b) => [b.id, READING_MODE_LABELS[readingModeOf(b).mode]]));
  const line = (r: Row) => {
    const out = [`[${refOf("highlight", r.id)}] ${day(r.markedAt)} ${r.text.replace(/\s+/g, " ").slice(0, HIGHLIGHT_CHARS)}`];
    for (const n of ns.get(r.id) ?? []) out.push(`    想法：${n}`);
    return out;
  };
  const byBook = (rows: Row[]) => {
    const groups = new Map<string, Row[]>();
    for (const r of rows) groups.set(r.bookId, [...(groups.get(r.bookId) ?? []), r]);
    return [...groups.values()].flatMap((g) => [`【《${g[0]!.bookTitle}》· ${modeOf.get(g[0]!.bookId)}】`, ...g.flatMap(line)]);
  };

  const lines = [`今天是 ${day(now)}。读者一共划了 ${total} 条线。`];
  const prefs = preference(db);
  if (prefs.length) lines.push(`按书的分类数划线：${prefs.map((p) => `${p.label} ${p.count}`).join("、")}。`);
  lines.push("", `最近划的 ${recent.length} 条（作者原话，按书分组，一本书最多 ${RECENT_PER_BOOK} 条；缩进的「想法」是读者自己写的）：`, ...byBook(recent));
  if (older.length) lines.push("", `更早的划线（${OLD_DAYS} 天以前，适合从中挑「值得重读的一句」）：`, ...byBook(older));

  const open = listQuestions(db).filter((q) => q.status !== "resolved" && q.status !== "abandoned");
  if (open.length) {
    lines.push("", "读者还在想的问题（附 TA 最近说的话）：");
    for (const q of open) {
      const mine = listMessages(db, q.id).filter((m) => m.speaker === "me").at(-1);
      lines.push(`[${refOf("question", q.id)}] ${q.title}${mine ? `\n    读者：${mine.content.slice(0, 160)}` : ""}`);
    }
  }
  const last = latestPortrait(db);
  const since = last?.createdAt ?? new Date(now.getTime() - 30 * DAY);
  const moved = db
    .select({ title: questionsTable.title, from: questionStatusChanges.from, to: questionStatusChanges.to, at: questionStatusChanges.createdAt })
    .from(questionStatusChanges)
    .innerJoin(questionsTable, eq(questionsTable.id, questionStatusChanges.questionId))
    .where(gt(questionStatusChanges.createdAt, since))
    .orderBy(questionStatusChanges.createdAt)
    .all();
  if (moved.length) {
    lines.push("", `${last ? "上一份画像之后" : "最近 30 天"}，读者改了这些问题的状态：`, ...moved.map((m) => `- ${day(m.at)}「${m.title}」${QUESTION_STATUS_LABELS[m.from]} → ${QUESTION_STATUS_LABELS[m.to]}`));
  }
  if (last) {
    lines.push("", `上一份画像（${day(last.createdAt)}，当时一共 ${last.highlightCount} 条划线）。这次换一句重读的话；主题有变化就照实写：`);
    if (last.reread) lines.push(`重读的话：[${refOf("highlight", last.reread.highlightId)}] ${last.reread.text.slice(0, 60)}`);
    lines.push(`主题：${last.themes.map((t) => t.title).join("；")}`, `画像：${last.essay.replace(/\s+/g, " ")}`);
  }

  return {
    task: "给读者写一份读书画像",
    instructions: `读一遍材料，写一份关于读者的读书画像，显示在 TA 的书畔首页。写的是这个读者，不是书。分这几部分：

1. reread：一句值得重读的话。从材料里挑一条读者划过的线（优先更早的划线、写过想法的），和 TA 最近读的东西有联系。why 用两句话对读者说为什么现在值得重读，点出它和最近哪些划线或问题有关。
2. themes：TA 最近在关心的 2–3 件事。title 用读者在意的问题或一个短语来命名（16 字以内），不要用书名或学科名；gist 一句话说 TA 是怎么表现出这份关心的（30 字以内，如「你反复停在……的段落上」）；highlights 附 2–3 条最能说明它的划线，最好来自不同的书。
3. portrait：一两段话（共 120–220 字，段落之间空一行），说说 TA 怎么读书、在意什么，比如偏爱哪类段落、哪里写想法多、哪里只划不写、问题从哪本书开始又在哪里找答案。每个判断都要有材料里的依据。
4. next：下一步可以做的一件具体的事（60 字以内）。最好落在一个还在想的问题上，用 question 带上它的引用；没有合适的问题就省略 question。
5. change：材料里有上一份画像时，用一句话说说和那时比有什么变化（50 字以内，如「上个月你多在问……，这几周转向了……」），要有新划线作依据；没什么变化就照实说没变。没有上一份时省略。

要求：
- 只用材料里的引用号，不要编造；划线是作者的原话，读者只是划了它，只有「想法」和问题里的话是读者自己说的。
- 用「你」称呼读者。不恭维，不评判 TA 读得好不好，不总结书的内容。
- 叙事类的书只谈读者划到的部分，不剧透后面的情节。`,
    material: lines.join("\n"),
    reply: `只写 JSON（${JSON_QUOTE_RULE}）：{"reread":{"highlight":"h:a1b2c3d4","why":"……"},"themes":[{"title":"……","gist":"……","highlights":["h:……","h:……"]}],"portrait":"……","next":{"text":"……","question":"q:e5f6a7b8"},"change":"……"}`,
    writeBack: "bookside portrait --write -",
  };
}

/** 写回画像：核对每条引用都是读者的划线，引用错的划线丢掉，一条都对不上的主题丢掉。 */
export function writePortrait(db: Conn, reply: string, opts: { by?: string } = {}, now = new Date()): Portrait {
  const r = parseReply(Reply, reply);
  const live = db.select({ id: highlights.id }).from(highlights).where(isNull(highlights.deletedAtSourceAt)).all();
  const reread = matchRef(r.reread.highlight, "highlight", live);
  if (!reread) throw new ReplyError(`「值得重读的话」引用的 ${r.reread.highlight} 不是材料里的划线`);
  const themes = r.themes
    .map((t) => ({ title: t.title.trim(), gist: t.gist.trim(), highlightIds: t.highlights.map((h) => matchRef(h, "highlight", live)?.id).filter((x): x is string => !!x) }))
    .filter((t) => t.highlightIds.length > 0);
  if (themes.length === 0) throw new ReplyError("主题引用的划线都对不上材料里的引用号");
  const question = r.next.question ? matchRef(r.next.question, "question", db.select({ id: questionsTable.id }).from(questionsTable).all()) : undefined;
  const content: z.infer<typeof Stored> = {
    reread: { highlightId: reread.id, why: r.reread.why.trim() },
    themes,
    essay: r.portrait.trim(),
    next: { text: r.next.text.trim(), ...(question ? { questionId: question.id } : {}) },
    ...(r.change?.trim() && latestRow(db) ? { change: r.change.trim() } : {}),
  };
  db.insert(portraits).values({ content: JSON.stringify(content), highlightCount: live.length, model: opts.by ?? null, createdAt: now }).run();
  return latestPortrait(db)!;
}

/** 最新的一份画像，引用展开成原文；划线后来在源端删掉的就不显示。 */
export function latestPortrait(db: Conn): Portrait | undefined {
  const row = latestRow(db);
  return row ? hydrate(db, row) : undefined;
}

/** 写过的所有画像，新的在前：看自己这段时间的变化。 */
export function listPortraits(db: Conn): Portrait[] {
  return db.select().from(portraits).orderBy(desc(portraits.createdAt)).all().map((row) => hydrate(db, row));
}

function hydrate(db: Conn, row: typeof portraits.$inferSelect): Portrait {
  const c = Stored.parse(JSON.parse(row.content));
  const ids = [c.reread.highlightId, ...c.themes.flatMap((t) => t.highlightIds)];
  const quotes = new Map(
    selectHighlights(db)
      .where(and(inArray(highlights.id, ids), isNull(highlights.deletedAtSourceAt)))
      .all()
      .map((h) => [h.id, { highlightId: h.id, text: h.text, bookId: h.bookId, bookTitle: h.bookTitle, chapter: h.chapter || null, markedAt: h.markedAt }]),
  );
  const rereadQuote = quotes.get(c.reread.highlightId);
  const q = c.next.questionId ? db.select().from(questionsTable).where(eq(questionsTable.id, c.next.questionId)).get() : undefined;
  return {
    id: row.id,
    createdAt: row.createdAt,
    highlightCount: row.highlightCount,
    model: row.model,
    reread: rereadQuote ? { ...rereadQuote, why: c.reread.why } : undefined,
    themes: c.themes
      .map((t) => ({ title: t.title, gist: t.gist, quotes: t.highlightIds.map((id) => quotes.get(id)).filter((x): x is PortraitQuote => !!x) }))
      .filter((t) => t.quotes.length > 0),
    essay: c.essay,
    next: { text: c.next.text, ...(q ? { questionId: q.id, questionTitle: q.title } : {}) },
    ...(c.change ? { change: c.change } : {}),
  };
}
