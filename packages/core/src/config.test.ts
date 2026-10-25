import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, saveConfig, wereadApiKey } from "./config.ts";

const tmp = () => join(mkdtempSync(join(tmpdir(), "bookside-")), "config.json");

describe("config", () => {
  it("defaults when the file is missing", () => {
    expect(loadConfig(tmp())).toEqual({ probes: { perBookLimit: 3 }, weread: {} });
  });

  it("round-trips and keeps the file private", () => {
    const path = tmp();
    const config = loadConfig(path);
    config.weread.apiKey = "wrk-test";
    config.probes.perBookLimit = 5;
    saveConfig(config, path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadConfig(path)).toEqual({ probes: { perBookLimit: 5 }, weread: { apiKey: "wrk-test" } });
  });

  it("explains what is wrong with an invalid file", () => {
    const path = tmp();
    writeFileSync(path, JSON.stringify({ probes: { perBookLimit: -1 } }));
    expect(() => loadConfig(path)).toThrow(/probes\.perBookLimit/);
  });

  it("prefers the WEREAD_API_KEY env var over the file", () => {
    const config = { ...loadConfig(tmp()), weread: { apiKey: "wrk-file" } };
    expect(wereadApiKey(config, {})).toBe("wrk-file");
    expect(wereadApiKey(config, { WEREAD_API_KEY: "wrk-env" })).toBe("wrk-env");
  });
});
