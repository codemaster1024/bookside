import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { booksideHome } from "./paths.ts";

const Config = z.object({
  probes: z.object({ perBookLimit: z.int().min(0).default(3) }).prefault({}),
  weread: z.object({ apiKey: z.string().optional() }).prefault({}),
  /** 设了 autoDir 时，每次同步、导入和开场取待办之后都自动导出到这里。 */
  export: z.object({ autoDir: z.string().optional() }).prefault({}),
});
export type Config = z.infer<typeof Config>;

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(booksideHome(env), "config.json");
}

export function loadConfig(path = configPath()): Config {
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const parsed = Config.safeParse(raw);
  if (!parsed.success) throw new Error(`配置文件 ${path} 有误：\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** 写回配置；文件含微信读书 Key，权限设为仅本人可读写。 */
export function saveConfig(config: Config, path = configPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(Config.parse(config), null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** 微信读书 Key：环境变量优先于配置文件。 */
export function wereadApiKey(config: Config, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.WEREAD_API_KEY || config.weread.apiKey;
}
