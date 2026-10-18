# 发版流程

面向维护者。这个插件的用户通过 **Obsidian 社区插件市场**安装，而市场只从
**GitHub Release 的资产**拉取文件 —— 所以「代码推上 master」和「用户拿到新版本」
是两件不同的事。本文记录把前者变成后者的完整步骤。

> 本文的每一步都来自 0.1.9 → 0.2.0 的实操。若某步与现状不符，以仓库实际状态为准并回来更新本文。

## 0. 心智模型：三个东西必须同时到位

发版失败几乎都是这三者之一没对齐：

| 东西 | 作用 | 漏了会怎样 |
|---|---|---|
| `tag` | 市场据此判断「有新版本」 | 用户永远看不到更新 |
| Release 资产（`main.js` / `manifest.json`） | 用户**实际下载**的文件 | 市场报错，或装到旧代码 |
| `manifest.json` 的 `version` | 与 tag 比对是否一致 | 市场拒绝该版本 |

关键不变式：**Release 里的 `main.js` 字节 == 从源码重建的产物字节**。
社区审核会自己做这个比对；仓库也用 `.gitattributes` 钉死了行尾（见文末「坑」）。

## 1. 决定版本号

按语义化版本，判断依据是**用户可见行为是否变化**：

- **次版本号**（`0.1.9` → `0.2.0`）：行为变更。例如端口从「手填」改成「自动发现」、
  界面语言从「手动切换」改成「跟随 Obsidian」、新增「DSH 重启后自动重连」。
- **补丁号**（`0.2.0` → `0.2.1`）：纯修复，不改变用户已有的操作方式。
- `0.1.3` / `0.1.6` **没有 tag/release**（0.1.6 撤回并入 0.1.7）。沟通时不要引用这两个版本号。

## 2. 改版本号（三个文件）

仓库自带脚本，一次改完三个文件：

```bash
npm run version 0.2.0     # 实际调用 node version-bump.mjs 0.2.0
```

它做三件事：`manifest.json` 与 `package.json` 的 `version`、`versions.json` 新增
`"0.2.0": "<minAppVersion>"`。

`versions.json` 的值读自 `manifest.minAppVersion`（本次已把原先硬编码的 `"1.7.2"`
改成读取，避免「同时提高最低版本」时静默写错）。所以顺序无关：先改 `minAppVersion`
再跑脚本也正确。

### `minAppVersion` 该不该提高

只有当**新代码在低版本宿主上会直接报错**时才提高。若只是用到了较新的 API，
优先用 `requireApiVersion` 守卫并给出降级行为：

```ts
// 先例：getLanguage() 需要 1.8.7，但 minAppVersion 仍是 1.7.2
requireApiVersion("1.8.7") ? getLanguage() : undefined   // 低版本 → 回落中文
```

为可选 API 提高最低版本会白白挡掉老用户，不值得。
但**必须确认降级路径真的不崩** —— 这条要有单测或真机验证。

## 3. 跑门禁

三样都必须干净：

```bash
npm run lint      # eslint src，要求 0 warning（不是 0 error）
npm test          # 全量单测
npm run build     # tsc --noEmit + 生产构建
```

再单独确认**构建可复现**（同一个源码构建两次，产物字节必须相同）：

```bash
npm run build && cp main.js /tmp/a.js && npm run build && cmp main.js /tmp/a.js && echo OK
```

`cmp` 静默通过才算过。CI 也会自己做一遍（`sha256sum` 比对），但发版前本地验一遍更快暴露问题。

## 4. 更新变更记录

`docs/CHANGELOG-unreleased-*.md` 是**开发期**的详细记录（含真机验证过程、遗留项），
保留原样、改个日期或另起新文件。GitHub Release 说明另写一份**用户视角**的短版：

- 先说「需要做什么」（通常是「直接更新即可，无需重新配置」）
- 按「新特性 / 修复」分组，写用户能感知的效果，不写内部实现
- **每一条都要能在代码里找到对应实现** —— release notes 写了没修的东西比不写更糟

```bash
# 核实自己没写虚的：逐个关键词确认真有对应代码
git grep -l "turnNoticeText" HEAD -- src/
```

## 5. 提交产物（最容易漏的一步）

`main.js` 在 `.gitignore` 里，但**已经被 git 跟踪**。后果是：日常 `git add -A`
不会包含它，历史提交里的产物会一直停在旧版本 —— 而 Release 需要它是新的。

```bash
npm run build
git add -f main.js                                   # -f 强制，绕过 .gitignore
git add manifest.json package.json versions.json
git commit -m "release: 0.2.0"
git diff --cached --stat main.js                     # 确认产物真的进了暂存区
```

