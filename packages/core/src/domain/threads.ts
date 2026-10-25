import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import { books, chapters, highlights, insightVersions, messageHighlights, notes, questions } from "../db/schema.ts";
import type { LinkKind, LinkableType, QuestionStatus } from "../db/schema.ts";
import type { Conn } from "./conn.ts";
import { type InsightView, insightsOfQuestion } from "./insights.ts";
import { type Link, linksOf } from "./links.ts";
import { type Message, type Question, getQuestion, listMessages } from "./questions.ts";

export const QUESTION_STATUS_LABELS: Record<QuestionStatus, string> = {
  unexplored: "未探索",
  exploring: "探讨中",
  tentative: "暂有答案",
  resolved: "已解决",
  abandoned: "放弃",
};

export const LINK_KIND_LABELS: Record<LinkKind, string> = {
  supports: "印证",
  conflicts: "冲突",
  answers: "回答",
  extends: "延伸",
};

export type OriginView =
  | { type: "book"; id: string; bookId: string; bookTitle: string }
  | { type: "chapter"; id: string; bookId: string; bookTitle: string; chapterTitle: string }
  | { type: "highlight"; id: string; bookId: string; bookTitle: string; quote: string };

export type QuestionDetail = {
  question: Question;
  origin: OriginView | null;
  messages: (Message & { cited: { id: string; text: string }[] })[];
  insights: InsightView[];
  links: Link[];
  /** 等读者确认的关联提议（跨书激活或回溯产生）。 */
  proposals: Link[];
};

export function describeOrigin(conn: Conn, q: Question): OriginView | null {
  if (q.originBookId) {
    const b = conn.select().from(books).where(eq(books.id, q.originBookId)).get()!;
    return { type: "book", id: b.id, bookId: b.id, bookTitle: b.title };
  }
  if (q.originChapterId) {
    const r = conn
      .select({ c: chapters, title: books.title, bookId: books.id })
      .from(chapters)
      .innerJoin(books, eq(books.id, chapters.bookId))
      .where(eq(chapters.id, q.originChapterId))
      .get()!;
    return { type: "chapter", id: r.c.id, bookId: r.bookId, bookTitle: r.title, chapterTitle: r.c.title };
  }
  if (q.originHighlightId) {
    const r = conn
      .select({ h: highlights, title: books.title, bookId: books.id })
      .from(highlights)
      .innerJoin(books, eq(books.id, highlights.bookId))
      .where(eq(highlights.id, q.originHighlightId))
      .get()!;
    return { type: "highlight", id: r.h.id, bookId: r.bookId, bookTitle: r.title, quote: r.h.text };
  }
  return null;
}

/** 问题列表，最近创建的在前；bookId 过滤起源于该书（含其章节、划线）的问题。 */
export function listQuestions(conn: Conn, filter: { status?: QuestionStatus[]; bookId?: string } = {}): Question[] {
  const conds = [];
  if (filter.status?.length) conds.push(inArray(questions.status, filter.status));
  if (filter.bookId) {
    const chapterIds = conn.select({ id: chapters.id }).from(chapters).where(eq(chapters.bookId, filter.bookId)).all().map((c) => c.id);
    const hlIds = conn.select({ id: highlights.id }).from(highlights).where(eq(highlights.bookId, filter.bookId)).all().map((h) => h.id);
    conds.push(
      or(
        eq(questions.originBookId, filter.bookId),
        inArray(questions.originChapterId, chapterIds),
        inArray(questions.originHighlightId, hlIds),
      ),
    );
  }
  return conn
    .select()
    .from(questions)
    .where(and(...conds))
    .orderBy(desc(questions.createdAt))
    .all();
}

export function getQuestionDetail(conn: Conn, questionId: string): QuestionDetail {
  const question = getQuestion(conn, questionId);
  const msgs = listMessages(conn, questionId);
  const cites = msgs.length
    ? conn
        .select({ messageId: messageHighlights.messageId, id: highlights.id, text: highlights.text })
        .from(messageHighlights)
        .innerJoin(highlights, eq(highlights.id, messageHighlights.highlightId))
        .where(
          inArray(
            messageHighlights.messageId,
            msgs.map((m) => m.id),
          ),
        )
        .orderBy(asc(highlights.markedAt))
        .all()
    : [];
  return {
    question,
    origin: describeOrigin(conn, question),
    messages: msgs.map((m) => ({
      ...m,
      cited: cites.filter((c) => c.messageId === m.id).map(({ id, text }) => ({ id, text })),
    })),
    insights: insightsOfQuestion(conn, questionId),
    links: linksOf(conn, { type: "question", id: questionId }),
    proposals: linksOf(conn, { type: "question", id: questionId }, "proposed"),
  };
}

/** 关联两端的一端，拆成几块：哪本书、是什么、正文（不截断）。 */
export type RefParts = { type: LinkableType; book: string | null; kind: string; text: string };

const REF_KINDS: Record<LinkableType, string> = { book: "书", chapter: "章节", highlight: "划线", note: "想法", question: "问题", insight: "观点" };

export function refParts(conn: Conn, ref: { type: LinkableType; id: string }): RefParts {
  const parts = (book: string | null, text: string | undefined): RefParts => ({ type: ref.type, book, kind: REF_KINDS[ref.type], text: text ?? "?" });
  switch (ref.type) {
    case "book":
      return parts(null, conn.select().from(books).where(eq(books.id, ref.id)).get()?.title);
    case "chapter": {
      const r = conn
        .select({ c: chapters.title, b: books.title })
        .from(chapters)
        .innerJoin(books, eq(books.id, chapters.bookId))
        .where(eq(chapters.id, ref.id))
        .get();
      return parts(r?.b ?? null, r?.c);
    }
    case "highlight": {
      const r = conn
        .select({ t: highlights.text, b: books.title })
        .from(highlights)
        .innerJoin(books, eq(books.id, highlights.bookId))
        .where(eq(highlights.id, ref.id))
        .get();
      return parts(r?.b ?? null, r?.t);
    }
    case "note": {
      const r = conn
        .select({ t: notes.content, b: books.title })
        .from(notes)
        .innerJoin(highlights, eq(highlights.id, notes.highlightId))
        .innerJoin(books, eq(books.id, highlights.bookId))
        .where(eq(notes.id, ref.id))
        .get();
      return parts(r?.b ?? null, r?.t);
    }
    case "question":
      return parts(null, conn.select().from(questions).where(eq(questions.id, ref.id)).get()?.title);
    case "insight": {
      const v = conn
        .select({ t: insightVersions.content })
        .from(insightVersions)
        .where(eq(insightVersions.insightId, ref.id))
        .orderBy(desc(insightVersions.createdAt))
        .get();
      return parts(null, v?.t);
    }
  }
}

/** 一行文字的说法，如 《书》划线「……」；max 控制正文截到多长（命令行列表用短的）。 */
export function describeRef(conn: Conn, ref: { type: LinkableType; id: string }, max = 140): string {
  const p = refParts(conn, ref);
  const text = p.text.length > max ? `${p.text.slice(0, max)}…` : p.text;
  switch (ref.type) {
    case "book":
      return `《${text}》`;
    case "chapter":
      return `《${p.book ?? "?"}》${text}`;
    case "highlight":
    case "note":
      return `《${p.book ?? "?"}》${p.kind}「${text}」`;
    default:
      return `${p.kind}「${text}」`;
  }
}
