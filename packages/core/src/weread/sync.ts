import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { books, chapters, highlights, notes, reviews, syncState } from "../db/schema.ts";
import type { Conn } from "../domain/conn.ts";
import type { NotebookEntry, ShelfBook, WereadBookmark, WereadChapter, WereadReview, WereadSource } from "./client.ts";

const BASELINE_KEY = "weread.baseline_at";
/** 曾有笔记、但已从笔记本概览中消失的书。 */
const GONE_SIGNATURE = "gone";

export type SyncResult = {
  /** 本次是否为首次导入（建立基线）；基线导入的内容不计入 new*，也不该触发追问。 */
  baseline: boolean;
  booksSynced: number;
  newHighlightIds: string[];
  newNoteIds: string[];
  markedDeleted: number;
  /** 本次新导入的书评与章节点评（不对应原文的那些）。 */
  newReviews: number;
};

type BookNotes = { bookmarks: WereadBookmark[]; chapters: WereadChapter[]; reviews: WereadReview[] };

const fromUnix = (s: number) => new Date(s * 1000);
const anchorKey = (chapterUid: number | undefined, range: string | undefined) => `${chapterUid ?? ""}:${range ?? ""}`;

/** 评分统一为 1–5：接口文档写 0–5，实际也会返回 0–100（如 100 表示满分）；无评分为空。 */
export function normalizeStar(star: number | undefined): number | null {
  if (star === undefined || star <= 0) return null;
  return star > 5 ? Math.max(1, Math.min(5, Math.round(star / 20))) : star;
}

/** 笔记状态指纹：最近笔记时间 + 划线数 + 想法数；删除会改变数量，新增会改变时间。 */
export function signatureOf(entry: NotebookEntry): string {
  return `${entry.sort}:${entry.noteCount}:${entry.reviewCount}`;
}


/**
 * 从微信读书同步书架、划线和想法。只重拉指纹变化了的书；
 * 网络请求在事务外进行，每本书的写入各自一个事务，中途失败下次会重试未完成的书。
 */
