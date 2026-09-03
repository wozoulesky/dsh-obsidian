/**
 * 批 2 RPC 层真机实测探针（Node 直接跑：node tmp/probe-rpc.mjs）。
 * 只做只读操作：session/list + session/page（不 create/prompt/cancel——那会真的启动 agent）。
 * 验证内容：
 * 1. 新契约端点 POST /api/session/list + {args:{_request:{}}} → 200 与 items 形状。
 * 2. POST /api/session/page（throughSeq:-1）→ 捕获 records 中的 chunkrow（type:"chunks"）线上样本，
 *    用于锁定 ChunkRowEvent 的字段名（seq0/time0 vs seq/time）。
 * 3. 证据写入 tmp/probe-rpc.notes.md。
 * 签名算法与 src/transport/auth.ts 同源（独立实现，复用批 1 probe-auth.mjs 的写法）。
 */
import { createHash, createHmac } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const BASE_URL = process.env.DSH_URL ?? "http://127.0.0.1:3080";
const CREDENTIALS_PATH = join(homedir(), ".dsh", ".credentials.yaml");
const __dirname = dirname(fileURLToPath(import.meta.url));

const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const authorityOf = (baseUrl) => new URL(baseUrl).host;
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

const yamlText = await readFile(CREDENTIALS_PATH, "utf8");
const secret = extractSecretFromYaml(yamlText);
const issuedAt = Date.now();
const cookieHeader = `${cookieName(authorityOf(BASE_URL))}=${signCookie(
  { version: 1, authority: authorityOf(BASE_URL), issuedAt, expiresAt: issuedAt + 12 * 60 * 60 * 1000 },
  secret
)}`;

