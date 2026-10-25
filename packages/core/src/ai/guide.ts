import { and, asc, desc, eq, inArray, isNull, like } from "drizzle-orm";
import { books, chapters, guides, highlights, notes } from "../db/schema.ts";
import type { GuideBasis, GuideDepth, ReadingMode } from "../db/schema.ts";
import { getBook } from "../domain/books.ts";
import type { Conn } from "../domain/conn.ts";
import { DomainError } from "../domain/errors.ts";
import type { Guide } from "../domain/guides.ts";
import { type Probe, addProbe } from "../domain/probes.ts";
import { READING_MODE_LABELS, describePosition, describeReadingMode, readingModeOf } from "../domain/reading-mode.ts";
import { QUESTION_STATUS_LABELS, describeOrigin, listQuestions } from "../domain/threads.ts";
import type { TocEntry, WereadCatalog } from "../weread/client.ts";
import { upsertChapters } from "../weread/sync.ts";
import { type Brief, ReplyError, refOf } from "./brief.ts";
import { MODE_GUIDANCE, spoilerRule } from "./modes.ts";

const TOC_LIMIT = 200;
const INTRO_CHARS = 600;
const OWN_HIGHLIGHTS = 30;
/** 没有目录时，读者的划线是主要依据，多给一些。 */
const OWN_HIGHLIGHTS_NO_TOC = 80;
const OWN_HIGHLIGHT_CHARS = 80;
const OPEN_QUESTIONS = 30;
const PROBES = 3;

/** 依据与引用的规则；有没有微信读书的目录，说法不同。 */
function commonRules(hasToc: boolean, probes: number): string {
  const basis = hasToc
    ? `- 你确实了解这本书的内容（熟悉其核心论点与结构），写「熟悉」；
- 你只能依靠下面给出的目录、简介和热门划线，写「有限」，此时只根据这些材料写，不补充你不确定的内容，并在开头一句话说明依据有限。`
    : `- 你确实了解这本书的内容（熟悉其核心论点与结构），写「熟悉」；
- 你对这本书不熟，写「有限」：只根据下面读者的划线和想法来讲，开头一句话说明"我对这本书不熟，以下只根据你的划线"，不编造书里的内容。`;
  const sources = hasToc
    ? "- 只使用目录里真实存在的章节名；引用原文时只用下面给出的热门划线或读者划线，不要自己复述书中原文。"
    : "- 这本书没有拿到目录：不写具体的章节名，「怎么读」「先读哪部分」写读这本书的方法建议；引用原文时只用下面给出的读者划线，不要自己复述书中原文。";
  return `第一行必须单独写「依据：熟悉」或「依据：有限」：
${basis}
然后用 Markdown 写正文，二级标题见下。
${sources}
- 给读者的建议必须符合这本书自己的主张：写之前对照你写的核心观点自查，不能提出书中反对的做法（例如一本主张"小到不可能失败、断了也没关系"的书，不能建议"绝不中断"）。
- 最后一节「## 追问」写 ${probes} 条，每条一行，以「- 」开头：针对读者本人，引导 TA 带着问题去读或去想，不考书的内容。
- 用中文。`;
}

function instructions(scope: "quick" | "book" | "chapter", mode: ReadingMode, hasToc: boolean): string {
  const g = MODE_GUIDANCE[mode];
  const [what, sections, length, probes] =
    scope === "quick"
      ? ["为读者写一本书的速览：一页看完，帮 TA 决定读不读、先读哪部分", g.quickSections, "全文 400–600 字，每节一两句到一小段。", 2]
      : scope === "book"
        ? ["为读者写一本书的全书导读：帮 TA 决定读不读、读哪部分，或在不读完时理解这本书", g.bookSections, "全文 1500–2500 字。", PROBES]
        : ["为读者写一本书中某一章的章节导读：帮 TA 在不读这一章时理解它，或决定要不要细读", g.chapterSections, "全文 800–1500 字。", PROBES];
  return `你是「书畔」的导读作者，${what}。导读是 AI 内容，最终要把读者带回自己的思考。

${commonRules(hasToc, probes)}

这本书的读法是${READING_MODE_LABELS[mode]}，正文各节：
${sections}
## 追问

${length}`;
}

export type GuideResult = { guide: Guide; probes: Probe[] };

