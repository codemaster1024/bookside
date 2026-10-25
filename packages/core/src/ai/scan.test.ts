import { beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/client.ts";
import { books, highlights, notes } from "../db/schema.ts";
import { pendingProposals, proposeLink, rejectLink } from "../domain/links.ts";
import { createQuestion } from "../domain/questions.ts";
import { refOf } from "./brief.ts";
import { keywordCandidates, scanBrief, scanKeywordsBrief, writeScan } from "./scan.ts";

const T = new Date("2026-10-10T00:00:00Z");
let db: Db;
let origin: string;
let other: string;

const book = (title: string) => db.insert(books).values({ source: "weread", title }).returning().get().id;
const highlight = (bookId: string, text: string, at = T) =>
  db.insert(highlights).values({ bookId, source: "weread", text, markedAt: at }).returning().get().id;

beforeEach(() => {
  db = openDb(":memory:");
  origin = book("认知觉醒");
  other = book("微习惯");
});

describe("keywordCandidates", () => {
  it("ranks by matched keywords, counts notes, skips the origin book and one-char words", () => {
    const one = highlight(other, "全凭意志力");
    const two = highlight(other, "坚持靠的是习惯，不是意志力");
    const viaNote = highlight(other, "小到不可能失败");
    db.insert(notes).values({ highlightId: viaNote, source: "weread", content: "这就是坚持的秘密", writtenAt: T }).run();
    highlight(origin, "坚持和意志力");
    highlight(other, "无关");
    const got = keywordCandidates(db, ["坚持", "意志力", "习", " "], origin);
    expect(got.map((h) => h.id)).toEqual([two, one, viaNote]);
    expect(got[2]!.notes).toEqual(["这就是坚持的秘密"]);
  });
});

describe("scan", () => {
  it("asks for keywords first, then hands over the matching highlights from other books", () => {
    const q = createQuestion(db, { title: "为什么反思总是一断就停？", origin: { type: "book", id: origin } });
    const hit = highlight(other, "断了也没关系，第二天继续");
    highlight(origin, "同书里的继续");
    const first = scanKeywordsBrief(db, q.id);
    expect(first.material).toBe("问题：为什么反思总是一断就停？\n起源：《认知觉醒》");
    expect(first.writeBack).toContain(`bookside q scan ${refOf("question", q.id)} --keywords`);
    const second = scanBrief(db, q.id, ["继续", "断"]);
    expect(second.candidates).toBe(1);
    expect(second.material).toContain(`[${refOf("highlight", hit)}] 《微习惯》：断了也没关系`);
    expect(second.material).not.toContain("同书里的继续");
  });

  it("says so when no highlight matches", () => {
    const q = createQuestion(db, { title: "q" });
    expect(scanBrief(db, q.id, ["不存在的词"])).toMatchObject({ candidates: 0, reply: expect.any(String) });
  });

  it("proposes links for highlights outside the origin book, never twice", () => {
    const q = createQuestion(db, { title: "q", origin: { type: "book", id: origin } });
    const hit = highlight(other, "断了也没关系，第二天继续");
    const rejected = highlight(other, "继续写一点点就行");
    const same = highlight(origin, "同书");
    rejectLink(db, proposeLink(db, { from: { type: "highlight", id: rejected }, to: { type: "question", id: q.id }, kind: "answers" }).id);
    const links = writeScan(
      db,
      q.id,
      JSON.stringify({
        links: [
          { from: refOf("highlight", hit), kind: "answers", reason: "断了第二天继续" },
          { from: refOf("highlight", hit), kind: "supports", reason: "重复" },
          { from: refOf("highlight", rejected), kind: "answers", reason: "已被拒绝" },
          { from: refOf("highlight", same), kind: "answers", reason: "同书" },
          { from: "h:deadbeef", kind: "answers", reason: "不存在" },
        ],
      }),
      T,
    );
    expect(links.map((l) => [l.fromId, l.kind, l.reason])).toEqual([[hit, "answers", "断了第二天继续"]]);
    expect(pendingProposals(db)).toHaveLength(1);
  });
});
