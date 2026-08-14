import { readFileSync, writeFileSync } from "fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const target = process.env.npm_config_new_version ?? process.argv[2];
if (!target) {
  console.error("用法: node version-bump.mjs <新版本>");
  process.exit(1);
}
manifest.version = target;
pkg.version = target;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
let versions = {};
try {
  versions = JSON.parse(readFileSync("versions.json", "utf8"));
} catch {
  versions = {};
}
versions[target] = "1.7.2";
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");
console.log(`版本已更新为 ${target}`);
