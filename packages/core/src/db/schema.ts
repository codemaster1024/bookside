// 领域实体的表定义。
import { randomUUID } from "node:crypto";
import { type SQL, sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const SOURCES = ["weread", "kindle", "local"] as const;
export const SPEAKERS = ["me", "ai"] as const;
export const HIGHLIGHT_KINDS = ["marked", "from_note"] as const;
export const QUESTION_STATUSES = ["unexplored", "exploring", "tentative", "resolved", "abandoned"] as const;
export const LINK_KINDS = ["supports", "conflicts", "answers", "extends"] as const;
export const LINK_STATES = ["proposed", "confirmed", "rejected"] as const;
export const LINKABLE_TYPES = ["book", "chapter", "highlight", "note", "question", "insight"] as const;
/** 读法：思辨 / 实践 / 知识 / 叙事，决定一本书怎么陪着读。 */
export const READING_MODES = ["argument", "practice", "knowledge", "narrative"] as const;

export type Source = (typeof SOURCES)[number];
export type Speaker = (typeof SPEAKERS)[number];
export type HighlightKind = (typeof HIGHLIGHT_KINDS)[number];
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];
export type LinkKind = (typeof LINK_KINDS)[number];
export type LinkState = (typeof LINK_STATES)[number];
export type LinkableType = (typeof LINKABLE_TYPES)[number];
export type ReadingMode = (typeof READING_MODES)[number];

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => randomUUID());
const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());
const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

