// 示例书：随书畔附带的鲁迅《呐喊》（公版）与二十来条示范用的划线、一条想法、一条追问和一个到了回访时间的问题，
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

/**
 * 章节序号按《呐喊》原书的目录；只到《故乡》（进度停在这里）。
 * 划线够 20 条，装好就能请智能体写一份读书画像。ago 是划下时距今几天，散开一些，热力图上才看得出节奏。
 */
const CHAPTERS: { idx: number; title: string; ago: number; lines: string[] }[] = [
  {
    idx: 1,
    title: "自序",
    ago: 58,
    lines: [
      "我在年青时候也曾经做过许多梦，后来大半忘却了，但自己也并不以为可惜。",
      "凡是愚弱的国民，即使体格如何健全，如何茁壮，也只能做毫无意义的示众的材料和看客，病死多少是不必以为不幸的。",
      "我感到未尝经验的无聊，是自此以后的事。",
      "假如一间铁屋子，是绝无窗户而万难破毁的，里面有许多熟睡的人们，不久都要闷死了，然而是从昏睡入死灭，并不感到就死的悲哀。",
      "然而几个人既然起来，你不能说决没有毁坏这铁屋的希望。",
      "然而说到希望，却是不能抹杀的，因为希望是在于将来，决不能以我之必无的证明，来折服了他之所谓可有。",
    ],
  },
  {
    idx: 2,
    title: "狂人日记",
    ago: 52,
    lines: [
      "凡事总须研究，才会明白。",
      "我翻开历史一查，这历史没有年代，歪歪斜斜的每叶上都写着“仁义道德”几个字。我横竖睡不着，仔细看了半夜，才从字缝里看出字来，满本都写着两个字是“吃人”！",
      "从来如此，便对么？",
      "有了四千年吃人履历的我，当初虽然不知道，现在明白，难见真的人！",
      "没有吃过人的孩子，或者还有？救救孩子……",
    ],
  },
  {
    idx: 3,
    title: "孔乙己",
    ago: 47,
    lines: ["孔乙己是站着喝酒而穿长衫的唯一的人。", "多乎哉？不多也。", "孔乙己是这样的使人快活，可是没有他，别人也便这么过。", "我到现在终于没有见——大约孔乙己的确死了。"],
  },
  { idx: 4, title: "药", ago: 44, lines: ["他的精神，现在只在一个包上，仿佛抱着一个十世单传的婴儿，别的事情，都已置之度外了。"] },
  {
    idx: 6,
    title: "一件小事",
    ago: 40,
    lines: ["独有这一件小事，却总是浮在我眼前，有时反更分明，教我惭愧，催我自新，并且增长我的勇气和希望。"],
  },
  { idx: 7, title: "头发的故事", ago: 38, lines: ["改革么，武器在那里？工读么，工厂在那里？"] },
  { idx: 8, title: "风波", ago: 36, lines: ["一代不如一代！"] },
  {
    idx: 9,
    title: "故乡",
    ago: 33,
    lines: [
      "我似乎打了一个寒噤；我就知道，我们之间已经隔了一层可悲的厚障壁了。",
      "希望是本无所谓有，无所谓无的。这正如地上的路；其实地上本没有路，走的人多了，也便成了路。",
      "我希望他们不再像我，又大家隔膜起来……",
    ],
  },
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
  return db.transaction((tx) => {
    const bookId = tx
      .insert(books)
      .values({ source: "local", title: "呐喊", author: "鲁迅", category: "文学-中国文学", progress: 45, purpose: "中学课本里读过几篇，想完整地重读一遍", createdAt: past })
      .returning()
      .get().id;
    const ids = new Map<string, string>();
    for (const c of CHAPTERS) {
      const chapterId = tx.insert(chapters).values({ bookId, idx: c.idx, title: c.title }).returning().get().id;
      c.lines.forEach((text, i) => {
        // 划线都早于一个月，装好就能试「重温旧划线」；示范内容不进追问和激活的待办：都算已经考虑过。
        const markedAt = new Date(now.getTime() - c.ago * DAY + i * 7 * 60_000);
        const h = tx
          .insert(highlights)
          .values({ bookId, chapterId, source: "local", text, markedAt, createdAt: past, probeConsideredAt: past, activationConsideredAt: past })
          .returning()
          .get();
        ids.set(text.slice(0, 6), h.id);
      });
    }
    const ironHouse = ids.get("假如一间铁屋");
    const kongYiji = ids.get("孔乙己是站着");
    const road = ids.get("希望是本无所");
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
