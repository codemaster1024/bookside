import { homedir } from "node:os";
import { join } from "node:path";

/** 书畔的数据目录：默认 ~/.bookside，可用 BOOKSIDE_HOME 覆盖。 */
export function booksideHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.BOOKSIDE_HOME ?? join(homedir(), ".bookside");
}

export function databasePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(booksideHome(env), "bookside.db");
}
