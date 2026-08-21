import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";

const prod = process.argv[2] === "production";
const builtins = builtinModules;

const context = await esbuild.context({
  // 固定 banner（不内嵌时间戳）：社区审核会从源码重建并字节比对产物，时间戳会导致
  // 每次构建字节不同 → "Build output does not match the released main.js artifact"。
  banner: { js: "/* dsh-obsidian */" },
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    "bufferutil",
    "utf-8-validate",
    ...builtins,
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