function postRpc(method, args) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${BASE_URL}/api/${method}`);
    const envelope = { type: "client-request", rpcId: randomUUID(), method, payload: { args } };
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
}

// ---- 1. session/list ----
const listRes = await postRpc("session/list", { _request: {} });
let items = null;
let listErr = null;
try {
  const parsed = JSON.parse(listRes.body);
  if (parsed?.result?.ok) items = parsed.result.value.items;
  else listErr = parsed?.result?.error;
} catch {
  listErr = { code: "parse", message: listRes.body.slice(0, 120) };
}
log(`[1] POST /api/session/list → HTTP ${listRes.status}；items=${items ? items.length : "无"}${listErr ? `；错误=${JSON.stringify(listErr).slice(0, 160)}` : ""}`);
if (items && items.length > 0) {
  const s0 = items[0];
  log(`[1] 首项字段：${JSON.stringify(Object.keys(s0))}`);
  log(`[1] 首项 projections 键：${s0.projections ? JSON.stringify(Object.keys(s0.projections.values)) : "无"}`);
}

// ---- 2. WS remote.mux：session/follow 抓 snapshot（records 含 chunkrow 样本 + cursor）----
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { WebSocket } = require("ws");

let snapshotSample = null;
let followStatus = "无 follow 调用";
const regular = (items ?? []).filter((s) => s.origin !== "subagent" && s.blank === false);
if (regular.length > 0) {
  const target = regular.find((s) => s.running === true) ?? regular[0];
  const streamId = randomUUID();
  const snapshot = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE_URL.replace(/^http/u, "ws")}/api/remote.mux`, {
      headers: { cookie: cookieHeader },
    });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("WS 超时：30s 内未收到 snapshot"));
    }, 30000);
    let sawItem = false;
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "open",
          streamId,
          endpoint: "session/follow",
          payload: { args: { request: { address: { kind: "session", sessionId: target.sessionId }, maxMessages: 50 } } },
        })
      );
    });
    ws.on("message", (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (frame?.type === "item" && frame?.streamId === streamId && !sawItem) {
        sawItem = true;
        clearTimeout(timer);
        ws.close();
        resolve(frame.value);
      } else if (frame?.type === "error" && frame?.streamId === streamId) {
        clearTimeout(timer);
        ws.terminate();
        resolve({ __error: frame.error });
      }
    });
    ws.on("unexpected-response", (req, res) => {
      clearTimeout(timer);
      reject(new Error(`WS 握手失败：HTTP ${res.statusCode}`));
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  if (snapshot?.__error) {
    followStatus = `错误：${JSON.stringify(snapshot.__error).slice(0, 160)}`;
  } else if (snapshot?.type === "snapshot") {
    const recs = snapshot.records ?? [];
    followStatus = `snapshot（cursor=${snapshot.cursor}，records=${recs.length}，hasMore=${snapshot.hasMore}）`;
    snapshotSample = snapshot;
    log(`[2] ${target.sessionId} follow snapshot：cursor=${snapshot.cursor}，records=${recs.length}`);
    const chunkRec = recs.find((r) => r?.type === "chunks");
    if (chunkRec) {
      const ev = chunkRec.event;
      log(`[2] chunks 记录线上样本：${JSON.stringify(chunkRec).slice(0, 600)}`);
      log(`[2] event.type=${ev.type}；字段=${JSON.stringify(Object.keys(ev))}；data 字段=${JSON.stringify(Object.keys(ev.data ?? {}))}`);
      log(`[2] seq 字段存在=${Object.hasOwn(ev, "seq")}；seq0 字段存在=${Object.hasOwn(ev, "seq0")}`);
    } else {
      log(`[2] 该 snapshot 无 chunks 记录（records 类型：${[...new Set(recs.map((r) => r?.type))].join(",")}）`);
    }
  } else {
    followStatus = `非 snapshot 首帧：${JSON.stringify(snapshot).slice(0, 160)}`;
  }
}
log(`[2] WS session/follow → ${followStatus}`);

// ---- 3. session/page with 真实 cursor（follow snapshot 给的 cursor）----
let pageStatus2 = "无 page（无 cursor）";
let chunkSample = null;
if (snapshotSample?.type === "snapshot" && typeof snapshotSample.cursor === "number") {
  const sid = snapshotSample.header?.id ?? regular[0]?.sessionId;
  const res = await postRpc("session/page", {
    request: { address: { kind: "session", sessionId: sid }, throughSeq: snapshotSample.cursor, maxMessages: 50 },
  });
  let parsed = null;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    /* skip */
  }
  if (res.status === 200 && parsed?.result?.ok) {
    const records = parsed.result.value.records ?? [];
    pageStatus2 = `HTTP 200；${sid} throughSeq=${snapshotSample.cursor} → ${records.length} 条记录（hasMore=${parsed.result.value.hasMore}）`;
    const chunkRec = records.find((r) => r?.type === "chunks");
    if (chunkRec) chunkSample = chunkRec;
  } else {
    pageStatus2 = `HTTP ${res.status}；错误=${JSON.stringify(parsed?.result?.error ?? res.body).slice(0, 160)}`;
  }
}
log(`[3] POST /api/session/page(真实 cursor) → ${pageStatus2}`);
if (chunkSample) {
  const ev = chunkSample.event;
  log(`[3] chunks 记录线上样本：${JSON.stringify(chunkSample).slice(0, 600)}`);
  log(`[3] event.type=${ev.type}；字段=${JSON.stringify(Object.keys(ev))}；data 字段=${JSON.stringify(Object.keys(ev.data ?? {}))}`);
  log(`[3] seq 字段存在=${Object.hasOwn(ev, "seq")}；seq0 字段存在=${Object.hasOwn(ev, "seq0")}`);
}

const notesText = [
  `# 批 2 RPC 层真机实测证据`,
  ``,
  `- 时间：${new Date().toISOString()}`,
  `- 目标：${BASE_URL}（本机 DSH 0.1.2-rc.1，dsh web）`,
  ``,
  `## 结论`,
  ``,
  `- session/list：HTTP ${listRes.status}，items=${items ? items.length : "无"}${listErr ? `，错误 ${JSON.stringify(listErr).slice(0, 160)}` : ""}`,
  `- session/follow（WS remote.mux）：${followStatus}`,
  `- session/page（真实 cursor）：${pageStatus2}`,
  chunkSample ? `- chunkrow 线上样本：${"```json\n" + JSON.stringify(chunkSample).slice(0, 1000) + "\n```"}` : `- chunkrow 样本：未捕获（chunkSample=null）`,
  ``,
  `## 备注`,
  ``,
  `- 本探针只做只读调用（list/page），不 create/prompt/cancel，避免真机启动 agent。`,
  `- 信封：{"type":"client-request","rpcId":"<uuid>","method":"<ns>/<method>","payload":{"args":{...}}}`,
].join("\n");
await writeFile(join(__dirname, "probe-rpc.notes.md"), notesText, "utf8");
log(`[3] 证据已写入 tmp/probe-rpc.notes.md`);
