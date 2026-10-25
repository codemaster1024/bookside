// 待办：同步之后留给智能体做的 AI 活。它不是读者的任务，智能体开场时做完即可。
import { questions } from "../db/schema.ts";
import type { Conn } from "../domain/conn.ts";
import { describeOrigin } from "../domain/threads.ts";
import { refOf } from "./brief.ts";
import { booksWithCandidates, loadCandidates, markConsidered } from "./candidates.ts";

export type Todo = {
  kind: "probes" | "activation";
  bookId: string;
  bookTitle: string;
  /** 这本书里等着处理的新划线与新想法条数。 */
  count: number;
  /** 取材料的命令。 */
  brief: string;
};

const newCount = (db: Conn, bookId: string, marker: "probe" | "activation") =>
  loadCandidates(db, bookId, marker).reduce((n, c) => n + (c.isNew ? 1 : 0) + c.notes.filter((x) => x.isNew).length, 0);

/** 有没有起源于这本书以外的问题：没有的话，跨书激活无事可做。 */
function hasOtherQuestions(db: Conn, bookId: string): boolean {
  return db
    .select()
    .from(questions)
    .all()
    .some((q) => describeOrigin(db, q)?.bookId !== bookId);
}

export function listTodos(db: Conn, opts: { perBookLimit: number }): Todo[] {
  const out: Todo[] = [];
  if (opts.perBookLimit > 0) {
    for (const b of booksWithCandidates(db, "probe")) {
      out.push({ kind: "probes", bookId: b.id, bookTitle: b.title, count: newCount(db, b.id, "probe"), brief: `bookside probes brief ${refOf("book", b.id)}` });
    }
  }
  for (const b of booksWithCandidates(db, "activation")) {
    if (!hasOtherQuestions(db, b.id)) continue;
    out.push({ kind: "activation", bookId: b.id, bookTitle: b.title, count: newCount(db, b.id, "activation"), brief: `bookside activate brief ${refOf("book", b.id)}` });
  }
  return out;
}

/**
 * 把无事可做的候选直接记为已考虑：不写追问时（perBookLimit 为 0）的全部候选，
 * 以及没有可关联问题的书的激活候选——结果和智能体看过之后"一条都没选"一样。
 */
export function settleTodos(db: Conn, opts: { perBookLimit: number }, now = new Date()): void {
  db.transaction((tx) => {
    if (opts.perBookLimit <= 0) {
      for (const b of booksWithCandidates(tx, "probe")) markConsidered(tx, loadCandidates(tx, b.id, "probe"), "probe", now);
    }
    for (const b of booksWithCandidates(tx, "activation")) {
      if (!hasOtherQuestions(tx, b.id)) markConsidered(tx, loadCandidates(tx, b.id, "activation"), "activation", now);
    }
  });
}
