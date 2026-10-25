import { describe, expect, it } from "vitest";
import { ReplyError, extractJson, matchRef, refOf } from "./brief.ts";

describe("extractJson", () => {
  it("handles fences and surrounding prose", () => {
    expect(extractJson('好的：\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('结果是 {"a":{"b":2}} 。')).toEqual({ a: { b: 2 } });
  });

  it("repairs unescaped ASCII quotes and raw newlines inside strings", () => {
    const broken = '```json\n{"probes":[{"target":"h:1","probe":"你说"一断了就不想写了"，\n核心是"打卡"。"}]}\n```';
    expect(extractJson(broken)).toEqual({ probes: [{ target: "h:1", probe: "你说“一断了就不想写了”，\n核心是“打卡”。" }] });
  });

  it("repairs mismatched and missing closing brackets", () => {
    expect(extractJson('{"questions":["一？","二？"}}')).toEqual({ questions: ["一？", "二？"] });
    expect(extractJson('{"a":[1,2}')).toEqual({ a: [1, 2] });
  });

  it("leaves valid JSON with escaped quotes untouched", () => {
    expect(extractJson('{"a":"他说\\"好\\"","b":[1,2]}')).toEqual({ a: '他说"好"', b: [1, 2] });
  });

  it("throws a ReplyError when there is no JSON", () => {
    expect(() => extractJson("抱歉")).toThrow(ReplyError);
  });
});

describe("matchRef", () => {
  const among = [{ id: "a1b2c3d4-0000" }, { id: "a1b2ffff-0000" }, { id: "99990000-0000" }];

  it("matches a ref of the right kind by unique prefix", () => {
    expect(refOf("highlight", "a1b2c3d4-0000")).toBe("h:a1b2c3d4");
    expect(matchRef("h:a1b2c3d4", "highlight", among)).toBe(among[0]);
    expect(matchRef(" H:9999 ", "highlight", among)).toBe(among[2]);
  });

  it("ignores wrong kinds, ambiguous prefixes and objects outside the brief", () => {
    expect(matchRef("n:a1b2c3d4", "highlight", among)).toBeUndefined();
    expect(matchRef("h:a1b2", "highlight", among)).toBeUndefined();
    expect(matchRef("h:deadbeef", "highlight", among)).toBeUndefined();
    expect(matchRef("H1", "highlight", among)).toBeUndefined();
  });
});
