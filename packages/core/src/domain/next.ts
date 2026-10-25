// 下次聊书时先提哪一件：一次只提一件，其余等你问。
// 优先有新的跨书关联在等你确认，其次你正在聊的那本书上到期的问题，再次到期最久的问题，最后是待处理的追问。
import type { Conn } from "./conn.ts";
import { type Link, pendingProposals } from "./links.ts";
import { type Probe, pendingProbes } from "./probes.ts";
import { type Question, dueRevisits } from "./questions.ts";
import { listQuestions } from "./threads.ts";

export type Suggestion =
  | { kind: "link"; link: Link }
  | { kind: "revisit"; question: Question; fromThisBook: boolean }
  | { kind: "probe"; probe: Probe };

export type NextUp = {
  /** 按先后排好的全部候选；开场只提第一件。 */
  items: Suggestion[];
  counts: { links: number; revisits: number; probes: number };
};

export function nextUp(conn: Conn, opts: { bookId?: string } = {}, now = new Date()): NextUp {
  const links = pendingProposals(conn);
  const due = dueRevisits(conn, now);
  const ofBook = new Set(opts.bookId ? listQuestions(conn, { bookId: opts.bookId }).map((q) => q.id) : []);
  const probes = pendingProbes(conn, { bookId: opts.bookId }).reverse();
  const items: Suggestion[] = [
    ...links.map((link) => ({ kind: "link" as const, link })),
    ...due.filter((q) => ofBook.has(q.id)).map((question) => ({ kind: "revisit" as const, question, fromThisBook: true })),
    ...due.filter((q) => !ofBook.has(q.id)).map((question) => ({ kind: "revisit" as const, question, fromThisBook: false })),
    ...probes.map((probe) => ({ kind: "probe" as const, probe })),
  ];
  return { items, counts: { links: links.length, revisits: due.length, probes: probes.length } };
}
