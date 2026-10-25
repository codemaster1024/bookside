// 读法：一本书该怎么陪着读（思辨 / 实践 / 知识 / 叙事）。你或智能体指定的优先，其次按书的分类推定，都没有时按思辨。
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { READING_MODES, type ReadingMode, books, chapters, highlights } from "../db/schema.ts";
import { type Book, getBook } from "./books.ts";
import type { Conn } from "./conn.ts";
import { DomainError } from "./errors.ts";

export { READING_MODES, type ReadingMode };

export const READING_MODE_LABELS: Record<ReadingMode, string> = {
  argument: "思辨",
  practice: "实践",
  knowledge: "知识",
  narrative: "叙事",
};

/**
 * 微信读书分类（「大类-小类」）到读法的对照：先看小类里的关键词，再看大类。
 * 历史多在讲道理（如《人类简史》），归思辨；像小说一样讲故事的历史书可以改成叙事。
 */
const BY_KEYWORD: [RegExp, ReadingMode][] = [
  [/小说|文学|散文|诗|传记|童书|漫画|绘本|戏剧/, "narrative"],
  [/计算机|编程|科学|技术|心理|医学|数学|物理|化学|生物|天文|工程|艺术|设计|语言/, "knowledge"],
  [/个人成长|励志|职场|管理|理财|投资|创业|营销|教育|学习|生活|健康|育儿|沟通|效率/, "practice"],
  [/哲学|宗教|社会|政治|军事|历史|经济|文化|法律/, "argument"],
];

export function modeOfCategory(category: string | null | undefined): ReadingMode | undefined {
  if (!category) return undefined;
  const [major, minor = ""] = category.split("-", 2);
  for (const part of [minor, major!]) {
    for (const [re, mode] of BY_KEYWORD) if (part && re.test(part)) return mode;
  }
  return undefined;
}

export type ReadingModeView = {
  mode: ReadingMode;
  label: string;
  /** set：你或智能体指定的；category：按分类推定；default：没有分类，暂按思辨，等智能体判断。 */
  origin: "set" | "category" | "default";
  category: string | null;
};

export function readingModeOf(book: Pick<Book, "readingMode" | "category">): ReadingModeView {
  const fromCategory = modeOfCategory(book.category);
  const mode = book.readingMode ?? fromCategory ?? "argument";
  const origin = book.readingMode ? "set" : fromCategory ? "category" : "default";
  return { mode, label: READING_MODE_LABELS[mode], origin, category: book.category };
}

/** 读法的说明文字，用在 brief 的材料与命令输出里。 */
export function describeReadingMode(v: ReadingModeView): string {
  if (v.origin === "set") return `读法：${v.label}`;
  if (v.origin === "category") return `读法：${v.label}（按分类「${v.category}」推定）`;
  return `读法：未定，暂按${v.label}`;
}

export function parseReadingMode(value: string): ReadingMode {
  const v = value.trim();
  const hit = READING_MODES.find((m) => m === v || READING_MODE_LABELS[m] === v);
  if (!hit) throw new DomainError("invalid_input", `未知读法 ${value}，可用：${READING_MODES.map((m) => `${READING_MODE_LABELS[m]}(${m})`).join(" / ")}`);
  return hit;
}

export function setReadingMode(conn: Conn, bookId: string, mode: ReadingMode): Book {
  getBook(conn, bookId);
  return conn.update(books).set({ readingMode: mode }).where(eq(books.id, bookId)).returning().get();
}

/** 「读到第 3 章「……」，进度 40%」；不知道时为空。 */
export function describePosition(conn: Conn, bookId: string): string | undefined {
  const p = readingPosition(conn, bookId);
  if (!p) return undefined;
  const pct = p.progress === null ? "" : `进度 ${p.progress}%`;
  return p.chapterIdx === null ? pct : `读到第 ${p.chapterIdx} 章「${p.chapterTitle}」${pct ? `，${pct}` : ""}`;
}

/**
 * 读者读到哪：最近一条划线所在的章节，加上阅读进度。用来让叙事类的书不剧透。
 * 读完的书、或什么都不知道时返回空。
 */
export function readingPosition(conn: Conn, bookId: string): { chapterIdx: number; chapterTitle: string; progress: number | null } | { chapterIdx: null; chapterTitle: null; progress: number } | undefined {
  const book = getBook(conn, bookId);
  if (book.finishedAt || book.progress === 100) return undefined;
  const last = conn
    .select({ idx: chapters.idx, title: chapters.title })
    .from(highlights)
    .innerJoin(chapters, eq(chapters.id, highlights.chapterId))
    .where(and(eq(highlights.bookId, bookId), isNull(highlights.deletedAtSourceAt), isNotNull(highlights.chapterId)))
    .orderBy(desc(chapters.idx))
    .get();
  if (last && last.idx >= 0) return { chapterIdx: last.idx, chapterTitle: last.title, progress: book.progress };
  return book.progress === null ? undefined : { chapterIdx: null, chapterTitle: null, progress: book.progress };
}
