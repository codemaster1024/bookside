// 把书畔的 skill 装进本机的智能体：找到哪个装哪个，只覆盖自己装过的那一份。
import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 随命令行一起发布的 skill 目录：源码里在仓库根目录的 skills/，npm 包里与 dist 同级。 */
export const SKILL_SOURCE = [join(import.meta.dirname, "../../../skills/bookside"), join(import.meta.dirname, "../skills/bookside")].find((p) => existsSync(p))!;
/** 装进去的那份里放一个标记文件，记下装的是哪一版。 */
const MARKER = ".bookside-skill";

/**
 * 已知的智能体：家目录下有它的配置目录（detect），就把 skill 装进它读的全局 skill 目录（skills）。
 * 目录按各家文档与 vercel-labs/skills 的对照表；几家共用 ~/.agents/skills，只装一份。
 */
const AGENTS: { name: string; detect: string; skills: string }[] = [
  { name: "Claude Code", detect: ".claude", skills: ".claude/skills" },
  { name: "Codex", detect: ".codex", skills: ".agents/skills" },
  { name: "Kimi Code", detect: ".kimi", skills: ".agents/skills" },
  { name: "通用 Agent Skills", detect: ".agents", skills: ".agents/skills" },
  { name: "Cursor", detect: ".cursor", skills: ".cursor/skills" },
  { name: "Gemini CLI", detect: ".gemini", skills: ".gemini/skills" },
  { name: "GitHub Copilot", detect: ".copilot", skills: ".copilot/skills" },
  { name: "OpenCode", detect: ".config/opencode", skills: ".config/opencode/skills" },
  { name: "Trae", detect: ".trae", skills: ".trae/skills" },
  { name: "Trae CN", detect: ".trae-cn", skills: ".trae-cn/skills" },
  { name: "Qoder", detect: ".qoder", skills: ".qoder/skills" },
  { name: "CodeBuddy", detect: ".codebuddy", skills: ".codebuddy/skills" },
  { name: "Qwen Code", detect: ".qwen", skills: ".qwen/skills" },
  { name: "Windsurf", detect: ".codeium/windsurf", skills: ".codeium/windsurf/skills" },
  { name: "Kiro", detect: ".kiro", skills: ".kiro/skills" },
];

export type SkillTarget = {
  /** 读这个目录的智能体，几家共用时用顿号连起来。 */
  agent: string;
  /** 装到哪里：<skill 目录>/bookside。 */
  path: string;
  /** missing 还没装；current 已是最新；outdated 装过旧版；foreign 有同名 skill 但不是书畔装的。 */
  state: "missing" | "current" | "outdated" | "foreign";
};

const fingerprint = (dir: string) => createHash("sha256").update(readFileSync(join(dir, "SKILL.md"))).digest("hex").slice(0, 16);

export function skillTargets(home = homedir(), source = SKILL_SOURCE): SkillTarget[] {
  const want = fingerprint(source);
  const found = new Map<string, string[]>();
  for (const a of AGENTS) {
    if (existsSync(join(home, a.detect))) found.set(a.skills, [...(found.get(a.skills) ?? []), a.name]);
  }
  return [...found].map(([skills, names]) => {
    const path = join(home, skills, "bookside");
    const marker = join(path, MARKER);
    const state = !existsSync(path)
      ? "missing"
      : !existsSync(marker)
        ? "foreign"
        : readFileSync(marker, "utf8").trim() === want
          ? "current"
          : "outdated";
    // 只有通用目录本身被发现时才提它；有具体的智能体就只列智能体。
    const named = names.length > 1 ? names.filter((n) => n !== "通用 Agent Skills") : names;
    return { agent: named.join("、"), path, state };
  });
}

/** 升级后把书畔自己装过的旧版换成新版；没装过的智能体不碰（那要用户运行 init）。返回更新了的。 */
export function refreshSkill(home = homedir(), source = SKILL_SOURCE): SkillTarget[] {
  const outdated = skillTargets(home, source).filter((t) => t.state === "outdated");
  if (outdated.length === 0) return [];
  const want = fingerprint(source);
  return outdated.map((t) => {
    rmSync(t.path, { recursive: true, force: true });
    cpSync(source, t.path, { recursive: true });
    writeFileSync(join(t.path, MARKER), `${want}\n`);
    return { ...t, state: "current" as const };
  });
}

/** 装上或更新；别人的同名 skill 不碰。返回每个智能体的结果。 */
export function installSkill(home = homedir(), source = SKILL_SOURCE): SkillTarget[] {
  const want = fingerprint(source);
  return skillTargets(home, source).map((t) => {
    if (t.state === "foreign" || t.state === "current") return t;
    rmSync(t.path, { recursive: true, force: true });
    cpSync(source, t.path, { recursive: true });
    writeFileSync(join(t.path, MARKER), `${want}\n`);
    return { ...t, state: "current" };
  });
}
