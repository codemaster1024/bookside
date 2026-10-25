import type { Command } from "commander";
import {
  addProbe,
  describeProbeTarget,
  dismissProbe,
  pendingProbes,
  probeBrief,
  promoteProbe,
  writeProbes,
} from "@bookside/core";
import { emit, emitBrief, getDb, indent, parseAsOf, perBookLimit, readContent, ref, resolve } from "../context.ts";

export function registerProbes(program: Command): void {
  const probes = program.command("probes").description("追问：AI 抛出、等你认领的提问");

  probes
    .command("list", { isDefault: true })
    .description("待处理的追问，附原文与想法")
    .option("--book <book>", "只看某本书")
    .action((opts: { book?: string }) => {
      const db = getDb();
      const list = pendingProbes(db, { bookId: opts.book ? resolve("book", opts.book) : undefined }).map((p) => ({
        ...p,
        target: describeProbeTarget(db, p),
      }));
      emit(list, () =>
        list.length === 0
          ? "没有待处理的追问。"
          : list
              .map((p) => {
                const lines = [`[${ref("probe", p.id)}] 《${p.target.bookTitle}》 ${p.content}`];
                if (p.target.chapter) lines.push(indent(`章节：${p.target.chapter}`));
                if (p.target.quote) lines.push(indent(`原文：${p.target.quote}`));
                if (p.target.note) lines.push(indent(`想法：${p.target.note}`));
                return lines.join("\n");
              })
              .join("\n"),
      );
    });

  probes
    .command("add <content>")
    .description("添加一条追问，挂在书、划线或想法上（content 为 - 时读标准输入）")
    .option("--book <book>")
    .option("--highlight <highlight>")
    .option("--note <note>")
    .action((content: string, opts: { book?: string; highlight?: string; note?: string }) => {
      const given = [opts.book && "book", opts.highlight && "highlight", opts.note && "note"].filter(Boolean);
      if (given.length !== 1) throw new Error("--book / --highlight / --note 必须恰好给一个");
      const type = given[0] as "book" | "highlight" | "note";
      const id = resolve(type, (opts[type] as string));
      const p = addProbe(getDb(), { target: { type, id }, content: readContent(content) });
      emit(p, () => `已添加追问 ${ref("probe", p.id)}。`);
    });

  probes
    .command("promote <probe>")
    .description("升格：把追问认领为问题")
    .option("--title <title>", "问题标题，默认沿用追问原文")
    .action((input: string, opts: { title?: string }) => {
      const q = promoteProbe(getDb(), resolve("probe", input), { title: opts.title });
      emit(q, () => `已升格为问题 ${ref("question", q.id)}：${q.title}`);
    });

  probes
    .command("dismiss <probe>")
    .description("搁置：不认领这条追问")
    .action((input: string) => {
      const p = dismissProbe(getDb(), resolve("probe", input));
      emit(p, () => `已搁置 ${ref("probe", p.id)}。`);
    });

  probes
    .command("brief <book>")
    .description("给智能体：取一本书里新划线和新想法的材料，写好追问后用 probes write 写回")
    .action((input: string) => emitBrief(probeBrief(getDb(), resolve("book", input), { perBookLimit: perBookLimit() })));

  probes
    .command("write <book> <content>")
    .description("给智能体：写回 probes brief 那一批的追问（JSON，content 为 - 时读标准输入）")
    .requiredOption("--as-of <time>", "brief 里给出的时间戳")
    .action((input: string, content: string, opts: { asOf: string }) => {
      const list = writeProbes(getDb(), resolve("book", input), readContent(content), { perBookLimit: perBookLimit(), asOf: parseAsOf(opts.asOf) });
      emit(list, () => (list.length ? `已添加 ${list.length} 条追问：${list.map((p) => ref("probe", p.id)).join(" ")}` : "这一批没有写追问，已记为处理过。"));
    });
}
