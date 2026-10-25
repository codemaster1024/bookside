import { join, resolve as resolvePath } from "node:path";
import type { Command } from "commander";
import { type Conn, booksideHome, buildExport, loadConfig, saveConfig, writeExport } from "@bookside/core";
import { getDb, print, printErr } from "../context.ts";

function exportTo(db: Conn, target: string) {
  const files = buildExport(db);
  writeExport(files, target);
  return (prefix: string) => [...files.keys()].filter((k) => k.startsWith(prefix)).length;
}

/** 开了自动导出时，把最新的内容写到那个目录；出错只提示，不打断同步。 */
export function autoExport(db: Conn): void {
  const dir = loadConfig().export.autoDir;
  if (!dir) return;
  try {
    exportTo(db, dir);
  } catch (e) {
    printErr(`自动导出到 ${dir} 没有成功：${e instanceof Error ? e.message : e}`);
  }
}

export function registerExport(program: Command): void {
  program
    .command("export [dir]")
    .description("导出全部内容为 Obsidian 可以直接打开的 Markdown：双链、划线块 id、属性（默认 ~/.bookside/export；可以整个放进已有的库）")
    .option("--auto", "记住这个目录，之后每次同步、导入和开始聊书时都自动导出一次")
    .option("--auto-off", "不再自动导出")
    .action((dir: string | undefined, opts: { auto?: boolean; autoOff?: boolean }) => {
      const config = loadConfig();
      if (opts.autoOff) {
        const was = config.export.autoDir;
        config.export.autoDir = undefined;
        saveConfig(config);
        return print(was ? `已关闭自动导出（之前导出到 ${was}，里面的文件留着）。` : "本来就没有开自动导出。");
      }
      const target = resolvePath(dir ?? config.export.autoDir ?? join(booksideHome(), "export"));
      const count = exportTo(getDb(), target);
      print(`已导出到 ${target}：书 ${count("books/")} 本，问题 ${count("questions/")} 个。入口是 书畔.md。`);
      if (opts.auto) {
        config.export.autoDir = target;
        saveConfig(config);
        print("之后每次同步、导入和开始聊书时，都会自动更新这里。不想要了：bookside export --auto-off。");
      }
    });
}
