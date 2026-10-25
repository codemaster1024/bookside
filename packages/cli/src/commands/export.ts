import { join, resolve as resolvePath } from "node:path";
import type { Command } from "commander";
import { booksideHome, buildExport, writeExport } from "@bookside/core";
import { getDb, print } from "../context.ts";

export function registerExport(program: Command): void {
  program
    .command("export [dir]")
    .description("导出全部内容为 Obsidian 可以直接打开的 Markdown：双链、划线块 id、属性（默认 ~/.bookside/export；可以整个放进已有的库）")
    .action((dir?: string) => {
      const target = resolvePath(dir ?? join(booksideHome(), "export"));
      const files = buildExport(getDb());
      writeExport(files, target);
      const count = (prefix: string) => [...files.keys()].filter((k) => k.startsWith(prefix)).length;
      print(`已导出到 ${target}：书 ${count("books/")} 本，问题 ${count("questions/")} 个。入口是 书畔.md。`);
    });
}
