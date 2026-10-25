import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/client.ts";
import { books, highlights, notes, reviews } from "../db/schema.ts";
import type { NotebookEntry, ShelfBook, WereadBookmark, WereadChapter, WereadReview, WereadSource } from "./client.ts";
import { syncWeread } from "./sync.ts";

/** 可变的假数据源：测试里直接改它的字段来模拟用户在微信读书里的操作。 */
class FakeWeread implements WereadSource {
  shelfBooks: ShelfBook[] = [{ bookId: "B1", title: "思考，快与慢", author: "卡尼曼" }];
  chapters: WereadChapter[] = [{ chapterUid: 10, chapterIdx: 1, title: "第一章" }];
  marks: WereadBookmark[] = [];
  reviews: WereadReview[] = [];
  listed = true;
  calls: string[] = [];

  async shelf() {
    return this.shelfBooks;
  }
  async notebooks(): Promise<NotebookEntry[]> {
    if (!this.listed) return [];
    const times = [...this.marks, ...this.reviews].map((x) => x.createTime);
    return [
      {
        bookId: "B1",
        book: { title: "思考，快与慢", author: "卡尼曼" },
        noteCount: this.marks.length,
        reviewCount: this.reviews.length,
        readingProgress: 40,
        sort: Math.max(0, ...times),
      },
    ];
  }
  async bookmarks(bookId: string) {
    this.calls.push(`bookmarks:${bookId}`);
    return { bookmarks: this.marks, chapters: this.chapters };
  }
  async myReviews(bookId: string) {
    this.calls.push(`reviews:${bookId}`);
    return this.reviews;
  }
}

const mark = (id: string, range: string, t = 100): WereadBookmark => ({
  bookmarkId: id,
  chapterUid: 10,
  range,
  markText: `原文${id}`,
  createTime: t,
});
const review = (id: string, range: string | undefined, t = 100, content = `想法${id}`): WereadReview => ({
  reviewId: id,
  chapterUid: 10,
  range,
  abstract: range ? `原文@${range}` : undefined,
  content,
  createTime: t,
});

let db: Db;
let src: FakeWeread;
const allHighlights = () => db.select().from(highlights).all();
const allNotes = () => db.select().from(notes).all();

beforeEach(() => {
  db = openDb(":memory:");
  src = new FakeWeread();
});

