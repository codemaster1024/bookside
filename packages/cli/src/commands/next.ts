import type { Command } from "commander";
import { type Suggestion, describeProbeTarget, describeRef, listBooks, nextUp, sampleBookId } from "@bookside/core";
import { emit, getDb, ref, resolve } from "../context.ts";

function line(s: Suggestion): string {
  const db = getDb();
  if (s.kind === "link") {
    const l = s.link;
    return `关联提议 [${ref("link", l.id)}]：${describeRef(db, { type: l.fromType, id: l.fromId }, 60)} → ${describeRef(db, { type: l.toType, id: l.toId }, 60)}${l.reason ? `\n    理由：${l.reason}` : ""}`;
  }
  if (s.kind === "revisit") return `到期的问题 [${ref("question", s.question.id)}]${s.fromThisBook ? "（就是这本书上的）" : ""}：${s.question.title}`;
  const t = describeProbeTarget(db, s.probe);
  return `待处理的追问 [${ref("probe", s.probe.id)}]《${t.bookTitle}》：${s.probe.content}`;
}

const COUNT_KEY = { link: "links", revisit: "revisits", probe: "probes" } as const;

export function registerNext(program: Command): void {
  program
    .command("next")
    .description("给智能体：这次先提哪一件（新的关联提议 > 这本书上到期的问题 > 到期最久的问题 > 待处理的追问），其余等用户问")
    .option("--book <book>", "用户正在聊的书：它上面到期的问题排在前面")
    .action((opts: { book?: string }) => {
      const db = getDb();
      const r = nextUp(db, { bookId: opts.book ? resolve("book", opts.book) : undefined });
      const all = listBooks(db, { includeEmpty: true });
      const onlySample = all.length === 1 && sampleBookId(db) === all[0]!.id;
      const tip = onlySample
        ? "\n\n书架上只有示例书。聊完这一件后，提一次：想换成自己的书，在终端运行 bookside init，选微信读书或 Kindle；不要示例书了，运行 bookside sample --remove。只提一次。"
        : "";
      emit({ ...r, onlySample }, () => {
        const first = r.items[0];
        if (!first) return `没有在等的事，直接聊用户想聊的。${tip}`;
        // 其余的不算已经提的这一件。
        const key = COUNT_KEY[first.kind];
        const c = { ...r.counts, [key]: r.counts[key] - 1 };
        const rest = [c.links && `关联提议 ${c.links} 条`, c.revisits && `到期的问题 ${c.revisits} 个`, c.probes && `待处理的追问 ${c.probes} 条`].filter(Boolean);
        return `先提这一件：\n${line(first)}\n\n${rest.length ? `其余（用户问"还有什么"时再说）：${rest.join("、")}` : "没有别的在等了。"}${tip}`;
      });
    });
}
