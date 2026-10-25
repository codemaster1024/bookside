// 把 Kindle 的摘录导入书畔：同一个文件可以反复导入，只增加新内容。
// 划线按「书 + 起始位置」认：Kindle 改动一条划线时会在文件末尾追加一条同起点的新摘录，后来的覆盖先前的文字。
// 笔记挂在位置落在其区间里的划线上；找不到时补建一条「由想法带出」的划线。
import { and, eq } from "drizzle-orm";
import { books, highlights, notes, syncState } from "../db/schema.ts";
import type { Conn } from "../domain/conn.ts";
import { type Clipping, parseClippings } from "./clippings.ts";

const BASELINE_KEY = "kindle.baseline_at";

export type KindleImportResult = {
  /** 第一次导入：这批内容视为已考虑过，不会触发追问和跨书激活（与微信读书的基线一样）。 */
  baseline: boolean;
  books: number;
  newHighlights: number;
  updatedHighlights: number;
  newNotes: number;
};

type Located = { id: string; start: number; end: number; text: string };

const rangeOf = (c: Clipping) => (c.byPage ? `p${c.start}` : c.start === c.end ? `${c.start}` : `${c.start}-${c.end}`);

function parseRange(range: string | null): { start: number; end: number } | undefined {
  const m = range?.match(/^p?(\d+)(?:-(\d+))?$/);
  return m ? { start: Number(m[1]), end: Number(m[2] ?? m[1]) } : undefined;
}

export function importKindle(db: Conn, file: string, now = new Date()): KindleImportResult {
  const clippings = parseClippings(file);
  return db.transaction((tx) => {
    const baseline = !tx.select().from(syncState).where(eq(syncState.key, BASELINE_KEY)).get();
    const considered = baseline ? { probeConsideredAt: now, activationConsideredAt: now } : {};
    const result: KindleImportResult = { baseline, books: 0, newHighlights: 0, updatedHighlights: 0, newNotes: 0 };

    const byBook = new Map<string, Clipping[]>();
    for (const c of clippings) {
      const key = `${c.title}\u0000${c.author ?? ""}`;
      byBook.set(key, [...(byBook.get(key) ?? []), c]);
    }

    for (const list of byBook.values()) {
      const { title, author } = list[0]!;
      const bookId = ensureBook(tx, title, author);
      result.books++;
      const located: Located[] = tx
        .select()
        .from(highlights)
        .where(and(eq(highlights.bookId, bookId), eq(highlights.source, "kindle")))
        .all()
        .flatMap((h) => {
          const r = parseRange(h.range);
          return r ? [{ id: h.id, ...r, text: h.text }] : [];
        });

      // 同一起点只留文件里最后一条（Kindle 按时间追加，后来的是改过的）。
      const latest = new Map<number, Clipping>();
      for (const c of list) if (c.kind === "highlight") latest.set(c.start, c);
      for (const c of latest.values()) {
        const same = located.find((h) => h.start === c.start);
        if (same) {
          if (same.text === c.text && same.end === c.end) continue;
          tx.update(highlights).set({ text: c.text, range: rangeOf(c) }).where(eq(highlights.id, same.id)).run();
          Object.assign(same, { text: c.text, end: c.end });
          result.updatedHighlights++;
          continue;
        }
        const h = tx
          .insert(highlights)
          .values({ bookId, source: "kindle", text: c.text, range: rangeOf(c), markedAt: c.addedAt ?? now, createdAt: now, ...considered })
          .returning()
          .get();
        located.push({ id: h.id, start: c.start, end: c.end, text: c.text });
        result.newHighlights++;
      }

      for (const c of list.filter((x) => x.kind === "note")) {
        const covering = located.filter((h) => h.start <= c.start && c.start <= h.end).sort((a, b) => a.end - a.start - (b.end - b.start));
        let highlightId = covering[0]?.id;
        if (!highlightId) {
          const h = tx
            .insert(highlights)
            .values({
              bookId,
              source: "kindle",
              kind: "from_note",
              text: `（Kindle ${c.byPage ? "第 " + c.start + " 页" : "位置 " + c.start}，没有划线）`,
              range: rangeOf(c),
              markedAt: c.addedAt ?? now,
              createdAt: now,
              // 补建的划线没有原文，只作笔记的锚点：不为它写追问、做激活，笔记本身照常。
              probeConsideredAt: now,
              activationConsideredAt: now,
            })
            .returning()
            .get();
          located.push({ id: h.id, start: c.start, end: c.end, text: h.text });
          highlightId = h.id;
        }
        const dup = tx
          .select({ id: notes.id })
          .from(notes)
          .where(and(eq(notes.highlightId, highlightId), eq(notes.content, c.text)))
          .get();
        if (dup) continue;
        tx.insert(notes)
          .values({ highlightId, source: "kindle", content: c.text, writtenAt: c.addedAt ?? now, createdAt: now, ...considered })
          .run();
        result.newNotes++;
      }
    }

    if (baseline && clippings.length) tx.insert(syncState).values({ key: BASELINE_KEY, value: now.toISOString() }).run();
    return result;
  });
}

/** Kindle 的书按书名 + 作者认；没有就建一本在书架上的。 */
function ensureBook(tx: Conn, title: string, author: string | null): string {
  const existing = tx
    .select({ id: books.id, author: books.author })
    .from(books)
    .where(and(eq(books.source, "kindle"), eq(books.title, title)))
    .all()
    .find((b) => (b.author ?? null) === author);
  if (existing) return existing.id;
  return tx.insert(books).values({ source: "kindle", title, author }).returning().get().id;
}
