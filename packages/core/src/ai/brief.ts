// 交给智能体的活：书畔不调用模型，而是交出写作要求与材料，由用户正在用的智能体写好后，用对应命令写回并在这里校验。
import { DomainError } from "../domain/errors.ts";
import { shortId } from "../domain/ids.ts";

/** 一份交给智能体的活。material 里的对象一律用引用（如 h:a1b2c3d4）标出，写回时原样引用。 */
export type Brief = {
  /** 这是什么活，一句话。 */
  task: string;
  /** 写作要求。 */
  instructions: string;
  /** 材料。 */
  material: string;
  /** 写回时的正文格式；只做准备、不需要写回的活为空。 */
  reply?: string;
  /** 写回用的命令，正文从标准输入传入；不需要写回时为空。 */
  writeBack?: string;
};

/** 各写作要求共用：JSON 字符串里引用原话时的写法，避免写出裸的 ASCII 双引号。 */
export const JSON_QUOTE_RULE = "JSON 字符串内部引用原话时用「」，不要使用英文双引号。";

const PREFIX = { book: "b", chapter: "c", highlight: "h", note: "n", question: "q", insight: "i", probe: "p", link: "l" } as const;
type RefKind = keyof typeof PREFIX;

/** 材料里的引用，与命令行的写法一致。 */
export const refOf = (kind: RefKind, id: string) => `${PREFIX[kind]}:${shortId(id)}`;

/** 在写回的正文里找出引用指向的对象；只在 brief 交出的对象里找，找不到的引用忽略。 */
export function matchRef<T extends { id: string }>(input: string, kind: RefKind, among: T[]): T | undefined {
  const m = input.trim().toLowerCase().match(/^([a-z]+):([0-9a-f-]{4,})$/);
  if (!m || m[1] !== PREFIX[kind]) return undefined;
  const hits = among.filter((x) => x.id.startsWith(m[2]!));
  return hits.length === 1 ? hits[0] : undefined;
}

export class ReplyError extends DomainError {
  constructor(message: string) {
    super("bad_reply", message);
  }
}

/** 从写回的正文里取出第一个 JSON 对象；容忍 ```json 围栏、前后的说明文字，以及字符串里未转义的引号和换行。 */
export function extractJson(reply: string): unknown {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? reply;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new ReplyError(`写回的内容里找不到 JSON：${reply.slice(0, 200)}`);
  const text = candidate.slice(start, end + 1);
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(repairJson(text));
    } catch {
      throw new ReplyError(`写回的 JSON 无法解析：${reply.slice(0, 200)}`);
    }
  }
}

/** 按 schema 校验写回的 JSON，出错时说清哪里不对。 */
export function parseReply<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { message: string } } }, reply: string): T {
  const r = schema.safeParse(extractJson(reply));
  if (!r.success) throw new ReplyError(`写回的 JSON 格式不对：${r.error.message.slice(0, 300)}`);
  return r.data;
}

/**
 * 修复常见的 JSON 毛病：字符串里未转义的英文双引号（改成中文引号）与原始换行（转义），
 * 以及括号错配（如数组以 } 收尾）——按栈把错配的右括号换成应有的那个，末尾补齐缺失的。
 * 判断依据：字符串内的双引号，若其后（跳过空白）紧跟 , } ] : 或文本结束，才视为字符串的结束。
 */
export function repairJson(text: string): string {
  let out = "";
  let inString = false;
  let open = true; // 下一个内容引号用左引号还是右引号
  const stack: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (!inString) {
      if (ch === '"') inString = true;
      if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
      if (ch === "}" || ch === "]") {
        const expected = stack.pop();
        out += expected ?? ch;
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === "\\") {
      out += ch + (text[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === "\n") {
      out += "\\n";
      continue;
    }
    if (ch === '"') {
      const rest = text.slice(i + 1).trimStart();
      if (rest === "" || /^[,}\]:]/.test(rest)) {
        inString = false;
        open = true;
        out += ch;
      } else {
        out += open ? "“" : "”";
        open = !open;
      }
      continue;
    }
    out += ch;
  }
  return out + stack.reverse().join("");
}
