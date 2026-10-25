import type { Command } from "commander";
import {
  type Book,
  type Guide,
  findChapter,
  getBook,
  guideBrief,
  latestGuide,
  loadToc,
  writeGuide,
} from "@bookside/core";
import { day, emit, emitBrief, getDb, readContent, ref, resolve, weread, wereadIfAny } from "../context.ts";

const catalog = () => weread("导读需要从微信读书取目录与热门划线");

function renderGuide(book: Book, g: Guide, scope: string): string {
  const basis = g.basis === "familiar" ? "依据：写作者对这本书的了解" : "依据有限：只根据给出的材料（目录、简介、热门划线或你的划线）";
  return [
    `《${book.title}》${scope} · AI 导读 · ${day(g.createdAt)}`,
    basis,
    "",
    g.content,
  ].join("\n");
}

export function registerGuide(program: Command): void {
  program
    .command("guide <book>")
    .description("AI 导读：全书导读，--quick 看一页速览，--chapter 看某一章的章节导读。还没有时，智能体用 --brief 取材料、写好后 --write 写回")
    .option("--quick", "速览：一页看完，帮人决定读不读、先读哪部分")
    .option("--chapter <chapter>", "章节：目录里的序号，或标题中的一段文字（需要微信读书的目录）")
    .option("--brief", "给智能体：取写导读的材料（书在微信读书上时会取目录与热门划线，否则以读者的划线为依据）")
    .option("--write <content>", "给智能体：写回导读全文（Markdown，- 为读标准输入）；旧版保留")
    .option("--by <name>", "写导读的智能体，如 claude-code（随 --write）")
    .action(async (input: string, opts: { quick?: boolean; chapter?: string; brief?: boolean; write?: string; by?: string }) => {
      const db = getDb();
      const book = getBook(db, resolve("book", input));
      const depth = opts.quick && !opts.chapter ? "quick" : "full";
      if (opts.brief) {
        let chapterUid: number | undefined;
        if (opts.chapter) {
          const toc = await loadToc(db, catalog(), book.id);
          const wanted = opts.chapter.trim();
          const hit = /^\d+$/.test(wanted) ? toc.find((c) => c.chapterIdx === Number(wanted)) : toc.find((c) => c.title.includes(wanted));
          if (!hit) throw new Error(`《${book.title}》里找不到章节「${wanted}」，用 bookside book toc 查看目录`);
          chapterUid = hit.chapterUid;
        }
        // 不在微信读书上、或没有 Key 时，以读者的划线为依据写全书导读或速览。
        return emitBrief(await guideBrief(db, book.wereadBookId ? wereadIfAny() : undefined, { bookId: book.id, chapterUid, depth }));
      }

      const chapter = opts.chapter ? findChapter(db, book.id, opts.chapter) : undefined;
      const scope = chapter ? `章节导读：${chapter.title}` : depth === "quick" ? "速览" : "全书导读";
      if (opts.write !== undefined) {
        const r = writeGuide(db, { bookId: book.id, chapterId: chapter?.id, depth, by: opts.by }, readContent(opts.write));
        return emit(r, () =>
          [
            renderGuide(book, r.guide, scope),
            "",
            r.probes.length ? `结尾的 ${r.probes.length} 条追问已加入待处理：${r.probes.map((p) => ref("probe", p.id)).join(" ")}` : "",
          ].join("\n"),
        );
      }
      const existing = latestGuide(db, book.id, chapter?.id, depth);
      if (!existing) {
        const again = `bookside guide ${ref("book", book.id)}${opts.chapter ? ` --chapter ${chapter?.idx ?? opts.chapter}` : depth === "quick" ? " --quick" : ""} --brief`;
        return emit(null, () => `《${book.title}》还没有${scope}。智能体可以运行 ${again} 取材料来写。`);
      }
      emit(existing, () => renderGuide(book, existing, scope));
    });
}

/** 目录：序号、层级缩进、是否已有章节导读。 */
export async function tocAction(input: string): Promise<void> {
  const book = getBook(getDb(), resolve("book", input));
  const toc = await loadToc(getDb(), catalog(), book.id);
  emit(toc, () =>
    [
      `《${book.title}》目录（用 bookside guide ${ref("book", book.id)} --chapter <序号> 看章节导读）：`,
      ...toc.map((c) => `${String(c.chapterIdx).padStart(3)}  ${"  ".repeat(Math.max(0, c.level - 1))}${c.title}${c.hasGuide ? "  [有导读]" : ""}`),
    ].join("\n"),
  );
}
