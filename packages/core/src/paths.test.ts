import { describe, expect, it } from "vitest";
import { booksideHome, databasePath } from "./paths.ts";

describe("paths", () => {
  it("honours BOOKSIDE_HOME", () => {
    const env = { BOOKSIDE_HOME: "/tmp/bs" };
    expect(booksideHome(env)).toBe("/tmp/bs");
    expect(databasePath(env)).toBe("/tmp/bs/bookside.db");
  });
});
