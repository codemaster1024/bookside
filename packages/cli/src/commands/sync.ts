import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { type Conn, importKindle, listTodos, settleTodos, syncWeread } from "@bookside/core";
import { emit, getDb, perBookLimit, print, weread } from "../context.ts";

/** 导入之后：无事可做的候选直接消化，其余提示交给智能体。 */
function afterImport(db: Conn): void {
  settleTodos(db, { perBookLimit: perBookLimit() });
  const todos = listTodos(db, { perBookLimit: perBookLimit() });
  if (todos.length) print(`有 ${todos.length} 项待办留给智能体，运行 bookside todo 查看。`);
}

export function registerSync(program: Command): void {
  program
    .command("sync")
    .description("从微信读书同步书架、划线和想法；新内容留作待办，交给智能体写追问、做跨书激活")
    .option("--full", "不看变化指纹，逐本重新对齐（用于补齐导入，较慢）")
    .action(async (opts: { full?: boolean }) => {
      const db = getDb();
      const r = await syncWeread(db, weread("同步要读取你的微信读书"), new Date(), { full: opts.full });
      if (r.baseline) {
        print(`首次导入完成：同步了 ${r.booksSynced} 本书的笔记，已建立基线（这批内容不会触发追问）。`);
      } else {
        print(
          `同步完成：${opts.full ? `逐本对齐了 ${r.booksSynced} 本书` : `${r.booksSynced} 本书有变化`}，新增划线 ${r.newHighlightIds.length} 条、想法 ${r.newNoteIds.length} 条，标记源端已删除 ${r.markedDeleted} 条。`,
        );
      }
      if (r.newReviews) print(`新增书评 / 章节点评 ${r.newReviews} 条。`);
      afterImport(db);
    });

  program
    .command("import <file>")
    .description("导入 Kindle 的 My Clippings.txt（在 Kindle 的 documents 目录里）；可以反复导入，只增加新内容")
    .action((file: string) => {
      const db = getDb();
      const r = importKindle(db, readFileSync(file, "utf8"));
      emit(r, () =>
        r.books === 0
          ? "文件里没有认得出的 Kindle 摘录。"
          : [
              `从 Kindle 导入了 ${r.books} 本书：新增划线 ${r.newHighlights} 条、笔记 ${r.newNotes} 条${r.updatedHighlights ? `，更新改过的划线 ${r.updatedHighlights} 条` : ""}。`,
              ...(r.baseline ? ["这是第一次导入，已建立基线（这批内容不会触发追问）。"] : []),
            ].join("\n"),
      );
      afterImport(db);
    });
}