/** 解析写回的导读：首行的依据、正文、以及「追问」一节的条目。 */
export function parseGuide(text: string): { basis: GuideBasis; content: string; probes: string[] } {
  const body = text.replace(/^```(?:markdown)?\s*|\s*```\s*$/g, "").trim();
  const firstLine = body.split("\n", 1)[0] ?? "";
  const m = firstLine.match(/依据[:：]\s*(熟悉|有限)/);
  if (!m) throw new ReplyError(`导读第一行要写「依据：熟悉」或「依据：有限」，现在是：${firstLine.slice(0, 80)}`);
  const content = body.slice(firstLine.length).trim();
  const section = content.split(/^#{1,3}\s*追问\s*$/m)[1] ?? "";
  const probes = section
    .split("\n")
    .map((l) => l.match(/^\s*(?:[-*]|\d+[.、)])\s+(.+)$/)?.[1]?.trim())
    .filter((l): l is string => !!l)
    .slice(0, PROBES);
  return { basis: m[1] === "熟悉" ? "familiar" : "limited", content, probes };
}

function renderToc(toc: TocEntry[], targetUid?: number): string[] {
  return toc
    .slice(0, TOC_LIMIT)
    .map((c) => `${"  ".repeat(Math.max(0, c.level - 1))}- ${c.title}${c.chapterUid === targetUid ? "  ← 本章" : ""}`);
}

/**
 * 为一本书写速览或全书导读，或为其中一章写章节导读（给 chapterUid）：交出材料。
 * 书在微信读书上时，材料是目录、简介与热门划线，加上读者自己的划线和问题；
 * 不在（如 Kindle、本地的书）或拿不到目录时，以读者的划线和想法为主要依据。章节导读需要目录。
 */
export async function guideBrief(
  db: Conn,
  catalog: WereadCatalog | undefined,
  input: { bookId: string; chapterUid?: number; depth?: GuideDepth },
): Promise<Brief> {
  const book = getBook(db, input.bookId);
  const depth: GuideDepth = input.chapterUid === undefined ? (input.depth ?? "full") : "full";
  const toc = book.wereadBookId && catalog ? await catalog.toc(book.wereadBookId).catch(() => [] as TocEntry[]) : [];
  const hasToc = toc.length > 0;
  const chapterIds = hasToc ? db.transaction((tx) => upsertChapters(tx, book.id, toc)) : new Map<number, string>();

  let chapterId: string | undefined;
  let chapter: TocEntry | undefined;
  if (input.chapterUid !== undefined) {
    if (!hasToc) throw new DomainError("no_basis", `拿不到《${book.title}》的目录，写不了章节导读；可以写全书导读或速览`);
    chapterId = chapterIds.get(input.chapterUid);
    chapter = toc.find((c) => c.chapterUid === input.chapterUid);
    if (!chapterId || !chapter) throw new DomainError("not_found", `《${book.title}》没有这一章`);
  }

  const [info, popular] =
    hasToc && catalog && book.wereadBookId
      ? await Promise.all([
          catalog.bookInfo(book.wereadBookId).catch(() => undefined),
          catalog.popularHighlights(book.wereadBookId, input.chapterUid).catch(() => []),
        ])
      : [undefined, []];
  if (info?.cover && !book.cover) db.update(books).set({ cover: info.cover }).where(eq(books.id, book.id)).run();
  const own = db
    .select({ id: highlights.id, text: highlights.text })
    .from(highlights)
    .where(
      and(
        eq(highlights.bookId, book.id),
        isNull(highlights.deletedAtSourceAt),
        chapterId ? eq(highlights.chapterId, chapterId) : undefined,
      ),
    )
    .orderBy(desc(highlights.markedAt))
    .limit(hasToc ? OWN_HIGHLIGHTS : OWN_HIGHLIGHTS_NO_TOC)
    .all();
  const ownNotes = hasToc || own.length === 0 ? [] : db.select().from(notes).where(and(inArray(notes.highlightId, own.map((h) => h.id)), isNull(notes.deletedAtSourceAt))).all();
  const open = listQuestions(db, { status: ["unexplored", "exploring", "tentative"] }).slice(0, OPEN_QUESTIONS);

  const mode = readingModeOf(book);
  const position = describePosition(db, book.id);
  const lines = [`书：《${book.title}》${book.author ? `，${book.author}` : ""}`, describeReadingMode(mode)];
  if (position) lines.push(`读者${position}`);
  if (chapter) lines.push(`要写导读的章节：${chapter.title}`);
  if (info?.intro) lines.push("", `简介：${info.intro.replace(/\s+/g, " ").slice(0, INTRO_CHARS)}`);
  if (hasToc) lines.push("", "目录：", ...renderToc(toc, input.chapterUid));
  else lines.push("", "没有拿到这本书的目录。");
  if (popular.length) {
    lines.push("", chapter ? "这一章的热门划线（划线人数）：" : "全书热门划线（划线人数）：");
    for (const p of popular) lines.push(`- （${p.count}）${p.markText.replace(/\s+/g, " ")}`);
  }
  if (book.purpose) lines.push("", `读者的读前目的：${book.purpose}`);
  if (own.length) {
    lines.push("", chapter ? "读者在这一章的划线：" : hasToc ? "读者在这本书里最近的划线：" : "读者在这本书里的划线（缩进的是读者自己写的想法）：");
    for (const h of own) {
      lines.push(`- ${h.text.replace(/\s+/g, " ").slice(0, hasToc ? OWN_HIGHLIGHT_CHARS : 200)}`);
      for (const n of ownNotes.filter((x) => x.highlightId === h.id)) lines.push(`    想法：${n.content}`);
    }
  } else if (!hasToc) {
    lines.push("", "读者在这本书里还没有划线。");
  }
  if (open.length) {
    lines.push("", "读者正在想的问题：");
    for (const q of open) {
      const o = describeOrigin(db, q);
      lines.push(`- ${q.title}（${QUESTION_STATUS_LABELS[q.status]}${o ? `，起源《${o.bookTitle}》` : ""}）`);
    }
  }

  const scope = chapter ? "chapter" : depth === "quick" ? "quick" : "book";
  const task = chapter ? `为《${book.title}》的「${chapter.title}」写章节导读` : depth === "quick" ? `为《${book.title}》写一页速览` : `为《${book.title}》写全书导读`;
  return {
    task,
    instructions: instructions(scope, mode.mode, hasToc) + spoilerRule(mode.mode, position),
    material: lines.join("\n"),
    reply: "Markdown 全文：第一行是依据，最后一节是「## 追问」。",
    writeBack: `bookside guide ${refOf("book", book.id)}${chapter ? ` --chapter ${chapter.chapterIdx}` : depth === "quick" ? " --quick" : ""} --write -`,
  };
}

