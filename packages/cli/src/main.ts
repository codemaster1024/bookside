#!/usr/bin/env node
import { buildProgram } from "./program.ts";

try {
  await buildProgram().parseAsync(process.argv.slice(2), { from: "user" });
} catch (e) {
  // 领域规则、配置、网络等错误只给出说明；设置 BOOKSIDE_DEBUG 时保留堆栈。
  console.error(process.env.BOOKSIDE_DEBUG ? e : `错误：${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
