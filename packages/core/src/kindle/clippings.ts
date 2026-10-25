// 解析 Kindle 的 My Clippings.txt：每条摘录占一段，以 ========== 分隔。
// 第一行是「书名 (作者)」，第二行是类型、位置与时间（中英文界面写法不同），空一行后是正文。

export type Clipping = {
  title: string;
  author: string | null;
  kind: "highlight" | "note";
  /** 位置区间；只有页码时 start = end = 页码，并记 byPage。 */
  start: number;
  end: number;
  byPage: boolean;
  addedAt: Date | null;
  text: string;
};

const SEPARATOR = /^={10}\s*$/m;
/** Kindle 达到摘录上限时写进文件的占位文字。 */
const LIMIT_NOTICE = /clipping limit|已达到.*(摘录|剪贴|标注).*上限/i;

export function parseClippings(file: string): Clipping[] {
  const out: Clipping[] = [];
  for (const block of file.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(SEPARATOR)) {
    const lines = block.split("\n").map((l) => l.replace(/^﻿/, ""));
    while (lines.length && !lines[0]!.trim()) lines.shift();
    if (lines.length < 2) continue;
    const meta = parseMeta(lines[1]!);
    if (!meta) continue;
    const text = lines.slice(2).join("\n").trim();
    if (!text || LIMIT_NOTICE.test(text)) continue;
    out.push({ ...parseTitle(lines[0]!), ...meta, text });
  }
  return out;
}

/** 「书名 (作者)」：作者取最后一对括号（中英文括号都行），书名里的括号保留。 */
function parseTitle(line: string): { title: string; author: string | null } {
  const t = line.trim();
  const m = t.match(/^(.*?)\s*[(（]([^()（）]+)[)）]\s*$/);
  if (!m || !m[1]) return { title: t, author: null };
  return { title: m[1].trim(), author: m[2]!.trim() };
}

function parseMeta(line: string): Omit<Clipping, "title" | "author" | "text"> | undefined {
  const l = line.trim();
  if (!l.startsWith("-")) return undefined;
  const kind = /Highlight|标注/i.test(l) ? "highlight" : /Note|笔记/i.test(l) ? "note" : undefined;
  if (!kind) return undefined; // 书签等
  const loc = l.match(/(?:Location|Loc\.|位置)\s*#?\s*(\d+)(?:\s*-\s*(\d+))?/i);
  const page = l.match(/(?:page|第)\s*(\d+)/i);
  let start: number;
  let end: number;
  let byPage = false;
  if (loc) {
    start = Number(loc[1]);
    end = loc[2] ? expandEnd(start, loc[2]) : start;
  } else if (page) {
    start = end = Number(page[1]);
    byPage = true;
  } else {
    return undefined;
  }
  return { kind, start, end, byPage, addedAt: parseDate(l) };
}

/** 老机型把区间写成 180-82，补全成 180-182。 */
function expandEnd(start: number, raw: string): number {
  const end = Number(raw);
  if (end >= start) return end;
  const s = String(start);
  const full = Number(s.slice(0, s.length - raw.length) + raw);
  return full >= start ? full : start;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** 「Added on Monday, March 4, 2024 9:15:32 PM」或「添加于 2024年3月4日星期一 下午9:15:32」，按本地时间。 */
function parseDate(line: string): Date | null {
  const zh = line.match(/(\d{4})年(\d{1,2})月(\d{1,2})日.*?(上午|下午|中午|晚上|凌晨)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (zh) {
    let h = Number(zh[5]);
    if ((zh[4] === "下午" || zh[4] === "晚上") && h < 12) h += 12;
    if (zh[4] === "上午" && h === 12) h = 0;
    return new Date(Number(zh[1]), Number(zh[2]) - 1, Number(zh[3]), h, Number(zh[6]), Number(zh[7] ?? 0));
  }
  const en = line.match(/Added on\s+(?:\w+,\s*)?(\w+)\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (en) {
    const month = MONTHS.indexOf(en[1]!.slice(0, 3).toLowerCase());
    if (month < 0) return null;
    let h = Number(en[4]);
    if (en[7]?.toUpperCase() === "PM" && h < 12) h += 12;
    if (en[7]?.toUpperCase() === "AM" && h === 12) h = 0;
    return new Date(Number(en[3]), month, Number(en[2]), h, Number(en[5]), Number(en[6] ?? 0));
  }
  return null;
}
