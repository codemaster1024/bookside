import type { Command } from "commander";
import { addLocalNote, pickRereads, searchAll } from "@bookside/core";
import { day, emit, getDb, indent, readContent, ref, resolve } from "../context.ts";

export function registerExtra(program: Command): void {
  program
    .command("search <words...>")
    .description("在书、划线、想法、问题（含线程里的话）和观点里一起搜；几个词用空格分开时要同时出现")
    .action((words: string[]) => {
      const hits = searchAll(getDb(), words.join(" "));
      const label = { book: "书", highlight: "划线", note: "想法", question: "问题", insight: "观点" } as const;
      const refOf = (h: (typeof hits)[number]) =>
        h.kind === "book" ? ref("book", h.id) : h.kind === "highlight" ? ref("highlight", h.id) : h.kind === "note" ? ref("note", h.id) : h.kind === "question" ? ref("question", h.id) : ref("insight", h.id);
      emit(hits, () =>
        hits.length === 0
          ? "没有找到。"
          : hits
              .map((h) => [`[${refOf(h)}] ${label[h.kind]}${h.bookTitle && h.kind !== "book" ? ` · 《${h.bookTitle}》` : ""}  ${h.title}`, ...(h.snippet ? [indent(h.snippet)] : [])].join("\n"))
              .join("\n"),
      );
    });

  program
    .command("reread")
    .description("重温：挑几条一个月以前划的线（写过想法的优先），两个月内不重复；只在用户想翻翻旧划线时用")
    .option("--book <book>", "只从这本书里挑")
    .option("--count <n>", "挑几条", (v) => Number.parseInt(v, 10), 3)
    .action((opts: { book?: string; count: number }) => {
      const list = pickRereads(getDb(), { count: opts.count, bookId: opts.book ? resolve("book", opts.book) : undefined });
      emit(list, () =>
        list.length === 0
          ? "没有可以重温的旧划线：要一个月以前划的，而且最近两个月没重温过。"
          : [
              ...list.map((r) =>
                [
                  `[${ref("highlight", r.highlightId)}] 《${r.bookTitle}》${r.chapter ? ` ${r.chapter}` : ""} · 你划于 ${day(r.markedAt)}`,
                  indent(r.text),
                  ...r.notes.map((n) => indent(`当时写的想法（${day(n.writtenAt)}）：${n.content}`)),
                ].join("\n"),
              ),
              "",
              "一条一条读给用户，问 TA 现在读来怎么看、和当时想的有没有不同。TA 有新想法，用 bookside note add h:… - 记下 TA 的原话。",
            ].join("\n"),
      );
    });

  // —— 在书畔里写想法 ——
  const note = program.command("note").description("想法");
  note
    .command("add <highlight> <content>")
    .description("对一条划线写下想法（content 为 - 时读标准输入）")
    .action((input: string, content: string) => {
      const n = addLocalNote(getDb(), resolve("highlight", input), readContent(content));
      emit(n, () => `已记下想法 ${ref("note", n.id)}。`);
    });
}
