import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import {
  type Brief,
  type Db,
  type LinkableType,
  QUESTION_STATUS_LABELS,
  type QuestionStatus,
  type Speaker,
  WereadClient,
  configPath,
  databasePath,
  loadConfig,
  openDb,
  resolveId,
  schema,
  shortId,
  wereadApiKey,
} from "@bookside/core";

/**
 * 命令运行的环境：用哪个库、哪个微信读书 Key、输出写到哪里。
 * 在终端里直接跑时用本机的配置与 ~/.bookside；测试里（见 run.ts）可以换成别的。
 */
export type Runtime = {
  db(): Db;
  wereadKey(): string | undefined;
  /** 每本书一批最多写几条追问。 */
  perBookLimit(): number;
  /** 缺 Key 时给读者看的说明。 */
  hints: { key: string };
};

type Session = { runtime: Runtime; out: string[]; err: string[]; stdin?: string; json: boolean };
const session = new AsyncLocalStorage<Session>();

let localDb: Db | undefined;

/** 本机：按 ~/.bookside 的配置。 */
export const localRuntime: Runtime = {
  // 首次用到时才打开数据库，`info` 之外的命令都会用到。
  db: () => (localDb ??= openDb(databasePath())),
  wereadKey: () => wereadApiKey(loadConfig()),
  perBookLimit: () => loadConfig().probes.perBookLimit,
  hints: {
    key: `需要微信读书 Key：在 https://weread.qq.com/r/weread-skills 获取，然后 export WEREAD_API_KEY=wrk-… 或写入 ${configPath()} 的 weread.apiKey`,
  },
};

const runtime = (): Runtime => session.getStore()?.runtime ?? localRuntime;

/** 在给定环境里执行一段命令，收集它的输出（测试用）。 */
export async function withSession<T>(
  rt: Runtime,
  stdin: string | undefined,
  fn: () => Promise<T>,
): Promise<{ result?: T; error?: unknown; stdout: string; stderr: string }> {
  const s: Session = { runtime: rt, out: [], err: [], stdin, json: false };
  return session.run(s, async () => {
    try {
      const result = await fn();
      return { result, stdout: s.out.join(""), stderr: s.err.join("") };
    } catch (error) {
      return { error, stdout: s.out.join(""), stderr: s.err.join("") };
    }
  });
}

export function getDb(): Db {
  return runtime().db();
}

export function perBookLimit(): number {
  return runtime().perBookLimit();
}

/** 微信读书；why 说明这一步为什么要用到它。 */
export function weread(why?: string): WereadClient {
  const key = runtime().wereadKey();
  if (!key) throw new Error(why ? `${why}。${runtime().hints.key}` : runtime().hints.key);
  return new WereadClient(key);
}

/** 有 Key 才返回，没有时静默跳过的场合用。 */
export function wereadIfAny(): WereadClient | undefined {
  const key = runtime().wereadKey();
  return key ? new WereadClient(key) : undefined;
}

/** 正常输出一行。 */
export function print(...parts: unknown[]): void {
  const line = `${parts.map(String).join(" ")}\n`;
  const s = session.getStore();
  if (s) s.out.push(line);
  else process.stdout.write(line);
}

/** 提示与警告。 */
export function printErr(...parts: unknown[]): void {
  const line = `${parts.map(String).join(" ")}\n`;
  const s = session.getStore();
  if (s) s.err.push(line);
  else process.stderr.write(line);
}

/** 原样写出（commander 的帮助文本等）。 */
export function writeOut(text: string): void {
  const s = session.getStore();
  if (s) s.out.push(text);
  else process.stdout.write(text);
}

export function writeErr(text: string): void {
  const s = session.getStore();
  if (s) s.err.push(text);
  else process.stderr.write(text);
}

/** --json：每次执行各自记，测试里同时跑几条命令时互不影响。 */
export const output = {
  get json(): boolean {
    return session.getStore()?.json ?? localJson;
  },
  set json(v: boolean) {
    const s = session.getStore();
    if (s) s.json = v;
    else localJson = v;
  },
};
let localJson = false;

/** --json 时输出结构化数据，否则输出给人看的文本。 */
export function emit(data: unknown, render: () => string): void {
  print(output.json ? JSON.stringify(data, null, 2) : render());
}

