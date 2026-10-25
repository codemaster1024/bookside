import { Command } from "commander";
import { registerBooks } from "./commands/books.ts";
import { registerExport } from "./commands/export.ts";
import { registerExtra } from "./commands/extra.ts";
import { registerGuide } from "./commands/guide.ts";
import { registerInsights } from "./commands/insights.ts";
import { registerLinks } from "./commands/links.ts";
import { registerNext } from "./commands/next.ts";
import { registerProbes } from "./commands/probes.ts";
import { registerQuestions } from "./commands/questions.ts";
import { registerSetup } from "./commands/setup.ts";
import { registerSync } from "./commands/sync.ts";
import { registerTodo } from "./commands/todo.ts";
import { registerWeb } from "./commands/web.ts";
import { output } from "./context.ts";

export function buildProgram(): Command {
  const program = new Command()
    .name("bookside")
    .description("书畔：给你的智能体一份读书记忆")
    .option("--json", "以 JSON 输出（供 skill 等程序读取）")
    .hook("preAction", (cmd) => {
      output.json = !!cmd.optsWithGlobals().json;
    });


  registerSetup(program);
  registerSync(program);
  registerTodo(program);
  registerNext(program);
  registerBooks(program);
  registerProbes(program);
  registerQuestions(program);
  registerInsights(program);
  registerLinks(program);
  registerGuide(program);
  registerExport(program);
  registerExtra(program);
  registerWeb(program);
  return program;
}
