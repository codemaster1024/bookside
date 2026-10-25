import type { Command } from "commander";
import {
  type QuestionDetail,
  appendMessage,
  scanBrief,
  scanKeywordsBrief,
  writeScan,
  createQuestion,
  dueRevisits,
  getQuestionDetail,
  listMessages,
  listQuestions,
  postponeRevisit,
  renameQuestion,
  setQuestionStatus,
  type Question,
} from "@bookside/core";
import {
  emitBrief,
  collect,
  day,
  emit,
  getDb,
  indent,
  parseSpeaker,
  parseStatus,
  readContent,
  ref,
  resolve,
  resolveRef,
  statusLabel,
} from "../context.ts";
import { renderLink } from "./links.ts";

function originText(d: QuestionDetail): string {
  const o = d.origin;
  if (!o) return "长期问题（不属于任何书）";
  if (o.type === "book") return `《${o.bookTitle}》`;
  if (o.type === "chapter") return `《${o.bookTitle}》${o.chapterTitle}`;
  return `《${o.bookTitle}》划线 [${ref("highlight", o.id)}]「${o.quote}」`;
}

function summaryLine(q: Question): string {
  const revisit = q.nextRevisitAt ? ` · 回访 ${day(q.nextRevisitAt)}` : "";
  return `[${ref("question", q.id)}] ${statusLabel(q.status)}${revisit}  ${q.title}`;
}

function renderDetail(d: QuestionDetail): string {
  const q = d.question;
  const lines = [
    `[${ref("question", q.id)}] ${q.title}`,
    `状态：${statusLabel(q.status)} · 下次回访：${day(q.nextRevisitAt)} · 起源：${originText(d)}`,
    "",
    "—— 线程 ——",
  ];
  if (d.messages.length === 0) lines.push("（还没有发言）");
  for (const m of d.messages) {
    lines.push(`${day(m.createdAt)} ${m.speaker === "me" ? "我" : "AI"}：`, indent(m.content));
    for (const c of m.cited) lines.push(indent(`引用 [${ref("highlight", c.id)}]「${c.text}」`));
  }
  if (d.insights.length) {
    lines.push("", "—— 观点 ——");
    for (const i of d.insights) {
      lines.push(`[${ref("insight", i.id)}] ${i.authorship === "mine" ? "我写的" : "AI 协助"}`, indent(i.content));
    }
  }
  if (d.links.length) {
    lines.push("", "—— 关联 ——");
    for (const l of d.links) lines.push(renderLink(l));
  }
  return lines.join("\n");
}

export function registerQuestions(program: Command): void {
  const question = program.command("question").alias("q").description("问题线程");

  question
    .command("new <title>")
    .description("创建问题（只在你决定要持续想下去时）")
    .option("--origin <ref>", "起源：b:<书> / c:<章节> / h:<划线>；省略即长期问题")
    .action((title: string, opts: { origin?: string }) => {
      const origin = opts.origin ? resolveRef(opts.origin, ["book", "chapter", "highlight"] as const) : undefined;
      const q = createQuestion(getDb(), { title, origin });
      emit(q, () => `已创建问题 ${ref("question", q.id)}：${q.title}`);
    });

  question
    .command("list", { isDefault: true })
    .description("问题列表（最近创建的在前）")
    .option("--status <status>", "按状态筛选，可重复", collect)
    .option("--book <book>", "只看起源于某本书的")
    .action((opts: { status?: string[]; book?: string }) => {
      const list = listQuestions(getDb(), {
        status: opts.status?.map(parseStatus),
        bookId: opts.book ? resolve("book", opts.book) : undefined,
      });
      emit(list, () => (list.length === 0 ? "没有问题。" : list.map(summaryLine).join("\n")));
    });

  question
    .command("show <question>")
    .description("查看问题线程：起源、发言、观点、关联")
    .action((input: string) => {
      const d = getQuestionDetail(getDb(), resolve("question", input));
      emit(d, () => renderDetail(d));
    });

  question
    .command("say <question> <content>")
    .description("在线程里记一次发言（content 为 - 时读标准输入）")
    .requiredOption("--as <speaker>", "me（你本人的原话）或 ai（AI 的回应）", parseSpeaker)
    .option("--cite <highlight>", "引用的划线，可重复", collect)
    .action((input: string, content: string, opts: { as: "me" | "ai"; cite?: string[] }) => {
      const m = appendMessage(getDb(), resolve("question", input), {
        speaker: opts.as,
        content: readContent(content),
        highlightIds: opts.cite?.map((c) => resolve("highlight", c)),
      });
      emit(m, () => `已记下（${opts.as === "me" ? "我" : "AI"}）。`);
    });

  question
    .command("rename <question> <title>")
    .description("给问题改个名字：想法变了、原来的说法不准时（问题不删除，不想再想就设为放弃）")
    .action((input: string, title: string) => {
      const q = renameQuestion(getDb(), resolve("question", input), title);
      emit(q, () => summaryLine(q));
    });

  question
    .command("status <question> <status>")
    .description("改变状态：unexplored 未探索 / exploring 探讨中 / tentative 暂有答案 / resolved 已解决 / abandoned 放弃")
    .action((input: string, status: string) => {
      const q = setQuestionStatus(getDb(), resolve("question", input), parseStatus(status));
      emit(q, () => summaryLine(q));
    });

  question
    .command("postpone <question>")
    .description("回访时暂无新想法：推到下一个更长的间隔；加 --far 直接推到最长（你说「这个先别问了」时）")
    .option("--far", "推到最长的间隔")
    .action((input: string, opts: { far?: boolean }) => {
      const q = postponeRevisit(getDb(), resolve("question", input), { far: opts.far });
      emit(q, () => `下次回访：${day(q.nextRevisitAt)}`);
    });

  question
    .command("scan <question>")
    .description("在旧划线里找找：为这个问题在你已有的划线里找回应它的段落，提议关联等你确认（给智能体，分两步）")
    .option("--keywords <words>", "第二步：用逗号分开的检索词，取命中的划线")
    .option("--write <content>", "第三步：写回关联提议（JSON，- 为读标准输入）")
    .action((input: string, opts: { keywords?: string; write?: string }) => {
      const id = resolve("question", input);
      if (opts.write !== undefined) {
        const list = writeScan(getDb(), id, readContent(opts.write));
        return emit(list, () =>
          list.length ? [`提议 ${list.length} 条关联，用 bookside link confirm / reject 处理：`, ...list.map(renderLink)].join("\n") : "没有提议。",
        );
      }
      if (opts.keywords) return emitBrief(scanBrief(getDb(), id, opts.keywords.split(/[,，、\s]+/).filter(Boolean)));
      emitBrief(scanKeywordsBrief(getDb(), id));
    });

  program
    .command("revisits")
    .description("今日回访：到期的问题，附最近一次发言")
    .action(() => {
      const db = getDb();
      const due = dueRevisits(db).map((q) => ({ ...q, lastMessage: listMessages(db, q.id).at(-1) ?? null }));
      emit(due, () =>
        due.length === 0
          ? "今天没有需要回访的问题。"
          : [
              `有 ${due.length} 个问题到了回访时间：`,
              ...due.map((q) => {
                const last = q.lastMessage
                  ? indent(`上次（${day(q.lastMessage.createdAt)}，${q.lastMessage.speaker === "me" ? "我" : "AI"}）：${q.lastMessage.content.slice(0, 80)}`)
                  : indent("还没有发言");
                return `${summaryLine(q)}\n${last}`;
              }),
            ].join("\n"),
      );
    });
}
