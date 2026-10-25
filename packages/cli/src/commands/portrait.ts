import type { Command } from "commander";
import { type Portrait, PORTRAIT_MIN_HIGHLIGHTS, latestPortrait, listPortraits, portraitBrief, writePortrait } from "@bookside/core";
import { day, emit, emitBrief, getDb, readContent, ref } from "../context.ts";

function renderPortrait(p: Portrait): string {
  const out = [`读书画像 · AI 写于 ${day(p.createdAt)} · 根据 ${p.highlightCount} 条划线`];
  if (p.change) out.push("", `这段时间的变化：${p.change}`);
  if (p.reread) out.push("", "值得重读的一句：", `  「${p.reread.text}」——《${p.reread.bookTitle}》 [${ref("highlight", p.reread.highlightId)}]`, `  ${p.reread.why}`);
  out.push("", "你最近在关心什么：");
  for (const t of p.themes) {
    out.push(`- ${t.title}${t.gist ? `：${t.gist}` : ""}`);
    for (const q of t.quotes) out.push(`    「${q.text.replace(/\s+/g, " ").slice(0, 80)}」——《${q.bookTitle}》`);
  }
  out.push("", "你的读书画像：", p.essay, "", `下一步可以：${p.next.text}${p.next.questionId ? ` [${ref("question", p.next.questionId)}]` : ""}`);
  return out.join("\n");
}

export function registerPortrait(program: Command): void {
  program
    .command("portrait")
    .description("读书画像：值得重读的一句、你最近在关心什么、一段画像和下一步，显示在网页首页。智能体用 --brief 取材料、写好后 --write 写回")
    .option("--brief", `给智能体：取写画像的材料（至少 ${PORTRAIT_MIN_HIGHLIGHTS} 条划线）`)
    .option("--write <content>", "给智能体：写回画像（JSON，- 为读标准输入）；旧的保留")
    .option("--by <name>", "写画像的智能体，如 claude-code（随 --write）")
    .option("--history", "以前写过的画像：日期、当时的变化和主题，新的在前")
    .action((opts: { brief?: boolean; write?: string; by?: string; history?: boolean }) => {
      const db = getDb();
      if (opts.history) {
        const all = listPortraits(db);
        return emit(all, () =>
          all.length === 0
            ? "还没有读书画像。"
            : all.map((p) => [`${day(p.createdAt)} · 根据 ${p.highlightCount} 条划线`, ...(p.change ? [`  变化：${p.change}`] : []), `  主题：${p.themes.map((t) => t.title).join("；")}`].join("\n")).join("\n\n"),
        );
      }
      if (opts.brief) return emitBrief(portraitBrief(db));
      if (opts.write !== undefined) {
        const p = writePortrait(db, readContent(opts.write), { by: opts.by });
        return emit(p, () => `${renderPortrait(p)}\n\n已存好，打开 bookside web 在首页能看到。`);
      }
      const p = latestPortrait(db);
      if (!p) return emit(null, () => "还没有读书画像。智能体可以运行 bookside portrait --brief 取材料来写。");
      emit(p, () => renderPortrait(p));
    });
}