**校验产物确实是新代码**（压缩后内部标识符会被改写，别用它们判断）：

```bash
# 好的判断依据：稳定的 className / 字面量字符串
git show HEAD:main.js | grep -c "dsh-msg-command"
# 坏的做法：查 describeNode / REFIND_COOLDOWN_FAILURES —— 压缩后不存在
```

## 6. 打 tag 并推送

```bash
git tag -a 0.2.0 -m "0.2.0：<一句话摘要>"
git push origin master
git push origin 0.2.0        # tag 必须单独推，git push 默认不带
```

推送前确认三者一致：

```bash
python3 -c "
import json
m=json.load(open('manifest.json')); p=json.load(open('package.json')); v=json.load(open('versions.json'))
assert m['version']==p['version'], 'manifest 与 package 不同步'
assert v[m['version']]==m['minAppVersion'], 'versions.json 条目不对'
print('OK', m['version'])
"
```

## 7. 建 Release（用户真正拿到东西的一步）

```bash
gh release create 0.2.0 main.js manifest.json \
  --title "0.2.0" --notes-file /tmp/relnotes.md
```

必须用 `--title "0.2.0"`：**标题不带 `v` 前缀**，与 tag 一致（历史上如此，保持一致）。
资产只需 `main.js` 和 `manifest.json`（有 `styles.css` 时一并带上）。

## 8. 下载回验（不要跳过）

发布完把资产下载回来，确认用户拿到的就是你以为的东西：

```bash
gh release download 0.2.0 --pattern 'main.js' --pattern 'manifest.json' \
  --repo wozoulesky/dsh-obsidian --dir /tmp/relverify
cmp /tmp/relverify/main.js main.js && echo "字节一致"
python3 -c "import json;print(json.load(open('/tmp/relverify/manifest.json'))['version'])"
```

`gh release view` 确认状态：

```bash
gh release view 0.2.0 --json tagName,isDraft,isPrerelease,assets \
  -q '"draft=\(.isDraft) prerelease=\(.isPrerelease)", (.assets[] | .name)'
```

**草稿或预发布对市场不可见** —— `draft=true` 时用户什么都装不到。

## 9. 通知延迟

社区插件市场的索引刷新有延迟（通常数小时到一两天），不是发完立刻全量可见。
想马上验证或给别人试用：把 Release 里的 `main.js` + `manifest.json` 放进
vault 的 `.obsidian/plugins/dsh-bridge/`，再在 Obsidian 里启用。

## 坑（都是真踩过的）

**`.gitattributes` 钉死了 `main.js -text`**
不要删。仓库 `core.autocrlf=true`，无此声明时 Windows 上 `git checkout -- main.js`
会把产物转成 CRLF，破坏「仓库字节 == Release 资产」不变式，还会让 `git status`
把字节正确的产物误报为 modified。它声明「该文件不做任何行尾转换」。

**`main.js` 被 ignore 又被跟踪**
`git status` 里看不到它，`git add -A` 也不会带上。发版必须 `git add -f`。

**压缩后查不到内部符号**
判断产物是否含新代码，用 className（`dsh-msg-command`）、i18n key 等**字符串字面量**，
不要用函数名/常量名。

**CI 的「产物与仓库不一致」提示不阻断**
`.github/workflows/ci.yml` 里那步 `continue-on-error: true`，日常分支产物领先属预期。
所以**发版提交上这条提示必须是「一致」**；若仍提示不一致，说明第 5 步漏了。

**单测只覆盖到哪**
`chatView` 自身的 DOM 组装、流式缓存复用没有自动化测试（当前环境无 DOM 库，
未引入新依赖）。渲染**分类**已抽到 `nodeRender.ts` 并有覆盖，但那不等于整个视图被测试了。
涉及视图层的改动，发版前要真机点一遍。

## 发版检查清单

```
[ ] 版本号符合语义化（行为变更 → 次版本号）
[ ] npm run version <ver>（或手工改三个文件，含 versions.json）
[ ] minAppVersion 未无谓提高；若提高，降级路径已验证
[ ] npm run lint（0 warning）/ npm test / npm run build 全绿
[ ] 两次构建 cmp 字节一致
[ ] Release 说明是用户视角，且每条都核实有对应代码
[ ] git add -f main.js，并 git diff --cached --stat main.js 确认
[ ] 产物含新代码（用 className 等字面量验证）
[ ] 三处版本号一致；tag 附注信息已写
[ ] git push origin master 且 git push origin <tag>
[ ] gh release create 带 main.js + manifest.json，title 不带 v
[ ] gh release view 确认 draft=false prerelease=false
[ ] 下载回验 cmp 字节一致
```
