import { networkInterfaces } from "node:os";
import type { Command } from "commander";
import { startViewer } from "@bookside/web/server";
import { getDb, print } from "../context.ts";

const DEFAULT_PORT = 4317;

/** 本机在局域网里的地址，开放给手机看时提示用。 */
const lanAddresses = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal)
    .map((a) => a!.address);

export function registerWeb(program: Command): void {
  program
    .command("web")
    .description("打开只读查看器：在浏览器里看你的问题、追问、观点和划线（默认只有本机能打开）")
    .option("--port <port>", "端口", (v) => Number.parseInt(v, 10), DEFAULT_PORT)
    .option("--host [address]", "开放给局域网（如在手机上看）；不写地址时监听所有网卡")
    .action(async (opts: { port: number; host?: string | true }) => {
      const hostname = opts.host === true ? "0.0.0.0" : (opts.host ?? "127.0.0.1");
      const { port } = await startViewer(getDb(), { hostname, port: opts.port });
      print(`书畔查看器：http://localhost:${port}/`);
      if (hostname !== "127.0.0.1" && hostname !== "localhost") {
        for (const a of hostname === "0.0.0.0" ? lanAddresses() : [hostname]) print(`局域网：http://${a}:${port}/`);
        print("注意：同一网络里的人都能打开它、看到你的读书内容（只能看，不能改）。");
      }
      print("按 Ctrl+C 停止。");
    });
}
