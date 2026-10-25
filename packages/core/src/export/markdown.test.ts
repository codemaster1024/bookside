import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { books, guides, highlights } from "../db/schema.ts";
import { T0, seed } from "../domain/fixtures.test-helper.ts";
import { createInsight, reviseInsight } from "../domain/insights.ts";
import { confirmLink, proposeLink } from "../domain/links.ts";
import { appendMessage, createQuestion, setQuestionStatus } from "../domain/questions.ts";
import { shortId } from "../domain/ids.ts";
import { EXPORT_MARKER, buildExport, writeExport } from "./markdown.ts";

function sample() {
  const s = seed();
  const { db, highlightId } = s;
  const q = createQuestion(db, { title: "作者在偷换哪个概念？", origin: { type: "highlight", id: highlightId } }, T0);
  appendMessage(db, q.id, { speaker: "me", content: "我的原话", highlightIds: [highlightId] }, T0);
  appendMessage(db, q.id, { speaker: "ai", content: "AI 的追问" }, T0);
  const i = createInsight(db, { content: "AI 起草", author: "ai", sources: [{ questionId: q.id }] }, T0);
  reviseInsight(db, i.id, { content: "我在 AI 稿上改的", author: "me" }, T0);
  setQuestionStatus(db, q.id, "resolved");
  confirmLink(db, proposeLink(db, { from: { type: "highlight", id: highlightId }, to: { type: "question", id: q.id }, kind: "answers", reason: "直接回答" }).id);
  return { ...s, q };
}

describe("buildExport", () => {
  it("writes one file per book and per question, plus an index and an insight list named to avoid clashes in a vault", () => {
    const { db } = sample();
    expect([...buildExport(db).keys()].sort()).toEqual(["books/《书》.md", "questions/作者在偷换哪个概念？.md", "书畔.md", "观点.md"]);
  });

  it("keeps the reader's words and the AI's apart, and marks insight authorship from history", () => {
    const { db, highlightId } = sample();
    const q = buildExport(db).get("questions/作者在偷换哪个概念？.md")!;
    expect(q).toContain("**我** · ");
    expect(q).toContain("我的原话");
    expect(q).toContain("**AI** · ");
    expect(q).toContain("> 引用：原文");
    expect(q).toContain("### AI 协助\n\n我在 AI 稿上改的");
    expect(q).toContain("版本历史：v1 2026-10-01 AI；v2 2026-10-01 我");
    expect(q).toContain('status: "resolved"');
    expect(q).toContain('origin: "[[《书》]]"');
    expect(q).toContain('tags:\n  - "bookside/question"');
    expect(q).toContain(`- 回答：[[《书》#^h-${shortId(highlightId)}|《书》划线「原文」]]——直接回答`);
  });

  it("lays out a book's highlights with block ids and notes, its questions and related insights", () => {
    const { db, highlightId } = sample();
    const book = buildExport(db).get("books/《书》.md")!;
    expect(book).toContain(`> 原文 ^h-${shortId(highlightId)}\n\n- 想法（2026-10-01）：作者在偷换概念`);
    expect(book).toContain("- [[作者在偷换哪个概念？]] · 已解决");
    expect(book).toContain('tags:\n  - "bookside/book"');
    expect(book).toContain("## 观点");
  });

  it("leaves out shelf-only books with nothing in them", () => {
    const { db } = seed();
    db.insert(books).values({ source: "weread", title: "只在书架上" }).run();
    expect([...buildExport(db).keys()].filter((k) => k.startsWith("books/"))).toEqual(["books/《书》.md"]);
  });

  it("exports guides under a clearly marked AI section, including books that have nothing but a guide", () => {
    const { db, bookId } = seed();
    db.insert(guides).values({ bookId, basis: "familiar", content: "## 一句话\n讲习惯" }).run();
    const off = db.insert(books).values({ source: "weread", wereadBookId: "W9", title: "微习惯" }).returning().get().id;
    db.insert(guides).values({ bookId: off, basis: "limited", content: "依据有限。" }).run();
    const files = buildExport(db);
    const book = files.get("books/《书》.md")!;
    expect(book).toContain("## AI 导读\n\n> 以下由 AI 写成，不是你的笔记。");
    expect(book).toContain("#### 一句话\n讲习惯");
    expect(files.get("books/《微习惯》.md")).toContain("依据有限。");
  });

  it("keeps content deleted at the source, marked", () => {
    const { db, bookId } = seed();
    db.insert(highlights).values({ bookId, source: "weread", text: "删掉的", markedAt: T0, deletedAtSourceAt: T0 }).run();
    expect(buildExport(db).get("books/《书》.md")).toContain("*源端已删除*");
  });

  it("disambiguates colliding file names and escapes characters that break paths or links", () => {
    const { db } = seed();
    db.insert(books).values([{ source: "local", title: "A/B (上)", purpose: "x" }, { source: "local", title: "A/B (上)", purpose: "y" }]).run();
    const names = [...buildExport(db).keys()].filter((k) => k.startsWith("books/《A"));
    expect(names).toHaveLength(2);
    expect(names.every((n) => /^books\/《A B \(上\)》 \([0-9a-f]{8}\)\.md$/.test(n))).toBe(true);
    expect(buildExport(db).get("书畔.md")).toContain("- [[《A B (上)》 (");
  });
});

describe("writeExport", () => {
  const tmp = () => mkdtempSync(join(tmpdir(), "bookside-export-"));

  it("refuses a non-empty directory that is not a previous export", () => {
    const dir = tmp();
    writeFileSync(join(dir, "mine.md"), "我的笔记");
    expect(() => writeExport(new Map([["书畔.md", "x"]]), dir)).toThrow(/不是空目录/);
    expect(readFileSync(join(dir, "mine.md"), "utf8")).toBe("我的笔记");
  });

  it("replaces its own files on re-export, dropping stale ones but leaving the reader's other files", () => {
    const dir = join(tmp(), "out");
    writeExport(new Map([["questions/旧标题.md", "old"], ["书畔.md", "v1"]]), dir);
    expect(existsSync(join(dir, EXPORT_MARKER))).toBe(true);
    mkdirSync(join(dir, "我的"), { recursive: true });
    writeFileSync(join(dir, "我的", "札记.md"), "keep");
    writeExport(new Map([["questions/新标题.md", "new"], ["书畔.md", "v2"]]), dir);
    expect(existsSync(join(dir, "questions", "旧标题.md"))).toBe(false);
    expect(readFileSync(join(dir, "questions", "新标题.md"), "utf8")).toBe("new\n");
    expect(readFileSync(join(dir, "我的", "札记.md"), "utf8")).toBe("keep");
  });
});
