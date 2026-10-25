import type { Command } from "commander";
import {
  countEmptyBooks,
  getBookDetail,
  listBooks,
  listGuides,
  parseReadingMode,
  quizBrief,
  recapBrief,
  readingModeOf,
  describeReadingMode,
  reviewsOf,
  setPurpose,
  setReadingMode,
} from "@bookside/core";
import { day, emit, emitBrief, getDb, indent, readContent, ref, resolve, statusLabel } from "../context.ts";
import { tocAction } from "./guide.ts";

export function registerBooks(program: Command): void {
  program
    .command("books")
    .description("书单（最近有划线的在前）")
    .option("-q, --query <text>", "按书名或作者筛选（会包含还没有划线的书）")
    .option("--all", "包含还没有划线、问题或读前目的的书")
    .action((opts: { query?: string; all?: boolean }) => {
      const list = listBooks(getDb(), { query: opts.query, includeEmpty: opts.all });
      const hidden = opts.query || opts.all ? 0 : countEmptyBooks(getDb());
      const footer = hidden ? `\n另有 ${hidden} 本书架上的书还没有划线，加 --all 查看。` : "";
      emit(list, () =>
        list.length === 0
          ? "没有书。用 bookside sync 同步微信读书、bookside import 导入 Kindle，或 bookside sample 放入示例书。"
          : list
              .map((b) => {
                const bits = [
                  b.author,
                  readingModeOf(b).label,
                  b.progress === null ? undefined : `进度 ${b.progress}%`,
                  b.finishedAt ? "已读完" : undefined,
                  `划线 ${b.highlightCount}`,
                  b.pendingProbeCount ? `待处理追问 ${b.pendingProbeCount}` : undefined,
                  b.questionCount ? `问题 ${b.questionCount}` : undefined,
                ].filter(Boolean);
                return `${ref("book", b.id)}  《${b.title}》  ${bits.join(" · ")}`;
              })
              .join("\n") + footer,
      );
    });

  const book = program.command("book").description("单书工作台");

  book
    .command("show <book>")
    .description("按章节查看划线与想法、待处理追问和起源于此书的问题")
    .option("--all", "包含源端已删除的划线和想法")
    .action((input: string, opts: { all?: boolean }) => {
      const d = getBookDetail(getDb(), resolve("book", input), { includeDeleted: opts.all });
      emit(d, () => {
        const b = d.book;
        const lines = [
          `${ref("book", b.id)}  《${b.title}》${b.author ? ` ${b.author}` : ""}${b.progress === null ? "" : ` · 进度 ${b.progress}%`}${b.finishedAt ? " · 已读完" : ""}`,
          `${describeReadingMode(readingModeOf(b))}${readingModeOf(b).origin === "default" ? `（判断后用 bookside book mode ${ref("book", b.id)} <读法> 写回）` : ""}`,
          `读前目的：${b.purpose ?? "（未填写）"}`,
        ];
        for (const r of reviewsOf(getDb(), b.id, null)) lines.push(`全书书评（${day(r.writtenAt)}）：${r.content}`);
        const guides = listGuides(getDb(), b.id);
        if (guides.length) {
          const names = guides.map((g) => (g.chapterTitle ? `章节导读「${g.chapterTitle}」` : "全书导读"));
          lines.push(`AI 导读：${names.join("、")}（bookside guide ${ref("book", b.id)} 查看）`);
        }
        for (const c of d.chapters) {
          lines.push("", `## ${c.title || "（未分章）"}`);
          for (const h of c.highlights) {
            const flags = [h.kind === "from_note" ? "由想法带出" : "", h.deletedAtSourceAt ? "源端已删除" : ""].filter(Boolean);
            lines.push(`- [${ref("highlight", h.id)}] ${h.text}${flags.length ? `（${flags.join("，")}）` : ""}`);
            for (const n of h.notes) lines.push(indent(`想法 [${ref("note", n.id)}] ${day(n.writtenAt)}：${n.content}`));
          }
        }
        if (d.pendingProbes.length) {
          lines.push("", "待处理追问：");
          for (const p of d.pendingProbes) lines.push(`- [${ref("probe", p.id)}] ${p.content}`);
        }
        if (d.questions.length) {
          lines.push("", "问题：");
          for (const q of d.questions) lines.push(`- [${ref("question", q.id)}] ${statusLabel(q.status)}  ${q.title}`);
        }
        return lines.join("\n");
      });
    });

  book
    .command("toc <book>")
    .description("从微信读书取目录，标出已有章节导读的章节")
    .action(tocAction);

  book
    .command("recap <book>")
    .description("我的划线回顾（给智能体）：读者在这本书里划了什么、反复关注什么，讲给读者听")
    .action((input: string) => emitBrief(recapBrief(getDb(), resolve("book", input))));

  book
    .command("quiz <book>")
    .description("考考我（给智能体）：用读者的划线、导读和 TA 写下的理解出 3 道题，一次问一道")
    .action((input: string) => emitBrief(quizBrief(getDb(), resolve("book", input))));

  book
    .command("mode <book> <mode>")
    .description("改这本书的读法：思辨(argument) / 实践(practice) / 知识(knowledge) / 叙事(narrative)")
    .action((input: string, mode: string) => {
      const b = setReadingMode(getDb(), resolve("book", input), parseReadingMode(mode));
      emit(b, () => `《${b.title}》的读法改为${readingModeOf(b).label}。`);
    });

  book
    .command("purpose <book> <text>")
    .description("记下读前目的：为什么读、想带走什么（text 为 - 时读标准输入）")
    .action((input: string, text: string) => {
      const b = setPurpose(getDb(), resolve("book", input), readContent(text));
      emit(b, () => `已记下《${b.title}》的读前目的。`);
    });
}
