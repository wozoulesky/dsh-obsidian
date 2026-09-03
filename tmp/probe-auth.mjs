/**
 * 批 1 认证层真机实测探针（Node 直接跑：node tmp/probe-auth.mjs）。
 *
 * 验证内容：
 * 1. 读真实 %USERPROFILE%/.dsh/.credentials.yaml，用与 src/transport/auth.ts 相同的算法签 cookie
 *    （算法在此独立实现，与 src/transport/auth.ts 同源：v1.<b64url(json)>.<b64url(hmac)>）。
 * 2. POST http://127.0.0.1:3080/api/session/list 带 Cookie → 期望 200 且响应含 "items"。
 * 3. WS ws://127.0.0.1:3080/api/remote.mux 握手带 Cookie → 期望 open（101）；
 *    发 {type:"open",streamId,endpoint:"session/control",payload:{args:{}}} → 期望收到 {type:"item",...} 帧。
 * 4. 证据（状态码/响应摘要/WS 握手结果/首帧样本）写入 tmp/probe-auth.notes.md。
 */
import { createHash, createHmac } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const { WebSocket } = require("ws");

const BASE_URL = process.env.DSH_URL ?? "http://127.0.0.1:3080";
const CREDENTIALS_PATH = join(process.env.USERPROFILE ?? "", ".dsh", ".credentials.yaml");
const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- 与 src/transport/auth.ts 相同的算法 ----
const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const authorityOf = (baseUrl) => {
  const u = new URL(baseUrl);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`baseUrl 必须是 http/https：${baseUrl}`);
  return u.host;
};
const cookieName = (authority) => "dsh-auth-" + b64url(createHash("sha256").update(authority).digest());
const signCookie = (payload, secret) => {
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `v1.${body}.${b64url(createHmac("sha256", secret).update(body).digest())}`;
};
function extractSecretFromYaml(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const recordIndex = lines.findIndex((line) => line.trim() === "client-connection/browser-session:");
  if (recordIndex === -1) throw new Error("凭据文件没有 client-connection/browser-session 记录");
  const recordIndent = lines[recordIndex].length - lines[recordIndex].trimStart().length;
  const stopAt = lines.findIndex(
    (line, i) => i > recordIndex && line.trim() !== "" && line.length - line.trimStart().length <= recordIndent
  );
  const end = stopAt === -1 ? lines.length : stopAt;
  for (let i = recordIndex + 1; i < end; i++) {
    const m = /^\s+secret:\s*/u.exec(lines[i]);
    if (m) {
      const raw = lines[i].trim().replace(/^secret:\s*/u, "").trim();
      const secret = /^(["'])(.*)\1$/u.test(raw) ? raw.replace(/^(["'])(.*)\1$/u, "$2") : raw;
      const decoded = Buffer.from(secret.replace(/-/g, "+").replace(/_/g, "/"), "base64");
      if (decoded.length !== 32) throw new Error(`secret 长度非法：${decoded.length}`);
      return decoded;
    }
  }
  throw new Error("凭据记录缺少 payload.secret");
}

const notes = [];
const log = (msg) => {
  notes.push(msg);
  console.log(msg);
};

// ---- 1. 读凭据 + 签 cookie ----
const authority = authorityOf(BASE_URL);
const yamlText = await readFile(CREDENTIALS_PATH, "utf8");
const secret = extractSecretFromYaml(yamlText);
const issuedAt = Date.now();
const cookieValue = signCookie(
  { version: 1, authority, issuedAt, expiresAt: issuedAt + 7 * 24 * 60 * 60 * 1000 },
  secret
);
const cookieHeader = `${cookieName(authority)}=${cookieValue}`;
log(`[1] authority=${authority} cookie 名=${cookieName(authority)}`);
log(`[1] cookie 值前缀=${cookieValue.slice(0, 20)}…（完整值不落盘）`);

// ---- 2. POST /api/session/list ----
const rpcId = randomUUID();
const envelope = {
  type: "client-request",
  rpcId,
  method: "session/list",
  payload: { args: { _request: {} } },
};
const httpResult = await new Promise((resolve, reject) => {
  const u = new URL(`${BASE_URL}/api/session/list`);
  const req = http.request(
    {
      hostname: u.hostname,
      port: u.port ? Number(u.port) : 80,
      path: u.pathname,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(JSON.stringify(envelope)),
        cookie: cookieHeader,
      },
    },
    (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    }
  );
  req.on("error", reject);
  req.write(JSON.stringify(envelope));
  req.end();
});

log(`[2] POST /api/session/list → HTTP ${httpResult.status}`);
let itemsSummary = "N/A";
try {
  const parsed = JSON.parse(httpResult.body);
  const value = parsed?.result?.value;
  itemsSummary = Array.isArray(value?.items) ? `${value.items.length} 个会话` : `无 items 数组（result=${JSON.stringify(parsed?.result)?.slice(0, 120)}）`;
} catch {
  itemsSummary = `非 JSON：${httpResult.body.slice(0, 120)}`;
}
log(`[2] 响应摘要：body 含 "items" = ${httpResult.body.includes('"items"')}；${itemsSummary}`);

// ---- 3. WS /api/remote.mux ----
const wsResult = await new Promise((resolve, reject) => {
  const ws = new WebSocket(`${BASE_URL.replace(/^http/u, "ws")}/api/remote.mux`, {
    headers: { cookie: cookieHeader },
  });
  const streamId = randomUUID();
  const timer = setTimeout(() => {
    ws.terminate();
    reject(new Error("WS 超时：30s 内未收到首帧"));
  }, 30000);
  let opened = false;
  let firstFrame = null;
  ws.on("open", () => {
    opened = true;
    log("[3] WS 握手成功（open 事件，101）");
    ws.send(JSON.stringify({ type: "open", streamId, endpoint: "session/control", payload: { args: {} } }));
  });
  ws.on("message", (data) => {
    if (firstFrame === null) {
      firstFrame = data.toString();
      log(`[3] 收到首帧：${firstFrame.slice(0, 300)}`);
      clearTimeout(timer);
      ws.close();
      resolve({ opened, firstFrame });
    }
  });
  ws.on("unexpected-response", (req, res) => reject(new Error(`WS 握手失败：HTTP ${res.statusCode}`)));
  ws.on("error", (err) => reject(err));
});

log(`[4] WS 握手结果：${wsResult.opened ? "open（101 通过）" : "失败"}`);
log(`[4] 首帧样本：${wsResult.firstFrame?.slice(0, 300) ?? "无"}`);

// ---- 写证据 ----
const notesText = [
  `# 批 1 认证层真机实测证据`,
  ``,
  `- 时间：${new Date().toISOString()}`,
  `- 目标：${BASE_URL}（本机 DSH 0.1.2-rc.1，dsh web）`,
  `- 凭据：${CREDENTIALS_PATH}（secret 未落盘）`,
  ``,
  `## 结论`,
  ``,
  `- HTTP：POST /api/session/list → **${httpResult.status}**，body 含 "items" = **${httpResult.body.includes('"items"')}**（${itemsSummary}）`,
  `- WS：/api/remote.mux 握手 → **${wsResult.opened ? "open（101）" : "失败"}**`,
  `- 首帧：${"```json\n" + (wsResult.firstFrame ?? "无").slice(0, 500) + "\n```"}`,
  ``,
  `## 请求细节`,
  ``,
  `- cookie 名：dsh-auth-b64url(sha256(authority))，authority=${authority}`,
  `- 信封：{"type":"client-request","rpcId":"<uuid>","method":"session/list","payload":{"args":{"_request":{}}}}`,
  `- WS open 帧：{"type":"open","streamId":"<uuid>","endpoint":"session/control","payload":{"args":{}}}`,
  ``,
].join("\n");
await writeFile(join(__dirname, "probe-auth.notes.md"), notesText, "utf8");
log(`[5] 证据已写入 tmp/probe-auth.notes.md`);
