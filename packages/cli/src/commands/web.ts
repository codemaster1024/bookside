import type { Command } from "commander";
import { renderUnicodeCompact } from "uqr";
import { startViewer } from "@bookside/web/server";
import { getDb, print } from "../context.ts";

const DEFAULT_PORT = 4317;

/** 字符画的二维码：字符是浅色、空白是深色，固定成黑底白字，浅色主题的终端里也扫得出。 */
const qr = (url: string) =>
  renderUnicodeCompact(url, { border: 2 })
    .split("\n")
    .map((line) => `\x1b[97;40m${line}\x1b[0m`)
    .join("\n");

export function registerWeb(program: Command): void {
  program
    .command("web")
    .description("打开只读查看器：在浏览器里看你的问题、追问、观点和划线（默认只有本机能打开）")
    .option("--port <port>", "端口", (v) => Number.parseInt(v, 10), DEFAULT_PORT)
    .option("--host [address]", "开放给局域网（如在手机上看）；不写地址时监听所有网卡")
    .action(async (opts: { port: number; host?: string | true }) => {
      const hostname = opts.host === true ? "0.0.0.0" : (opts.host ?? "127.0.0.1");
      const { port, lanUrls } = await startViewer(getDb(), { hostname, port: opts.port });
      print(`书畔查看器：http://localhost:${port}/`);
      if (hostname !== "127.0.0.1" && hostname !== "localhost") {
        for (const u of lanUrls) print(`局域网：${u}`);
        if (lanUrls.length === 0) print("没找到局域网地址：这台电脑可能没连 Wi-Fi 或网线。");
        // 在终端里直接印二维码；智能体运行时印出来也没人扫，改为指向网页上的二维码。
        if (lanUrls[0] && process.stdout.isTTY) print(`\n手机扫码打开（手机和电脑要连同一个 Wi-Fi）：\n${qr(lanUrls[0])}\n`);
        else if (lanUrls[0]) print(`在电脑上打开 http://localhost:${port}/phone ，用手机扫页面上的二维码。`);
        print("注意：同一网络里的人都能打开它、看到你的读书内容（只能看，不能改）。");
      }
      print("按 Ctrl+C 停止。");
    });
}
