// 在给定环境里执行一条 bookside 命令，收集它的输出而不写到终端；测试用它。
import { CommanderError } from "commander";
import { type Runtime, localRuntime, withSession, writeErr, writeOut } from "./context.ts";
import { buildProgram } from "./program.ts";

export type { Runtime } from "./context.ts";

export type CliResult = { stdout: string; stderr: string; code: number };

export async function runCli(argv: string[], opts: { runtime?: Runtime; stdin?: string } = {}): Promise<CliResult> {
  const r = await withSession(opts.runtime ?? localRuntime, opts.stdin, async () => {
    const program = buildProgram()
      .exitOverride()
      .configureOutput({ writeOut, writeErr });
    await program.parseAsync(argv, { from: "user" });
  });
  if (!r.error) return { stdout: r.stdout, stderr: r.stderr, code: 0 };
  // 帮助、版本这类"退出"不算错误；参数错误 commander 已经写过说明。
  if (r.error instanceof CommanderError) return { stdout: r.stdout, stderr: r.stderr, code: r.error.exitCode };
  const message = r.error instanceof Error ? r.error.message : String(r.error);
  return { stdout: r.stdout, stderr: `${r.stderr}错误：${message}\n`, code: 1 };
}