/** 交给智能体的活：--json 时原样输出，否则排成一页给智能体读。 */
export function emitBrief(b: Brief): void {
  emit(b, () => {
    const out = [`# ${b.task}`, "", "## 要求", "", b.instructions, "", "## 材料", "", b.material];
    if (b.writeBack?.endsWith(" -")) {
      out.push("", "## 写回", "", ...(b.reply ? [b.reply, ""] : []), "写好后用下面的命令写回，正文从标准输入传入：", "", `${b.writeBack} <<'TEXT'`, "……", "TEXT");
    } else if (b.writeBack) {
      out.push("", "## 下一步", "", b.writeBack);
    }
    return out.join("\n");
  });
}

/** 内容参数为 "-" 时从标准输入读取，便于传入含引号、换行的长文本。 */
export function readContent(arg: string): string {
  const s = session.getStore();
  const text = arg === "-" ? (s ? (s.stdin ?? "") : readFileSync(0, "utf8")) : arg;
  if (!text.trim()) throw new Error("内容不能为空");
  return text.trim();
}

// —— 引用与 id ——

const KINDS = {
  book: { short: "b", table: schema.books, label: "书" },
  chapter: { short: "c", table: schema.chapters, label: "章节" },
  highlight: { short: "h", table: schema.highlights, label: "划线" },
  note: { short: "n", table: schema.notes, label: "想法" },
  question: { short: "q", table: schema.questions, label: "问题" },
  insight: { short: "i", table: schema.insights, label: "观点" },
  probe: { short: "p", table: schema.probes, label: "追问" },
  link: { short: "l", table: schema.links, label: "关联" },
} as const;
export type Kind = keyof typeof KINDS;

const byShort = new Map<string, Kind>(Object.entries(KINDS).map(([k, v]) => [v.short, k as Kind]));

/** 展示用引用，如 h:a1b2c3d4；命令参数也接受这种写法。 */
export const ref = (kind: Kind, id: string) => `${KINDS[kind].short}:${shortId(id)}`;

function splitRef(input: string): { kind?: Kind; id: string } {
  const m = input.match(/^([a-z]+):(.+)$/);
  if (!m) return { id: input };
  const kind = (m[1]! in KINDS ? m[1] : byShort.get(m[1]!)) as Kind | undefined;
  if (!kind) throw new Error(`无法识别的引用类型：${m[1]}`);
  return { kind, id: m[2]! };
}

/** 把 "h:a1b2"、"a1b2" 或完整 id 解析为指定类型的完整 id。 */
export function resolve(kind: Kind, input: string): string {
  const { kind: given, id } = splitRef(input);
  if (given && given !== kind) throw new Error(`这里需要${KINDS[kind].label}，但给的是 ${input}`);
  return resolveId(getDb(), KINDS[kind].table, KINDS[kind].label, id);
}

/** 解析带类型的引用（如 h:a1b2、question:…），用于关联两端与问题起源。 */
export function resolveRef<T extends Kind>(input: string, allowed: readonly T[]): { type: T; id: string } {
  const { kind } = splitRef(input);
  if (!kind || !(allowed as readonly Kind[]).includes(kind)) {
    throw new Error(`引用 ${input} 需写成 类型:id，类型为 ${allowed.map((k) => `${k}(${KINDS[k].short})`).join(" / ")}`);
  }
  return { type: kind as T, id: resolve(kind, input) };
}

export const LINKABLE: readonly LinkableType[] = ["book", "chapter", "highlight", "note", "question", "insight"];

// —— 取值解析 ——

export function parseSpeaker(value: string): Speaker {
  if (value === "me" || value === "我") return "me";
  if (value === "ai" || value === "AI") return "ai";
  throw new Error("--as 只能是 me 或 ai");
}

export function parseStatus(value: string): QuestionStatus {
  const hit = Object.entries(QUESTION_STATUS_LABELS).find(([k, label]) => value === k || value === label);
  if (!hit) {
    throw new Error(`未知状态 ${value}，可用：${Object.entries(QUESTION_STATUS_LABELS).map(([k, l]) => `${k}(${l})`).join(" ")}`);
  }
  return hit[0] as QuestionStatus;
}

/** brief 给出的 --as-of 时间戳（毫秒）。 */
export function parseAsOf(value: string): Date {
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms <= 0) throw new Error(`--as-of 应是 brief 里给出的时间戳，现在是 ${value}`);
  return new Date(ms);
}

export const collect = (value: string, prev: string[] = []) => [...prev, value];

// —— 格式 ——

export const day = (d: Date | null | undefined) => {
  if (!d) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export const statusLabel = (s: QuestionStatus) => QUESTION_STATUS_LABELS[s];

export const indent = (text: string, prefix = "    ") =>
  text
    .split("\n")
    .map((l) => prefix + l)
    .join("\n");
