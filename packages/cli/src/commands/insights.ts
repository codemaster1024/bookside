import type { Command } from "commander";
import { type InsightView, createInsight, deleteInsight, getInsight, reviseInsight, synthesisBrief } from "@bookside/core";
import { collect, day, emit, emitBrief, getDb, indent, parseSpeaker, readContent, ref, resolve } from "../context.ts";

function render(i: InsightView): string {
  const lines = [`[${ref("insight", i.id)}] ${i.authorship === "mine" ? "我写的" : "AI 协助"}`, indent(i.content), "", "版本："];
  i.versions.forEach((v, n) => {
    lines.push(`  v${n + 1} ${day(v.createdAt)} ${v.author === "me" ? "我" : "AI"}${v.rewrite ? "（重写）" : ""}`);
  });
  return lines.join("\n");
}

export function registerInsights(program: Command): void {
  const insight = program.command("insight").description("观点：从问题和划线中提炼出的、属于你的观点");

  insight
    .command("new <content>")
    .description("沉淀一条观点，至少给一个来源（content 为 - 时读标准输入）")
    .requiredOption("--as <speaker>", "me（你写的）或 ai（AI 起草）", parseSpeaker)
    .option("--question <question>", "来源问题，可重复", collect)
    .option("--highlight <highlight>", "来源划线，可重复", collect)
    .option("--book <book>", "来源是这本书本身（书边对话里聊出、没落在某条划线上的看法）")
    .action((content: string, opts: { as: "me" | "ai"; question?: string[]; highlight?: string[]; book?: string }) => {
      const sources = [
        ...(opts.question ?? []).map((q) => ({ questionId: resolve("question", q) })),
        ...(opts.highlight ?? []).map((h) => ({ highlightId: resolve("highlight", h) })),
        ...(opts.book ? [{ bookId: resolve("book", opts.book) }] : []),
      ];
      const i = createInsight(getDb(), { content: readContent(content), author: opts.as, sources });
      emit(i, () => render(i));
    });

  insight
    .command("revise <insight> <content>")
    .description("给观点添加新版本（content 为 - 时读标准输入）")
    .requiredOption("--as <speaker>", "me 或 ai", parseSpeaker)
    .option("--rewrite", "你从零重写、不基于上一版；只有这样才能把 AI 协助变回我写的")
    .action((input: string, content: string, opts: { as: "me" | "ai"; rewrite?: boolean }) => {
      const i = reviseInsight(getDb(), resolve("insight", input), {
        content: readContent(content),
        author: opts.as,
        rewrite: opts.rewrite,
      });
      emit(i, () => render(i));
    });

  insight
    .command("gather <book>")
    .description("整理成观点：给智能体取一本书的划线、想法、问题和已有观点，和读者一起整理")
    .action((input: string) => emitBrief(synthesisBrief(getDb(), resolve("book", input))));

  insight
    .command("delete <insight>")
    .description("删掉一条观点（连同它的版本和关联）；只在用户明确说要删时用，删了不能恢复")
    .action((input: string) => {
      const i = deleteInsight(getDb(), resolve("insight", input));
      emit(i, () => `已删掉观点：${i.content.slice(0, 40)}`);
    });

  insight
    .command("show <insight>")
    .description("查看观点及其版本历史")
    .action((input: string) => {
      const i = getInsight(getDb(), resolve("insight", input));
      emit(i, () => render(i));
    });
}
