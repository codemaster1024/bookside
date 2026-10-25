// 打出发布到 npm 的 bookside 包：命令行、core 与查看器合成一个文件，better-sqlite3 含原生模块，留作依赖按平台安装。
import { chmodSync, cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const root = join(import.meta.dirname, "..");
const out = join(root, "packages/bookside");
const REPO = "https://github.com/codemaster1024/bookside";
const RAW = "https://raw.githubusercontent.com/codemaster1024/bookside/main/";

for (const p of ["dist", "migrations", "skills", "README.md", "LICENSE"]) rmSync(join(out, p), { recursive: true, force: true });

await build({
  entryPoints: [join(root, "packages/cli/src/main.ts")],
  outfile: join(out, "dist/bookside.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["better-sqlite3"],
  // 打进来的 CommonJS 依赖会用到 require。
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  legalComments: "none",
});
chmodSync(join(out, "dist/bookside.js"), 0o755);

cpSync(join(root, "packages/core/migrations"), join(out, "migrations"), { recursive: true });
cpSync(join(root, "skills/bookside"), join(out, "skills/bookside"), { recursive: true });
cpSync(join(root, "LICENSE"), join(out, "LICENSE"));
// npm 页面上相对路径的图片和链接都打不开：图片换成仓库里的原图地址，其余链接指向 GitHub 上的文件。
const absolute = (path) => (path.startsWith("docs/images/") ? `${RAW}${path}` : `${REPO}/blob/main/${path}`);
const readme = readFileSync(join(root, "README.md"), "utf8")
  .replace(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g, (_m, path) => `](${absolute(path)})`)
  .replace(/\b(src|srcset|href)="(?!https?:|#|mailto:)([^"]+)"/g, (_m, attr, path) => `${attr}="${absolute(path)}"`);
writeFileSync(join(out, "README.md"), readme);
