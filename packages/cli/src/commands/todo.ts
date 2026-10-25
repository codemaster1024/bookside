import type { Command } from "commander";
import { listTodos, settleTodos } from "@bookside/core";
import { emit, getDb, perBookLimit, printErr } from "../context.ts";
import { refreshSkill } from "../skill.ts";
import { autoExport } from "./export.ts";

const LABEL = { probes: "写追问", activation: "跨书激活", portrait: "写读书画像" } as const;

export function registerTodo(program: Command): void {
  program
    .command("todo")
    .description("给智能体：同步后留下的 AI 待办（为新划线写追问、跨书激活、更新读书画像），每项附取材料的命令")
    .action(() => {
      // 智能体每次开场都会来这里：顺带把升级后过期的 skill 换成新版，下次对话就用上。
      for (const t of refreshSkill()) printErr(`已把 ${t.agent} 里的书畔 skill 更新到新版。`);
      const db = getDb();
      settleTodos(db, { perBookLimit: perBookLimit() });
      // 开场时顺带把上次聊出来的东西导出去。
      autoExport(db);
      const todos = listTodos(db, { perBookLimit: perBookLimit() });
      emit(todos, () =>
        todos.length === 0
          ? "没有待办。"
          : [
              `有 ${todos.length} 项待办。逐项运行命令取材料，做完按材料末尾的命令写回：`,
              ...todos.map((t) => `- ${LABEL[t.kind]}：${t.bookTitle ? `《${t.bookTitle}》${t.count} 条新内容` : `${t.count} 条新划线`}\n    ${t.brief}`),
            ].join("\n"),
      );
    });
}