export async function syncWeread(
  db: Conn,
  source: WereadSource,
  now = new Date(),
  opts: { full?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<SyncResult> {
  const [shelf, notebooks] = await Promise.all([source.shelf(), source.notebooks()]);
  const baseline = !db.select().from(syncState).where(eq(syncState.key, BASELINE_KEY)).get();
  const bookIds = db.transaction((tx) => upsertBooks(tx, shelf, notebooks));

  const result: SyncResult = {
    baseline,
    booksSynced: 0,
    newHighlightIds: [],
    newNoteIds: [],
    markedDeleted: 0,
    newReviews: 0,
  };

  const todo: { wereadBookId: string; signature: string }[] = [];
  for (const entry of notebooks) {
    const local = db.select().from(books).where(eq(books.id, bookIds.get(entry.bookId)!)).get()!;
    if (opts.full || local.syncSignature !== signatureOf(entry)) {
      todo.push({ wereadBookId: entry.bookId, signature: signatureOf(entry) });
    }
  }
  const listed = new Set(notebooks.map((n) => n.bookId));
  for (const b of db.select().from(books).where(isNotNull(books.syncSignature)).all()) {
    if (b.wereadBookId && !listed.has(b.wereadBookId) && b.syncSignature !== GONE_SIGNATURE) {
      todo.push({ wereadBookId: b.wereadBookId, signature: GONE_SIGNATURE });
    }
  }

  opts.onProgress?.(0, todo.length);
  for (const { wereadBookId, signature } of todo) {
    const [{ bookmarks, chapters: chapterList }, reviews] = await Promise.all([
      source.bookmarks(wereadBookId),
      source.myReviews(wereadBookId),
    ]);
    const bookId = bookIds.get(wereadBookId) ?? db.select().from(books).where(eq(books.wereadBookId, wereadBookId)).get()!.id;
    const r = db.transaction((tx) => {
      const applied = applyBookNotes(tx, bookId, { bookmarks, chapters: chapterList, reviews }, now);
      tx.update(books).set({ syncSignature: signature }).where(eq(books.id, bookId)).run();
      return applied;
    });
    result.booksSynced++;
    opts.onProgress?.(result.booksSynced, todo.length);
    result.markedDeleted += r.markedDeleted;
    if (!baseline) result.newReviews += r.newReviews;
    if (!baseline) {
      result.newHighlightIds.push(...r.newHighlightIds);
      result.newNoteIds.push(...r.newNoteIds);
    }
  }

  if (baseline) {
    db.transaction((tx) => {
      // 基线内容视为已考虑过，永远不会为它们生成追问或激活提议。
      tx.update(highlights).set({ probeConsideredAt: now }).where(isNull(highlights.probeConsideredAt)).run();
      tx.update(notes).set({ probeConsideredAt: now }).where(isNull(notes.probeConsideredAt)).run();
      tx.update(highlights).set({ activationConsideredAt: now }).where(isNull(highlights.activationConsideredAt)).run();
      tx.update(notes).set({ activationConsideredAt: now }).where(isNull(notes.activationConsideredAt)).run();
      tx.insert(syncState).values({ key: BASELINE_KEY, value: now.toISOString() }).run();
    });
  }
  return result;
}

/** 数据源里的书名、作者偶有换行和连续空格。 */
const tidy = (text: string | undefined) => text?.replace(/\s+/g, " ").trim() || undefined;

/** 书架上的书和有笔记的书都建档；返回 微信读书 bookId → 本地 id。 */
function upsertBooks(tx: Conn, shelf: ShelfBook[], notebooks: NotebookEntry[]): Map<string, string> {
  const ids = new Map<string, string>();
  const progress = new Map(notebooks.map((n) => [n.bookId, n]));
  const entries = new Map<string, { title: string; author?: string; cover?: string; category?: string; finished: boolean; finishedHint?: number }>();
  for (const b of shelf) {
    entries.set(b.bookId, {
      title: b.title,
      author: b.author,
      cover: b.cover,
      category: b.category,
      finished: b.finishReading === 1,
      finishedHint: b.readUpdateTime,
    });
  }
  for (const n of notebooks) {
    const prev = entries.get(n.bookId);
    entries.set(n.bookId, {
      title: n.book.title,
      author: n.book.author ?? prev?.author,
      cover: prev?.cover ?? n.book.cover,
      category: prev?.category,
      finished: n.markedStatus === 1 || !!prev?.finished,
      finishedHint: prev?.finishedHint ?? n.sort,
    });
  }
  for (const [wereadBookId, e] of entries) {
    const existing = tx.select().from(books).where(eq(books.wereadBookId, wereadBookId)).get();
    const rawProgress = progress.get(wereadBookId)?.readingProgress;
    const fields = {
      title: tidy(e.title) ?? e.title,
      author: tidy(e.author) ?? null,
      ...(e.cover ? { cover: e.cover } : {}),
      ...(e.category ? { category: tidy(e.category) } : {}),
      ...(rawProgress === undefined ? {} : { progress: Math.max(0, Math.min(100, Math.round(rawProgress))) }),
      // 接口不给读完时间，用最近阅读时间近似；已有的读完时间不覆盖。
      finishedAt: e.finished ? (existing?.finishedAt ?? (e.finishedHint ? fromUnix(e.finishedHint) : new Date())) : null,
    };
    if (existing) {
      tx.update(books).set(fields).where(eq(books.id, existing.id)).run();
      ids.set(wereadBookId, existing.id);
    } else {
      ids.set(wereadBookId, tx.insert(books).values({ source: "weread", wereadBookId, ...fields }).returning().get().id);
    }
  }
  return ids;
}

type Applied = { newHighlightIds: string[]; newNoteIds: string[]; markedDeleted: number; newReviews: number };

/** 把一本书在源端的完整划线与想法对齐到本地。 */
export function applyBookNotes(tx: Conn, bookId: string, src: BookNotes, now: Date): Applied {
  const out: Applied = { newHighlightIds: [], newNoteIds: [], markedDeleted: 0, newReviews: 0 };
  const chapterIds = upsertChapters(tx, bookId, src.chapters);
  const uidOf = new Map([...chapterIds].map(([uid, id]) => [id, uid]));
  /** 章节列表里没有的 uid 也建一个占位章节，保证同一位置下次仍能对上。 */
  const chapterOf = (uid: number | undefined): string | null => {
    if (uid === undefined) return null;
    let id = chapterIds.get(uid);
    if (!id) {
      id = tx.insert(chapters).values({ bookId, wereadChapterUid: uid, idx: -1, title: "" }).returning().get().id;
      chapterIds.set(uid, id);
      uidOf.set(id, uid);
    }
    return id;
  };

  const local = tx.select().from(highlights).where(eq(highlights.bookId, bookId)).all();
  const byBookmark = new Map(local.filter((h) => h.wereadBookmarkId).map((h) => [h.wereadBookmarkId!, h]));
  const byAnchor = new Map(local.map((h) => [anchorKey(h.chapterId ? uidOf.get(h.chapterId) : undefined, h.range ?? undefined), h]));

  // —— 划线 ——
  const seenBookmarks = new Set<string>();
  for (const bm of src.bookmarks) {
    seenBookmarks.add(bm.bookmarkId);
    const known = byBookmark.get(bm.bookmarkId);
    if (known) {
      if (known.deletedAtSourceAt) tx.update(highlights).set({ deletedAtSourceAt: null }).where(eq(highlights.id, known.id)).run();
      continue;
    }
    const key = anchorKey(bm.chapterUid, bm.range);
    const fromNote = byAnchor.get(key);
    if (fromNote && fromNote.kind === "from_note" && !fromNote.wereadBookmarkId) {
      // 先写了想法、后来又真的划了线：认领那条补建的划线。
      tx.update(highlights)
        .set({ wereadBookmarkId: bm.bookmarkId, kind: "marked", deletedAtSourceAt: null })
        .where(eq(highlights.id, fromNote.id))
        .run();
      continue;
    }
    const created = tx
      .insert(highlights)
      .values({
        bookId,
        chapterId: chapterOf(bm.chapterUid),
        source: "weread",
        kind: "marked",
        wereadBookmarkId: bm.bookmarkId,
        text: bm.markText,
        range: bm.range ?? null,
        markedAt: fromUnix(bm.createTime),
        createdAt: now,
      })
      .returning()
      .get();
    byAnchor.set(key, created);
    out.newHighlightIds.push(created.id);
  }
  for (const h of local) {
    if (h.wereadBookmarkId && !seenBookmarks.has(h.wereadBookmarkId) && !h.deletedAtSourceAt) {
      tx.update(highlights).set({ deletedAtSourceAt: now }).where(eq(highlights.id, h.id)).run();
      out.markedDeleted++;
    }
  }

  // —— 想法 ——
  const localNotes = tx
    .select({ note: notes })
    .from(notes)
    .innerJoin(highlights, eq(highlights.id, notes.highlightId))
    .where(and(eq(highlights.bookId, bookId), eq(notes.source, "weread")))
    .all()
    .map((r) => r.note);
  const byReview = new Map(localNotes.filter((n) => n.wereadReviewId).map((n) => [n.wereadReviewId!, n]));
  const seenReviews = new Set<string>();
  const localReviews = new Map(
    tx
      .select()
      .from(reviews)
      .where(eq(reviews.bookId, bookId))
      .all()
      .filter((r) => r.wereadReviewId)
      .map((r) => [r.wereadReviewId!, r]),
  );
  const seenBookReviews = new Set<string>();
  for (const rv of src.reviews) {
    if (!rv.range || !rv.abstract) {
      // 不对应原文：整本书的书评或章节点评。
      seenBookReviews.add(rv.reviewId);
      const star = normalizeStar(rv.star);
      const known = localReviews.get(rv.reviewId);
      if (known) {
        if (known.content !== rv.content || known.deletedAtSourceAt || known.star !== star) {
          tx.update(reviews).set({ content: rv.content, star, deletedAtSourceAt: null }).where(eq(reviews.id, known.id)).run();
        }
      } else if (rv.content.trim() || star) {
        tx.insert(reviews)
          .values({
            bookId,
            chapterId: chapterOf(rv.chapterUid && rv.chapterUid > 0 ? rv.chapterUid : undefined),
            source: "weread",
            wereadReviewId: rv.reviewId,
            content: rv.content,
            star,
            writtenAt: fromUnix(rv.createTime),
            createdAt: now,
          })
          .run();
        out.newReviews++;
      }
      continue;
    }
    seenReviews.add(rv.reviewId);
    const known = byReview.get(rv.reviewId);
    if (known) {
      if (known.content !== rv.content || known.deletedAtSourceAt) {
        tx.update(notes).set({ content: rv.content, deletedAtSourceAt: null }).where(eq(notes.id, known.id)).run();
      }
      continue;
    }
    const key = anchorKey(rv.chapterUid, rv.range);
    let anchor = byAnchor.get(key);
    if (!anchor) {
      anchor = tx
        .insert(highlights)
        .values({
          bookId,
          chapterId: chapterOf(rv.chapterUid),
          source: "weread",
          kind: "from_note",
          text: rv.abstract,
          range: rv.range,
          markedAt: fromUnix(rv.createTime),
          createdAt: now,
        })
        .returning()
        .get();
      byAnchor.set(key, anchor);
      out.newHighlightIds.push(anchor.id);
    }
    const note = tx
      .insert(notes)
      .values({
        highlightId: anchor.id,
        source: "weread",
        wereadReviewId: rv.reviewId,
        content: rv.content,
        writtenAt: fromUnix(rv.createTime),
        createdAt: now,
      })
      .returning()
      .get();
    out.newNoteIds.push(note.id);
  }
  for (const n of localNotes) {
    if (n.wereadReviewId && !seenReviews.has(n.wereadReviewId) && !n.deletedAtSourceAt) {
      tx.update(notes).set({ deletedAtSourceAt: now }).where(eq(notes.id, n.id)).run();
      out.markedDeleted++;
    }
  }
  for (const r of localReviews.values()) {
    if (!seenBookReviews.has(r.wereadReviewId!) && !r.deletedAtSourceAt) {
      tx.update(reviews).set({ deletedAtSourceAt: now }).where(eq(reviews.id, r.id)).run();
      out.markedDeleted++;
    }
  }
  out.markedDeleted += markOrphanedFromNoteHighlights(tx, bookId, now);
  return out;
}

/** 补建的划线只因想法而存在；它的想法在源端全被删除后，它也视为源端已删除。 */
function markOrphanedFromNoteHighlights(tx: Conn, bookId: string, now: Date): number {
  const candidates = tx
    .select({ id: highlights.id })
    .from(highlights)
    .where(
      and(
        eq(highlights.bookId, bookId),
        eq(highlights.kind, "from_note"),
        isNull(highlights.wereadBookmarkId),
        isNull(highlights.deletedAtSourceAt),
      ),
    )
    .all()
    .map((h) => h.id);
  if (candidates.length === 0) return 0;
  const alive = new Set(
    tx
      .select({ highlightId: notes.highlightId })
      .from(notes)
      .where(and(inArray(notes.highlightId, candidates), isNull(notes.deletedAtSourceAt)))
      .all()
      .map((n) => n.highlightId),
  );
  const orphaned = candidates.filter((id) => !alive.has(id));
  if (orphaned.length) tx.update(highlights).set({ deletedAtSourceAt: now }).where(inArray(highlights.id, orphaned)).run();
  return orphaned.length;
}

/** 按 chapterUid 对齐章节（新增或更新标题、序号），返回 chapterUid → 本地 id。 */
export function upsertChapters(tx: Conn, bookId: string, list: (WereadChapter & { level?: number })[]): Map<number, string> {
  const existing = tx.select().from(chapters).where(eq(chapters.bookId, bookId)).all();
  const ids = new Map(existing.filter((c) => c.wereadChapterUid !== null).map((c) => [c.wereadChapterUid!, c.id]));
  for (const c of list) {
    const id = ids.get(c.chapterUid);
    if (id) {
      tx.update(chapters)
        .set({ idx: c.chapterIdx, title: c.title, ...(c.level === undefined ? {} : { level: c.level }) })
        .where(eq(chapters.id, id))
        .run();
    } else {
      const row = tx
        .insert(chapters)
        .values({ bookId, wereadChapterUid: c.chapterUid, idx: c.chapterIdx, title: c.title, level: c.level ?? 1 })
        .returning()
        .get();
      ids.set(c.chapterUid, row.id);
    }
  }
  return ids;
}
