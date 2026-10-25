import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    // 导出等按本地日期显示，固定时区让断言与机器无关。
    env: { TZ: "Asia/Shanghai" },
  },
});
