import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installSkill, refreshSkill, skillTargets } from "./skill.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "bookside-skill-"));
  const home = join(root, "home");
  const source = join(root, "skill");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "v1");
  return { home, source };
}

describe("skill install", () => {
  it("installs only into agents present on the machine, and updates its own copy", () => {
    const { home, source } = setup();
    mkdirSync(join(home, ".claude"), { recursive: true });
    expect(skillTargets(home, source).map((t) => [t.agent, t.state])).toEqual([["Claude Code", "missing"]]);
    expect(installSkill(home, source).map((t) => t.state)).toEqual(["current"]);
    expect(readFileSync(join(home, ".claude/skills/bookside/SKILL.md"), "utf8")).toBe("v1");

    writeFileSync(join(source, "SKILL.md"), "v2");
    expect(skillTargets(home, source)[0]!.state).toBe("outdated");
    installSkill(home, source);
    expect(readFileSync(join(home, ".claude/skills/bookside/SKILL.md"), "utf8")).toBe("v2");
  });

  it("refreshes only its own outdated copies, never installing into new agents", () => {
    const { home, source } = setup();
    mkdirSync(join(home, ".claude"), { recursive: true });
    installSkill(home, source);
    mkdirSync(join(home, ".codex"), { recursive: true });
    expect(refreshSkill(home, source)).toEqual([]);
    writeFileSync(join(source, "SKILL.md"), "v2");
    expect(refreshSkill(home, source).map((t) => t.agent)).toEqual(["Claude Code"]);
    expect(readFileSync(join(home, ".claude/skills/bookside/SKILL.md"), "utf8")).toBe("v2");
    expect(skillTargets(home, source).map((t) => [t.agent, t.state])).toEqual([["Claude Code", "current"], ["Codex", "missing"]]);
  });

  it("installs into the directory each agent actually reads, once per shared directory", () => {
    const { home, source } = setup();
    for (const d of [".codex", ".kimi", ".trae-cn", ".config/opencode"]) mkdirSync(join(home, d), { recursive: true });
    expect(installSkill(home, source).map((t) => [t.agent, t.path.slice(home.length)])).toEqual([
      ["Codex、Kimi Code", "/.agents/skills/bookside"],
      ["OpenCode", "/.config/opencode/skills/bookside"],
      ["Trae CN", "/.trae-cn/skills/bookside"],
    ]);
  });

  it("leaves a same-named skill it did not install alone", () => {
    const { home, source } = setup();
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(join(home, ".agents/skills/bookside"), { recursive: true });
    writeFileSync(join(home, ".agents/skills/bookside/SKILL.md"), "someone else's");
    expect(installSkill(home, source).map((t) => [t.agent, t.state])).toEqual([["Codex", "foreign"]]);
    expect(readFileSync(join(home, ".agents/skills/bookside/SKILL.md"), "utf8")).toBe("someone else's");
  });
});