describe("syncWeread", () => {
  it("imports everything as a baseline the first time, without reporting anything as new", async () => {
    src.shelfBooks.push({ bookId: "B2", title: "还没划线的书" });
    src.marks = [mark("m1", "1-10")];
    src.reviews = [review("r1", "1-10")];
    const r = await syncWeread(db, src);
    expect(r).toMatchObject({ baseline: true, booksSynced: 1, newHighlightIds: [], newNoteIds: [] });
    expect(db.select().from(books).all().map((b) => b.title).sort()).toEqual(["思考，快与慢", "还没划线的书"]);
    expect(db.select().from(books).where(eq(books.wereadBookId, "B1")).get()).toMatchObject({ progress: 40, author: "卡尼曼" });
    expect(allHighlights()).toHaveLength(1);
    expect(allNotes()[0]).toMatchObject({ highlightId: allHighlights()[0]!.id, content: "想法r1" });
    expect(allHighlights()[0]!.probeConsideredAt).not.toBeNull();
    expect(allNotes()[0]!.probeConsideredAt).not.toBeNull();
    expect(allHighlights()[0]!.activationConsideredAt).not.toBeNull();
  });

  it("reports progress book by book", async () => {
    const seen: [number, number][] = [];
    await syncWeread(db, src, new Date(), { onProgress: (done, total) => seen.push([done, total]) });
    expect(seen).toEqual([
      [0, 1],
      [1, 1],
    ]);
  });

  it("leaves content added after the baseline unconsidered, for probe generation", async () => {
    await syncWeread(db, src);
    src.marks = [mark("m1", "1-10", 200)];
    await syncWeread(db, src);
    expect(allHighlights()[0]!.probeConsideredAt).toBeNull();
  });

  it("collapses stray whitespace in titles and authors", async () => {
    src.shelfBooks = [{ bookId: "B1", title: " 沉思录 ", author: "马可·奥勒留著\n译之译" }];
    src.listed = false;
    await syncWeread(db, src);
    expect(db.select().from(books).get()).toMatchObject({ title: "沉思录", author: "马可·奥勒留著 译之译" });
  });

  it("keeps the cover from the shelf and does not erase it when a later sync lacks one", async () => {
    src.shelfBooks = [{ bookId: "B1", title: "沉思录", cover: "https://cdn/c.jpg" }];
    src.listed = false;
    await syncWeread(db, src);
    src.shelfBooks = [{ bookId: "B1", title: "沉思录" }];
    await syncWeread(db, src);
    expect(db.select().from(books).get()!.cover).toBe("https://cdn/c.jpg");
  });

  it("skips books whose notes have not changed", async () => {
    src.marks = [mark("m1", "1-10")];
    await syncWeread(db, src);
    src.calls = [];
    expect((await syncWeread(db, src)).booksSynced).toBe(0);
    expect(src.calls).toEqual([]);
  });

  it("reports highlights and notes added after the baseline", async () => {
    src.marks = [mark("m1", "1-10")];
    await syncWeread(db, src);
    src.marks.push(mark("m2", "20-30", 200));
    src.reviews.push(review("r1", "1-10", 201));
    const r = await syncWeread(db, src);
    const m2 = allHighlights().find((h) => h.wereadBookmarkId === "m2")!;
    expect(r).toMatchObject({ baseline: false, newHighlightIds: [m2.id] });
    expect(r.newNoteIds).toHaveLength(1);
  });

  it("keeps a highlight deleted at the source, marked, and revives it if it comes back", async () => {
    src.marks = [mark("m1", "1-10"), mark("m2", "20-30")];
    await syncWeread(db, src);
    src.marks = [mark("m1", "1-10")];
    expect((await syncWeread(db, src)).markedDeleted).toBe(1);
    const m2 = () => allHighlights().find((h) => h.wereadBookmarkId === "m2")!;
    expect(m2().deletedAtSourceAt).not.toBeNull();
    src.marks = [mark("m1", "1-10"), mark("m2", "20-30")];
    src.reviews = [review("r9", "50-60", 300)]; // 让指纹变化
    await syncWeread(db, src);
    expect(m2().deletedAtSourceAt).toBeNull();
  });

  it("creates a from-note highlight for a note on unmarked text, and adopts it once the text is marked", async () => {
    src.reviews = [review("r1", "5-9")];
    await syncWeread(db, src);
    expect(allHighlights()).toMatchObject([{ kind: "from_note", text: "原文@5-9", wereadBookmarkId: null }]);
    src.marks = [mark("m1", "5-9", 200)];
    const r = await syncWeread(db, src);
    expect(r.newHighlightIds).toEqual([]);
    expect(allHighlights()).toMatchObject([{ kind: "marked", wereadBookmarkId: "m1" }]);
    expect(allNotes()).toHaveLength(1);
  });

  it("does not confuse the same range in different chapters", async () => {
    src.chapters.push({ chapterUid: 11, chapterIdx: 2, title: "第二章" });
    src.marks = [mark("m1", "1-10")];
    src.reviews = [{ ...review("r1", "1-10"), chapterUid: 11 }];
    await syncWeread(db, src);
    expect(allHighlights().map((h) => h.kind).sort()).toEqual(["from_note", "marked"]);
  });

  it("creates a placeholder chapter for an unknown chapterUid so later syncs still match", async () => {
    src.chapters = [];
    src.reviews = [review("r1", "5-9")];
    await syncWeread(db, src);
    src.marks = [mark("m1", "5-9", 200)];
    await syncWeread(db, src);
    expect(allHighlights()).toHaveLength(1);
  });

  it("updates edited notes and marks deleted ones, retiring their from-note highlight", async () => {
    src.reviews = [review("r1", "5-9"), review("r2", "1-3")];
    await syncWeread(db, src);
    src.reviews = [review("r1", "5-9", 200, "改过的想法")];
    await syncWeread(db, src);
    const byReview = (id: string) => allNotes().find((n) => n.wereadReviewId === id)!;
    expect(byReview("r1").content).toBe("改过的想法");
    expect(byReview("r2").deletedAtSourceAt).not.toBeNull();
    const orphan = allHighlights().find((h) => h.id === byReview("r2").highlightId)!;
    expect(orphan.deletedAtSourceAt).not.toBeNull();
  });

  it("imports whole-book and chapter reviews as reviews, marking deletions", async () => {
    src.reviews = [{ ...review("r1", undefined), chapterUid: undefined, star: 4 }, { ...review("r2", undefined), chapterUid: 10 }];
    await syncWeread(db, src);
    expect(allNotes()).toEqual([]);
    const rows = db.select().from(reviews).all();
    expect(rows.map((r) => [r.wereadReviewId, r.chapterId === null, r.star])).toEqual([
      ["r1", true, 4],
      ["r2", false, null],
    ]);
    src.reviews = [{ ...review("r1", undefined, 300, "改过"), chapterUid: undefined, star: 5 }];
    const r = await syncWeread(db, src);
    expect(r.markedDeleted).toBe(1);
    expect(db.select().from(reviews).all().map((x) => [x.content, x.deletedAtSourceAt === null])).toEqual([
      ["改过", true],
      ["想法r2", false],
    ]);
  });

  it("imports a rating-only review, normalizing a 0–100 star to 1–5", async () => {
    src.reviews = [{ ...review("r1", undefined, 100, ""), chapterUid: undefined, star: 100 }];
    await syncWeread(db, src);
    expect(db.select().from(reviews).all().map((r) => [r.content, r.star])).toEqual([["", 5]]);
  });

  it("re-checks every book when asked for a full sync", async () => {
    src.marks = [mark("m1", "1-10")];
    await syncWeread(db, src);
    src.calls = [];
    await syncWeread(db, src, new Date(), { full: true });
    expect(src.calls).toEqual(["bookmarks:B1", "reviews:B1"]);
  });

  it("re-checks a book that vanished from the notebooks and marks its notes deleted", async () => {
    src.marks = [mark("m1", "1-10")];
    await syncWeread(db, src);
    src.listed = false;
    src.marks = [];
    expect((await syncWeread(db, src)).markedDeleted).toBe(1);
    src.calls = [];
    await syncWeread(db, src);
    expect(src.calls).toEqual([]);
  });
});
