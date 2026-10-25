import type { Command } from "commander";
import {
  LINK_KIND_LABELS,
  type Link,
  type LinkKind,
  confirmLink,
  createLink,
  activationBrief,
  describeRef,
  pendingProposals,
  proposeLink,
  rejectLink,
  removeLink,
  writeActivations,
} from "@bookside/core";
import { LINKABLE, emit, emitBrief, getDb, indent, parseAsOf, print, readContent, ref, resolve, resolveRef } from "../context.ts";

function parseKind(value: string): LinkKind {
  const hit = Object.entries(LINK_KIND_LABELS).find(([k, label]) => value === k || value === label);
  if (!hit) {
    throw new Error(`未知关联类型 ${value}，可用：${Object.entries(LINK_KIND_LABELS).map(([k, l]) => `${k}(${l})`).join(" ")}`);
  }
  return hit[0] as LinkKind;
}

/** 关联的可读形式：两端原文 + 类型 + 理由。 */
export function describeLink(l: Link) {
  const db = getDb();
  return {
    ...l,
    fromLabel: describeRef(db, { type: l.fromType, id: l.fromId }),
    toLabel: describeRef(db, { type: l.toType, id: l.toId }),
  };
}

export function renderLink(l: Link): string {
  const d = describeLink(l);
  const lines = [`[${ref("link", l.id)}] ${LINK_KIND_LABELS[l.kind]}：${d.fromLabel}`, indent(`→ ${d.toLabel}`)];
  if (l.reason) lines.push(indent(`理由：${l.reason}`));
  return lines.join("\n");
}

export function registerLinks(program: Command): void {
  const link = program.command("link").description("关联：两个对象间经你确认的关系");
  const kinds = Object.entries(LINK_KIND_LABELS).map(([k, l]) => `${k}(${l})`).join(" / ");

  link
    .command("pending", { isDefault: true })
    .description("等你确认的关联提议")
    .action(() => {
      const list = pendingProposals(getDb());
      emit(list.map(describeLink), () => (list.length === 0 ? "没有待确认的关联提议。" : list.map(renderLink).join("\n")));
    });

  link
    .command("propose <from> <to> <kind>")
    .description(`AI 提议一条关联（等你确认）。引用写成 h:… / q:… 等；类型：${kinds}`)
    .option("--reason <text>", "提议理由")
    .action((from: string, to: string, kind: string, opts: { reason?: string }) => {
      const l = proposeLink(getDb(), {
        from: resolveRef(from, LINKABLE),
        to: resolveRef(to, LINKABLE),
        kind: parseKind(kind),
        reason: opts.reason,
      });
      emit(describeLink(l), () => (l.state === "proposed" ? `已提议\n${renderLink(l)}` : `已存在（${l.state}）：\n${renderLink(l)}`));
    });

  link
    .command("add <from> <to> <kind>")
    .description(`你亲手建立一条关联，直接生效；类型：${kinds}`)
    .action((from: string, to: string, kind: string) => {
      const l = createLink(getDb(), { from: resolveRef(from, LINKABLE), to: resolveRef(to, LINKABLE), kind: parseKind(kind) });
      emit(describeLink(l), () => `已建立\n${renderLink(l)}`);
    });

  link
    .command("confirm <link>")
    .description("确认一条提议")
    .action((input: string) => {
      const l = confirmLink(getDb(), resolve("link", input));
      emit(describeLink(l), () => `已确认\n${renderLink(l)}`);
    });

  link
    .command("remove <link>")
    .description("解除一条已确认的关联（之后不会再提议同一条）")
    .action((input: string) => {
      const l = removeLink(getDb(), resolve("link", input));
      emit(describeLink(l), () => `已解除\n${renderLink(l)}`);
    });

  link
    .command("reject <link>")
    .description("拒绝一条提议（AI 不会再提）")
    .action((input: string) => {
      const l = rejectLink(getDb(), resolve("link", input));
      emit(describeLink(l), () => `已拒绝\n${renderLink(l)}`);
    });

  const activate = program.command("activate").description("跨书激活：看新划线和新想法有没有回应其他书里的旧问题（给智能体）");
  activate
    .command("brief <book>")
    .description("取一本书里新内容与其他书里问题的材料，判断后用 activate write 写回")
    .action((input: string) => {
      const b = activationBrief(getDb(), resolve("book", input));
      if (!b) return print("没有起源于其他书的问题，跨书激活无事可做。");
      emitBrief(b);
    });
  activate
    .command("write <book> <content>")
    .description("写回 activate brief 那一批的关联提议（JSON，content 为 - 时读标准输入）")
    .requiredOption("--as-of <time>", "brief 里给出的时间戳")
    .action((input: string, content: string, opts: { asOf: string }) => {
      const list = writeActivations(getDb(), resolve("book", input), readContent(content), { asOf: parseAsOf(opts.asOf) });
      emit(list.map(describeLink), () =>
        list.length ? [`提议 ${list.length} 条关联，等读者确认：`, ...list.map(renderLink)].join("\n") : "这一批没有提议，已记为处理过。",
      );
    });
}
