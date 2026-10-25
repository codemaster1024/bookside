// 上手：init 一步装好（数据源、skill、首次同步），doctor 排查卡在哪，sample 放入或删掉示例书。
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import {
  WereadClient,
  configPath,
  databasePath,
  importKindle,
  listBooks,
  listTodos,
  loadConfig,
  loadSample,
  removeSample,
  saveConfig,
  settleTodos,
  syncWeread,
  wereadApiKey,
} from "@bookside/core";
import { emit, getDb, perBookLimit, print, progress } from "../context.ts";
import { type SkillTarget, installSkill, skillTargets } from "../skill.ts";

const KEY_URL = "https://weread.qq.com/r/weread-skills";
const MIN_NODE = 22;

type Source = { kind: "weread"; key: string } | { kind: "kindle"; file: string } | { kind: "sample" };

/** Key 只露出头尾，确认是哪一个就够了。 */
const maskKey = (key: string) => (key.length > 12 ? `${key.slice(0, 4)}…${key.slice(-4)}` : "…");

async function ask(): Promise<Source> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const fromEnv = process.env.WEREAD_API_KEY?.trim();
  const existing = fromEnv || wereadApiKey(loadConfig());
  try {
    print("书畔的数据从哪来？");
    print(`  1) 微信读书${existing ? `（已找到 Key ${maskKey(existing)}）` : `（需要 Key，在 ${KEY_URL} 获取）`}`);
    print("  2) Kindle 的 My Clippings.txt（Kindle 接电脑后在 documents 目录里）");
    print("  3) 还没准备好？先用示例书鲁迅《呐喊》看看");
    const choice = (await rl.question("选择 [1]：")).trim() || "1";
    if (choice === "1") {
      if (existing) {
        const where = fromEnv ? "环境变量 WEREAD_API_KEY 里" : "配置文件里";
        const reuse = (await rl.question(`用${where}的 Key ${maskKey(existing)}？[Y/n]：`)).trim().toLowerCase();
        if (reuse === "" || reuse === "y" || reuse === "yes") return { kind: "weread", key: existing };
        if (fromEnv) print("注意：环境变量 WEREAD_API_KEY 优先于配置文件。换 Key 后，记得把环境变量也改掉或删掉。");
      } else {
        print(`获取 Key：用浏览器打开 ${KEY_URL}，登录后复制页面上的 Key（以 wrk- 开头）。`);
      }
      const key = (await rl.question("粘贴微信读书 Key：")).trim();
      if (!key) throw new Error(`没有填 Key。在 ${KEY_URL} 获取后再运行 bookside init；或者先运行 bookside init --sample 用示例书看看`);
      return { kind: "weread", key };
    }
    if (choice === "2") {
      const file = (await rl.question("My Clippings.txt 的路径：")).trim().replace(/^['"]|['"]$/g, "");
      if (!file) throw new Error("没有路径");
      return { kind: "kindle", file };
    }
    return { kind: "sample" };
  } finally {
    rl.close();
  }
}

const SKILL_STATE = { missing: "未安装", current: "已是最新", outdated: "有旧版", foreign: "已有同名 skill，不是书畔装的，没有覆盖" } as const;
const skillLine = (t: SkillTarget) => `${t.agent}：${SKILL_STATE[t.state]}（${t.path}）`;

export function registerSetup(program: Command): void {
  program
    .command("init")
    .description("一步装好：接上数据源（微信读书 / Kindle / 示例书）、把 skill 装进本机的智能体、首次同步")
    .option("--weread-key <key>", `微信读书 Key（在 ${KEY_URL} 获取）`)
    .option("--kindle <file>", "Kindle 的 My Clippings.txt")
    .option("--sample", "先用示例书鲁迅《呐喊》试试")
    .option("--no-skill", "不安装 skill")
    .action(async (opts: { wereadKey?: string; kindle?: string; sample?: boolean; skill: boolean }) => {
      const source: Source = opts.wereadKey
        ? { kind: "weread", key: opts.wereadKey.trim() }
        : opts.kindle
          ? { kind: "kindle", file: opts.kindle }
          : opts.sample || !process.stdin.isTTY
            ? { kind: "sample" }
            : await ask();
      const db = getDb();
      print(`数据放在 ${databasePath()}`);

      if (source.kind === "weread") {
        const config = loadConfig();
        config.weread.apiKey = source.key;
        saveConfig(config);
        print(`已保存微信读书 Key（${configPath()}，仅你本人可读）。`);
        const p = progress("正在同步微信读书", "读取书架");
        const r = await syncWeread(db, new WereadClient(source.key), new Date(), { onProgress: (d, t, title) => p.update(d, t, title) }).finally(() => p.done());
        print(`同步了 ${r.booksSynced} 本书的笔记${r.baseline ? "，已建立基线（这批内容不会触发追问，之后的新划线才会）" : ""}。`);
      } else if (source.kind === "kindle") {
        if (!existsSync(source.file)) throw new Error(`找不到 ${source.file}`);
        const r = importKindle(db, readFileSync(source.file, "utf8"));
        print(`从 Kindle 导入了 ${r.books} 本书：划线 ${r.newHighlights} 条、笔记 ${r.newNotes} 条。以后再导入同一个文件，只会增加新内容。`);
      } else {
        loadSample(db);
        print("已放入示例书鲁迅《呐喊》：二十来条划线、一条待处理的追问、一个到了回访时间的问题；读到《故乡》为止，可以试试它会不会剧透。和智能体聊书时，它还会替你写一份读书画像。");
        print("想换成你自己的书：再运行 bookside init，选微信读书或 Kindle；不要示例书了：bookside sample --remove。");
      }
      settleTodos(db, { perBookLimit: perBookLimit() });

      if (opts.skill) {
        const done = installSkill();
        if (done.length === 0) {
          print("没找到 Claude Code、Codex、Trae 等智能体的配置目录。装好智能体后再运行 bookside init，或用 npx skills add codemaster1024/bookside -g 安装。");
        } else {
          print(["skill：", ...done.map((t) => `  ${skillLine(t)}`)].join("\n"));
        }
      }
      print("\n装好了。打开你的智能体，对它说：「用书畔陪我读书」。");
    });

  program
    .command("doctor")
    .description("检查哪一步没装好：Node、数据库、配置、微信读书 Key、skill")
    .action(async () => {
      const checks: { ok: boolean; what: string; fix?: string }[] = [];
      const major = Number(process.versions.node.split(".")[0]);
      checks.push({ ok: major >= MIN_NODE, what: `Node ${process.versions.node}`, fix: `需要 Node ${MIN_NODE} 或更新的版本` });

      let configOk = false;
      try {
        loadConfig();
        configOk = true;
        checks.push({ ok: true, what: `配置文件 ${configPath()}` });
      } catch (e) {
        checks.push({ ok: false, what: "配置文件", fix: e instanceof Error ? e.message : String(e) });
      }

      try {
        const db = getDb();
        checks.push({ ok: true, what: `数据库 ${databasePath()}，${listBooks(db, { includeEmpty: true }).length} 本书` });
        if (configOk) {
          settleTodos(db, { perBookLimit: perBookLimit() });
          const n = listTodos(db, { perBookLimit: perBookLimit() }).length;
          checks.push({ ok: true, what: n ? `${n} 项待办等智能体处理（bookside todo）` : "没有待办" });
        }
      } catch (e) {
        checks.push({ ok: false, what: "数据库", fix: e instanceof Error ? e.message : String(e) });
      }

      const key = configOk ? wereadApiKey(loadConfig()) : undefined;
      if (!key) {
        checks.push({ ok: true, what: `没有微信读书 Key（只用 Kindle 或示例书时不需要；要用就在 ${KEY_URL} 获取后运行 bookside init）` });
      } else {
        try {
          const shelf = await new WereadClient(key).shelf();
          const from = process.env.WEREAD_API_KEY ? "环境变量 WEREAD_API_KEY" : "配置文件";
          checks.push({ ok: true, what: `微信读书 Key 可用（来自${from}），书架上 ${shelf.length} 本书` });
        } catch (e) {
          checks.push({ ok: false, what: "微信读书 Key", fix: `连不上或 Key 失效：${e instanceof Error ? e.message : String(e)}。在 ${KEY_URL} 重新获取后运行 bookside init --weread-key …` });
        }
      }

      const targets = skillTargets();
      if (targets.length === 0) {
        checks.push({ ok: false, what: "skill", fix: "没找到 Claude Code、Codex 等智能体的配置目录" });
      }
      for (const t of targets) {
        checks.push({ ok: t.state === "current", what: `skill · ${skillLine(t)}`, fix: t.state === "foreign" ? "先移走那个同名 skill，再运行 bookside init" : "运行 bookside init 安装或更新" });
      }

      emit(checks, () => checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.what}${c.ok || !c.fix ? "" : `\n    ${c.fix}`}`).join("\n"));
      if (checks.some((c) => !c.ok)) process.exitCode = 1;
    });

  program
    .command("sample")
    .description("放入示例书鲁迅《呐喊》，先走一遍完整流程；加 --remove 删掉它（连同在它上面写的问题和观点）")
    .option("--remove", "删掉示例书")
    .action((opts: { remove?: boolean }) => {
      const db = getDb();
      if (opts.remove) {
        removeSample(db);
        return print("已删掉示例书《呐喊》。");
      }
      const r = loadSample(db);
      print(r.created ? "已放入示例书《呐喊》。对智能体说「用书畔陪我读书」试试。" : "示例书《呐喊》已经在了。");
    });
}
