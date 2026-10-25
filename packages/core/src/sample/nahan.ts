// 示例书：随书畔附带的鲁迅《呐喊》（公版）与几条示范用的划线、想法、追问和一个到了回访时间的问题，
// 让还没接数据源的人先走一遍完整流程。它是小说，读法是叙事；进度停在《故乡》，用来示范不剧透。它是普通的书，可以删除。
import { and, eq, inArray, or } from "drizzle-orm";
import { books, chapters, highlights, insightSources, insights, links, questions, syncState } from "../db/schema.ts";
import type { Conn } from "../domain/conn.ts";
import { DomainError } from "../domain/errors.ts";
import { addLocalNote } from "../domain/notes.ts";
import { addProbe } from "../domain/probes.ts";
import { appendMessage, createQuestion } from "../domain/questions.ts";

const KEY = "sample.book_id";
const DAY = 24 * 60 * 60 * 1000;

/** 章节序号按《呐喊》原书的目录。 */
const CHAPTERS: { idx: number; title: string; lines: string[] }[] = [
  {
    idx: 1,
    title: "自序",
    lines: [
      "我在年青时候也曾经做过许多梦，后来大半忘却了，但自己也并不以为可惜。",
      "假如一间铁屋子，是绝无窗户而万难破毁的，里面有许多熟睡的人们，不久都要闷死了，然而是从昏睡入死灭，并不感到就死的悲哀。",
    ],
  },
  {
    idx: 2,
    title: "狂人日记",
    lines: [
      "我翻开历史一查，这历史没有年代，歪歪斜斜的每叶上都写着“仁义道德”几个字。我横竖睡不着，仔细看了半夜，才从字缝里看出字来，满本都写着两个字是“吃人”！",
    ],
  },
  { idx: 3, title: "孔乙己", lines: ["孔乙己是站着喝酒而穿长衫的唯一的人。"] },
  { idx: 9, title: "故乡", lines: ["希望是本无所谓有，无所谓无的。这正如地上的路；其实地上本没有路，走的人多了，也便成了路。"] },
];

export function sampleBookId(db: Conn): string | undefined {
  const id = db.select().from(syncState).where(eq(syncState.key, KEY)).get()?.value;
  return id && db.select({ id: books.id }).from(books).where(eq(books.id, id)).get() ? id : undefined;
}

/** 放入示例书；已经有了就原样返回。 */
export function loadSample(db: Conn, now = new Date()): { bookId: string; created: boolean } {
  const existing = sampleBookId(db);
  if (existing) return { bookId: existing, created: false };
  const past = new Date(now.getTime() - 4 * DAY);
  // 划线早于一个月，装好就能试「重温旧划线」。
  const marked = new Date(now.getTime() - 45 * DAY);
  return db.transaction((tx) => {
    const bookId = tx
      .insert(books)
      .values({ source: "local", title: "呐喊", author: "鲁迅", category: "文学-中国文学", progress: 45, purpose: "中学课本里读过几篇，想完整地重读一遍", createdAt: past })
      .returning()
      .get().id;
    const ids: string[] = [];
    for (const c of CHAPTERS) {
      const chapterId = tx.insert(chapters).values({ bookId, idx: c.idx, title: c.title }).returning().get().id;
      for (const text of c.lines) {
        // 示范内容不进待办：都算已经考虑过。
        const h = tx
          .insert(highlights)
          .values({ bookId, chapterId, source: "local", text, markedAt: marked, createdAt: past, probeConsideredAt: past, activationConsideredAt: past })
          .returning()
          .get();
        ids.push(h.id);
      }
    }
    const [, ironHouse, , kongYiji, road] = ids;
    addLocalNote(tx, kongYiji!, "读到这句有点难受：他想体面，又体面不起来。", past);
    addProbe(tx, { target: { type: "highlight", id: road! }, content: "读到「走的人多了，也便成了路」，你想到了自己生活里的哪条「路」？" }, past);
    const q = createQuestion(tx, { title: "铁屋子里先醒来的人，该不该叫醒别人？", origin: { type: "highlight", id: ironHouse! } }, past);
    appendMessage(tx, q.id, { speaker: "me", content: "我觉得该叫，哪怕希望很小，至少醒着的人能一起想办法。" }, past);
    appendMessage(
      tx,
      q.id,
      {
        speaker: "ai",
        content:
          "鲁迅在《自序》里也犹豫过：叫醒了却没有出路，醒着的人反而更痛苦。他最后答应写，是因为希望在于将来，不能拿自己的「必无」去否定别人的「可有」。你说「至少能一起想办法」——要是想了也没有办法，你还会叫吗？",
      },
      past,
    );
    tx.insert(syncState).values({ key: KEY, value: bookId }).onConflictDoUpdate({ target: syncState.key, set: { value: bookId } }).run();
    return { bookId, created: true };
  });
}

/** 删除示例书和挂在它上面的问题、观点来源与关联。你在示例书里写下的东西也会一起删掉。 */
export function removeSample(db: Conn): void {
  const bookId = sampleBookId(db);
  if (!bookId) throw new DomainError("not_found", "没有示例书");
  db.transaction((tx) => {
    const hIds = tx.select({ id: highlights.id }).from(highlights).where(eq(highlights.bookId, bookId)).all().map((r) => r.id);
    const cIds = tx.select({ id: chapters.id }).from(chapters).where(eq(chapters.bookId, bookId)).all().map((r) => r.id);
    const qIds = tx
      .select({ id: questions.id })
      .from(questions)
      .where(
        or(
          eq(questions.originBookId, bookId),
          hIds.length ? inArray(questions.originHighlightId, hIds) : undefined,
          cIds.length ? inArray(questions.originChapterId, cIds) : undefined,
        ),
      )
      .all()
      .map((r) => r.id);
    const touched = [bookId, ...hIds, ...cIds, ...qIds];
    tx.delete(links).where(or(inArray(links.fromId, touched), inArray(links.toId, touched))).run();
    const sources = tx
      .select({ insightId: insightSources.insightId })
      .from(insightSources)
      .where(
        or(
          eq(insightSources.bookId, bookId),
          hIds.length ? inArray(insightSources.highlightId, hIds) : undefined,
          qIds.length ? inArray(insightSources.questionId, qIds) : undefined,
        ),
      )
      .all()
      .map((r) => r.insightId);
    if (sources.length) tx.delete(insights).where(inArray(insights.id, sources)).run();
    if (qIds.length) tx.delete(questions).where(inArray(questions.id, qIds)).run();
    tx.delete(books).where(eq(books.id, bookId)).run();
    tx.delete(syncState).where(and(eq(syncState.key, KEY))).run();
  });
}