/** 写回导读：存为新的一版（旧版保留），结尾的追问挂到书或这一章上。 */
export function writeGuide(
  db: Conn,
  input: { bookId: string; chapterId?: string; depth?: GuideDepth; by?: string },
  text: string,
  now = new Date(),
): GuideResult {
  getBook(db, input.bookId);
  const parsed = parseGuide(text);
  return db.transaction((tx) => {
    const guide = tx
      .insert(guides)
      .values({
        bookId: input.bookId,
        chapterId: input.chapterId ?? null,
        basis: parsed.basis,
        depth: input.chapterId ? "full" : (input.depth ?? "full"),
        content: parsed.content,
        model: input.by ?? null,
        createdAt: now,
      })
      .returning()
      .get();
    const target = input.chapterId ? ({ type: "chapter", id: input.chapterId } as const) : ({ type: "book", id: input.bookId } as const);
    const probes = parsed.probes.map((content) => addProbe(tx, { target, content }, now));
    return { guide, probes };
  });
}

/** 按目录序号或标题中的一段文字，在已取过目录的书里找章节（写回导读时不再联网）。 */
export function findChapter(db: Conn, bookId: string, wanted: string): { id: string; idx: number; title: string } {
  const w = wanted.trim();
  const hit = /^\d+$/.test(w)
    ? db.select().from(chapters).where(and(eq(chapters.bookId, bookId), eq(chapters.idx, Number(w)))).get()
    : db.select().from(chapters).where(and(eq(chapters.bookId, bookId), like(chapters.title, `%${w}%`))).orderBy(asc(chapters.idx)).get();
  if (!hit) throw new DomainError("not_found", `找不到章节「${w}」：先用 bookside book toc 取目录`);
  return { id: hit.id, idx: hit.idx, title: hit.title };
}

/** 书的目录（顺带把章节写入数据库），供选择章节导读。 */
export async function loadToc(
  db: Conn,
  catalog: WereadCatalog,
  bookId: string,
): Promise<(TocEntry & { chapterId: string; hasGuide: boolean })[]> {
  const book = getBook(db, bookId);
  if (!book.wereadBookId) throw new DomainError("no_basis", `《${book.title}》不在微信读书上，拿不到目录`);
  const toc = await catalog.toc(book.wereadBookId);
  const ids = db.transaction((tx) => upsertChapters(tx, book.id, toc));
  const withGuide = new Set(
    db
      .select({ c: guides.chapterId })
      .from(guides)
      .where(inArray(guides.chapterId, [...ids.values()]))
      .all()
      .map((r) => r.c),
  );
  return toc.map((c) => ({ ...c, chapterId: ids.get(c.chapterUid)!, hasGuide: withGuide.has(ids.get(c.chapterUid)!) }));
}