function oneOf(name: string, column: AnySQLiteColumn, values: readonly string[]) {
  return check(name, sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`);
}

/** 非空列的个数，用于"至多一个 / 恰好一个"约束。 */
function countSet(...columns: AnySQLiteColumn[]): SQL {
  return sql.join(
    columns.map((c) => sql`(${c} is not null)`),
    sql` + `,
  );
}

export const books = sqliteTable(
  "books",
  {
    id: id(),
    source: text("source", { enum: SOURCES }).notNull(),
    wereadBookId: text("weread_book_id"),
    title: text("title").notNull(),
    author: text("author"),
    /** 封面图地址（来自微信读书）。 */
    cover: text("cover"),
    /** 阅读进度 0–100，未知为空。 */
    progress: integer("progress"),
    finishedAt: timestamp("finished_at"),
    /** 读前目的。 */
    purpose: text("purpose"),
    /** 数据源给的分类，如微信读书的「文学-外国文学」；用来推定读法。 */
    category: text("category"),
    /** 你或智能体指定的读法；为空时按分类推定。 */
    readingMode: text("reading_mode", { enum: READING_MODES }),
    /** 数据源上这本书笔记状态的指纹；变了才重拉划线和想法。 */
    syncSignature: text("sync_signature"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("books_weread_book_id").on(t.wereadBookId),
    oneOf("books_source", t.source, SOURCES),
    oneOf("books_reading_mode", t.readingMode, READING_MODES),
    check("books_progress", sql`${t.progress} between 0 and 100`),
  ],
);

export const chapters = sqliteTable(
  "chapters",
  {
    id: id(),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    wereadChapterUid: integer("weread_chapter_uid"),
    idx: integer("idx").notNull(),
    title: text("title").notNull(),
    /** 目录层级，1 为一级标题。 */
    level: integer("level").notNull().default(1),
  },
  (t) => [uniqueIndex("chapters_book_uid").on(t.bookId, t.wereadChapterUid)],
);

export const highlights = sqliteTable(
  "highlights",
  {
    id: id(),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id").references(() => chapters.id),
    source: text("source", { enum: SOURCES }).notNull(),
    kind: text("kind", { enum: HIGHLIGHT_KINDS }).notNull().default("marked"),
    wereadBookmarkId: text("weread_bookmark_id"),
    text: text("text").notNull(),
    /** 书中位置，原样保存数据源的 range（如微信读书的 "1234-1300"）。 */
    range: text("range"),
    markedAt: timestamp("marked_at").notNull(),
    /** 源端已删除的时间；本地永不因源端删除而删行。 */
    deletedAtSourceAt: timestamp("deleted_at_source_at"),
    /** 已被纳入过追问生成的考虑（无论是否选中）；为空表示还没轮到。 */
    probeConsideredAt: timestamp("probe_considered_at"),
    /** 已被纳入过跨书激活的考虑；为空表示还没轮到。 */
    activationConsideredAt: timestamp("activation_considered_at"),
    /** 上次被拿出来重温的时间；一段时间内不再重复。 */
    rereadAt: timestamp("reread_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("highlights_weread_bookmark_id").on(t.wereadBookmarkId),
    index("highlights_book").on(t.bookId),
    oneOf("highlights_source", t.source, SOURCES),
    oneOf("highlights_kind", t.kind, HIGHLIGHT_KINDS),
  ],
);

export const notes = sqliteTable(
  "notes",
  {
    id: id(),
    highlightId: text("highlight_id")
      .notNull()
      .references(() => highlights.id, { onDelete: "cascade" }),
    source: text("source", { enum: SOURCES }).notNull(),
    wereadReviewId: text("weread_review_id"),
    content: text("content").notNull(),
    writtenAt: timestamp("written_at").notNull(),
    deletedAtSourceAt: timestamp("deleted_at_source_at"),
    probeConsideredAt: timestamp("probe_considered_at"),
    /** 已被纳入过跨书激活的考虑；为空表示还没轮到。 */
    activationConsideredAt: timestamp("activation_considered_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("notes_weread_review_id").on(t.wereadReviewId),
    index("notes_highlight").on(t.highlightId),
    oneOf("notes_source", t.source, SOURCES),
  ],
);

export const questions = sqliteTable(
  "questions",
  {
    id: id(),
    title: text("title").notNull(),
    status: text("status", { enum: QUESTION_STATUSES }).notNull().default("unexplored"),
    // 起源：至多一个；全空即长期问题。
    originBookId: text("origin_book_id").references(() => books.id),
    originChapterId: text("origin_chapter_id").references(() => chapters.id),
    originHighlightId: text("origin_highlight_id").references(() => highlights.id),
    /** 回访间隔序列中的当前位置，新回复后归零。 */
    revisitStep: integer("revisit_step").notNull().default(0),
    /** 下次回访时间；不参与回访的状态为空。 */
    nextRevisitAt: timestamp("next_revisit_at"),
    createdAt: createdAt(),
  },
  (t) => [
    oneOf("questions_status", t.status, QUESTION_STATUSES),
    check("questions_single_origin", sql`${countSet(t.originBookId, t.originChapterId, t.originHighlightId)} <= 1`),
    index("questions_next_revisit").on(t.nextRevisitAt),
  ],
);

/** 问题状态的每一次改动：看一个问题从提出到想通走过的路。 */
export const questionStatusChanges = sqliteTable(
  "question_status_changes",
  {
    id: id(),
    questionId: text("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    from: text("from", { enum: QUESTION_STATUSES }).notNull(),
    to: text("to", { enum: QUESTION_STATUSES }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("question_status_changes_question").on(t.questionId, t.createdAt)],
);

export const probes = sqliteTable(
  "probes",
  {
    id: id(),
    // 挂载对象：恰好一个。
    bookId: text("book_id").references(() => books.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id").references(() => chapters.id, { onDelete: "cascade" }),
    highlightId: text("highlight_id").references(() => highlights.id, { onDelete: "cascade" }),
    noteId: text("note_id").references(() => notes.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    /** 被升格成的问题；未升格为空。 */
    promotedQuestionId: text("promoted_question_id").references(() => questions.id),
    dismissedAt: timestamp("dismissed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    check("probes_single_target", sql`${countSet(t.bookId, t.chapterId, t.highlightId, t.noteId)} = 1`),
    check("probes_promoted_or_dismissed", sql`${countSet(t.promotedQuestionId, t.dismissedAt)} <= 1`),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: id(),
    questionId: text("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    speaker: text("speaker", { enum: SPEAKERS }).notNull(),
    content: text("content").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("messages_question").on(t.questionId, t.createdAt), oneOf("messages_speaker", t.speaker, SPEAKERS)],
);

/** 线程消息引用的划线。 */
export const messageHighlights = sqliteTable(
  "message_highlights",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    highlightId: text("highlight_id")
      .notNull()
      .references(() => highlights.id),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.highlightId] })],
);

export const insights = sqliteTable("insights", {
  id: id(),
  createdAt: createdAt(),
});

/** 观点的每一个版本；作者标记由版本历史推导，不单独存。 */
export const insightVersions = sqliteTable(
  "insight_versions",
  {
    id: id(),
    insightId: text("insight_id")
      .notNull()
      .references(() => insights.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    author: text("author", { enum: SPEAKERS }).notNull(),
    /** 从零重写、不基于上一版；首个版本也视为重写。 */
    rewrite: integer("rewrite", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("insight_versions_insight").on(t.insightId, t.createdAt), oneOf("insight_versions_author", t.author, SPEAKERS)],
);

/** 观点的来源：一个问题、一条划线，或一本书本身。 */
export const insightSources = sqliteTable(
  "insight_sources",
  {
    id: id(),
    insightId: text("insight_id")
      .notNull()
      .references(() => insights.id, { onDelete: "cascade" }),
    questionId: text("question_id").references(() => questions.id),
    highlightId: text("highlight_id").references(() => highlights.id),
    /** 来自一本书本身：书边对话里聊出、没落在某条划线上的看法。 */
    bookId: text("book_id").references(() => books.id),
  },
  (t) => [
    check("insight_sources_single", sql`${countSet(t.questionId, t.highlightId, t.bookId)} = 1`),
    // SQLite 中 NULL 互不相等，各条索引只约束非空的那一侧。
    uniqueIndex("insight_sources_question").on(t.questionId, t.insightId),
    uniqueIndex("insight_sources_highlight").on(t.highlightId, t.insightId),
    uniqueIndex("insight_sources_book").on(t.bookId, t.insightId),
  ],
);

/** 关联与关联提议：只有 state = confirmed 的才算读者认可的关联，其余是等确认或被拒绝的提议。 */
export const links = sqliteTable(
  "links",
  {
    id: id(),
    fromType: text("from_type", { enum: LINKABLE_TYPES }).notNull(),
    fromId: text("from_id").notNull(),
    toType: text("to_type", { enum: LINKABLE_TYPES }).notNull(),
    toId: text("to_id").notNull(),
    kind: text("kind", { enum: LINK_KINDS }).notNull(),
    state: text("state", { enum: LINK_STATES }).notNull(),
    proposedBy: text("proposed_by", { enum: SPEAKERS }).notNull(),
    /** AI 提议时给出的理由。 */
    reason: text("reason"),
    decidedAt: timestamp("decided_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("links_unique").on(t.fromType, t.fromId, t.toType, t.toId, t.kind),
    index("links_to").on(t.toType, t.toId),
    oneOf("links_from_type", t.fromType, LINKABLE_TYPES),
    oneOf("links_to_type", t.toType, LINKABLE_TYPES),
    oneOf("links_kind", t.kind, LINK_KINDS),
    oneOf("links_state", t.state, LINK_STATES),
    oneOf("links_proposed_by", t.proposedBy, SPEAKERS),
    check("links_not_self", sql`not (${t.fromType} = ${t.toType} and ${t.fromId} = ${t.toId})`),
  ],
);

/** 书评：你对整本书（chapterId 为空）或某一章写的点评，不对应某段原文。 */
export const reviews = sqliteTable(
  "reviews",
  {
    id: id(),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id").references(() => chapters.id, { onDelete: "cascade" }),
    source: text("source", { enum: SOURCES }).notNull(),
    wereadReviewId: text("weread_review_id"),
    content: text("content").notNull(),
    /** 评分 1–5，无评分为空。 */
    star: integer("star"),
    writtenAt: timestamp("written_at").notNull(),
    deletedAtSourceAt: timestamp("deleted_at_source_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("reviews_weread_review_id").on(t.wereadReviewId), index("reviews_book").on(t.bookId)],
);

export const GUIDE_BASES = ["familiar", "limited"] as const;
export type GuideBasis = (typeof GUIDE_BASES)[number];
/** 导读的篇幅：速览（一页看完）或全书导读（详细）；章节导读都是 full。 */
export const GUIDE_DEPTHS = ["quick", "full"] as const;
export type GuideDepth = (typeof GUIDE_DEPTHS)[number];

/** 导读：AI 写的全书导读（chapterId 为空）或章节导读；重新生成会新增一条，展示最新的。 */
export const guides = sqliteTable(
  "guides",
  {
    id: id(),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id").references(() => chapters.id, { onDelete: "cascade" }),
    /** 熟悉：依据写作者对书的了解；有限：只依据给出的材料（目录、简介、热门划线或读者的划线）。 */
    basis: text("basis", { enum: GUIDE_BASES }).notNull(),
    depth: text("depth", { enum: GUIDE_DEPTHS }).notNull().default("full"),
    /** Markdown 正文。 */
    content: text("content").notNull(),
    /** 写这份导读的智能体，如 claude-code；可空。 */
    model: text("model"),
    createdAt: createdAt(),
  },
  (t) => [
    index("guides_book").on(t.bookId, t.chapterId),
    oneOf("guides_basis", t.basis, GUIDE_BASES),
    oneOf("guides_depth", t.depth, GUIDE_DEPTHS),
  ],
);

/** 同步等杂项状态（如微信读书基线建立时间）。 */
export const syncState = sqliteTable("sync_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});


/**
 * 读书画像：智能体根据读者的划线写的一页总结——一句值得重读的话、最近在关心的几件事、一段画像和一条建议。
 * 只追加不覆盖，首页显示最新的一份。
 */
export const portraits = sqliteTable("portraits", {
  id: id(),
  /** JSON：{ reread, themes, essay, next }，引用的划线与问题都存完整 id。 */
  content: text("content").notNull(),
  /** 写的时候一共有多少条划线。 */
  highlightCount: integer("highlight_count").notNull(),
  /** 写画像的智能体，如 claude-code；可空。 */
  model: text("model"),
  createdAt: createdAt(),
});
