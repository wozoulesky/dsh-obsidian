/**
 * 批 3 事件流层真机实测探针（Node 直接跑：node tmp/probe-stream.mjs）。
 * 只做只读操作：session/list + remote.mux 三流（session/follow、session/control、$events）
 * + 一个不存在的会话 follow（验证 session/not-found error 帧）。
 * 不 create/prompt/cancel——那会真的启动 agent。
 * 验证内容：
 * 1. WS /api/remote.mux 握手（Cookie header）+ open/cancel/item/end/error 帧协议。
 * 2. session/follow → snapshot 帧样本（header/cursor/records 结构）+ 后续 event 帧（若有自然事件）。
 * 3. session/control → baseline 帧样本（queues/jobs/projections 结构）。
 * 4. $events → ready 帧（记 clientId）；waterfall/emit 帧样本（无自然事件时至少 ready 帧必须有）。
 * 5. chunkrow 解包：从 follow snapshot 的 records 找 {type:"chunks"} 记录，用与
 *    src/transport/chunkRows.ts 相同的算法展开，对比字段（seq/time/dt 前缀和、chunk 形状）。
 * 证据写入 tmp/probe-stream.notes.md。
 * 签名算法与 src/transport/auth.ts 同源（复用批 1/批 2 probe 写法）。
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

/** 与 src/transport/chunkRows.ts 同源的解包算法（独立副本，probe 不可 import TS）。 */
function expandChunkRowEvent(row) {
  const data = row.data ?? {};
  const members = row.type === "chunkrow/tool-call-chunks" ? data.args : data.texts;
  if (!Array.isArray(members) || members.length === 0) throw new Error("members 非法");
  const dt = data.dt ?? [];
  const events = [];
  let time = row.time;
  for (let k = 0; k < members.length; k++) {
    if (k > 0) time += dt[k - 1];
    let chunk;
    if (row.type === "chunkrow/tool-call-chunks") {
      chunk = { type: "tool-call-delta", index: data.index, id: data.id, ...(data.name === undefined ? {} : { name: data.name }), argumentsDelta: members[k] };
    } else {
      chunk = { type: row.type === "chunkrow/text-chunks" ? "text-delta" : "reasoning-delta", index: data.index, text: members[k] };
    }
    events.push({ type: "assistant/chunk", seq: row.seq + k, time, data: { turn: data.turn, step: data.step, chunk } });
  }
  return events;
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

// ---- WS 工具：开一条物理连接，跑一个或多个逻辑流 ----
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { WebSocket } = require("ws");

/** 打开一条物理 WS，等待 open 事件。 */
function connectMux() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE_URL.replace(/^http/u, "ws")}/api/remote.mux`, {
      headers: { cookie: cookieHeader },
      handshakeTimeout: 5000,
    });
    ws.on("open", () => resolve(ws));
    ws.on("unexpected-response", (req, res) => reject(new Error(`WS 握手失败：HTTP ${res.statusCode}`)));
    ws.on("error", (err) => reject(err));
  });
}

/**
 * 在一个物理连接上开逻辑流：收集该 streamId 的 item 值。
 * - maxFrames：收满即止（发 cancel）
 * - graceMs：收到首帧后最多再等 graceMs 毫秒收集后续帧（自然事件观察窗），超时即结算
 * - 任何帧都没等到则 30s 超时 reject
 * 返回 {frames, streamId, error?}。
 */
function openStream(ws, endpoint, payload, { maxFrames = 1, graceMs = 0, onFrame } = {}) {
  const streamId = randomUUID();
  const frames = [];
  return new Promise((resolve, reject) => {
    let graceTimer = null;
    const settle = () => {
      clearTimeout(deadline);
      if (graceTimer) clearTimeout(graceTimer);
      ws.removeListener("message", onMessage);
      ws.send(JSON.stringify({ type: "cancel", streamId }));
      resolve({ frames, streamId });
    };
    const deadline = setTimeout(() => {
      clearTimeout(graceTimer);
      ws.removeListener("message", onMessage);
      reject(new Error(`流 ${endpoint} 超时（30s 无任何帧）`));
    }, 30000);
    const onMessage = (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (frame?.streamId !== streamId) return;
      if (frame.type === "item") {
        frames.push(frame.value);
        onFrame?.(frame.value);
        if (graceMs > 0 && frames.length === 1) {
          graceTimer = setTimeout(settle, graceMs);
        } else if (frames.length >= maxFrames) {
          settle();
        }
      } else if (frame.type === "end") {
        clearTimeout(deadline);
        if (graceTimer) clearTimeout(graceTimer);
        ws.removeListener("message", onMessage);
        resolve({ frames, streamId });
      } else if (frame.type === "error") {
        clearTimeout(deadline);
        if (graceTimer) clearTimeout(graceTimer);
        ws.removeListener("message", onMessage);
        resolve({ frames, streamId, error: frame.error });
      }
    };
    ws.on("message", onMessage);
    ws.send(JSON.stringify({ type: "open", streamId, endpoint, payload }));
  });
}

// ---- 1. session/list ----
const listRes = await postRpc("session/list", { _request: {} });
let items = null;
try {
  const parsed = JSON.parse(listRes.body);
  if (parsed?.result?.ok) items = parsed.result.value.items;
} catch {
  /* skip */
}
log(`[1] POST /api/session/list → HTTP ${listRes.status}；items=${items ? items.length : "无"}`);
if (!items || items.length === 0) {
  log("[1] 无会话可探测，终止");
  process.exit(0);
}

// ---- 2. session/follow：snapshot + 首个后续帧（等 3s 自然事件，可能没有）----
const regular = items.filter((s) => s.origin !== "subagent" && s.blank === false);
const target = regular.length > 0 ? (regular.find((s) => s.running === true) ?? regular[0]) : items[0];
const ws1 = await connectMux();
log(`[2] WS /api/remote.mux 已连接（握手 Cookie: ${cookieHeader.slice(0, 32)}…）`);

const follow = await openStream(
  ws1,
  "session/follow",
  { args: { request: { address: { kind: "session", sessionId: target.sessionId }, maxMessages: 50 } } },
  { maxFrames: 3, graceMs: 3000 }
);
if (follow.error) {
  log(`[2] session/follow → error 帧：${JSON.stringify(follow.error).slice(0, 200)}`);
} else {
  const snap = follow.frames[0];
  if (snap?.type === "snapshot") {
    const recs = snap.records ?? [];
    const recTypes = [...new Set(recs.map((r) => r?.type))];
    log(`[2] session/follow（${target.sessionId}）首帧 snapshot：cursor=${snap.cursor}，records=${recs.length}，hasMore=${snap.hasMore}`);
    log(`[2] snapshot.header 字段：${JSON.stringify(Object.keys(snap.header ?? {}))}`);
    log(`[2] snapshot.records 类型：${recTypes.join(",")}；projections 键：${JSON.stringify(Object.keys(snap.projections?.values ?? {}))}`);
    if (follow.frames.length > 1) {
      log(`[2] 后续 event 帧样本：${JSON.stringify(follow.frames[1]).slice(0, 300)}`);
    } else {
      log(`[2] 3s 内无自然事件帧（可接受：本探针不发送消息）`);
    }
    // ---- 5. chunkrow 解包验证 ----
    const chunkRec = recs.find((r) => r?.type === "chunks");
    if (chunkRec) {
      const ev = chunkRec.event;
      const expanded = expandChunkRowEvent(ev);
      log(`[5] chunks 记录（${ev.type}）：seq=${ev.seq}，time=${ev.time}，成员数=${expanded.length}`);
      log(`[5] 展开首条：${JSON.stringify(expanded[0]).slice(0, 400)}`);
      // 校验 seq/time 前缀和：重新计算并断言一致
      let t = ev.time;
      let ok = true;
      for (let k = 0; k < expanded.length; k++) {
        if (k > 0) t += ev.data.dt[k - 1];
        if (expanded[k].seq !== ev.seq + k || expanded[k].time !== t) ok = false;
      }
      log(`[5] seq+k / time+Σdt 前缀和校验：${ok ? "PASS" : "FAIL"}（dt 含负数=${(ev.data.dt ?? []).some((d) => d < 0)}）`);
      log(`[5] 展开 chunk 类型：${[...new Set(expanded.map((e) => e.data.chunk.type))].join(",")}`);
    } else {
      log(`[5] 该 snapshot 无 chunks 记录（类型集合：${recTypes.join(",")}）——换 page RPC 兜底抓样本`);
      const pageRes = await postRpc("session/page", {
        request: { address: { kind: "session", sessionId: target.sessionId }, throughSeq: snap.cursor, maxMessages: 100 },
      });
      try {
        const parsed = JSON.parse(pageRes.body);
        const pageChunk = (parsed?.result?.value?.records ?? []).find((r) => r?.type === "chunks");
        if (pageChunk) {
          const expanded = expandChunkRowEvent(pageChunk.event);
          log(`[5] page 兜底 chunks（${pageChunk.event.type}）：成员数=${expanded.length}；首条=${JSON.stringify(expanded[0]).slice(0, 300)}`);
        } else {
          log(`[5] page 兜底也无 chunks 记录（只读会话可能无 assistant 输出流）`);
        }
      } catch {
        log(`[5] page 兜底失败`);
      }
    }
  } else {
    log(`[2] 首帧非 snapshot：${JSON.stringify(snap).slice(0, 200)}`);
  }
}

// ---- 2b. 不存在会话 → 验证 error 帧（session/not-found）----
const missing = await openStream(
  ws1,
  "session/follow",
  { args: { request: { address: { kind: "session", sessionId: "definitely-not-a-session" } } } },
  {}
);
log(`[2b] 不存在会话 follow → ${missing.error ? `error 帧 ${JSON.stringify(missing.error).slice(0, 160)}` : `非 error（frames=${missing.frames.length}）`}`);

// ---- 3. session/control → baseline 帧 ----
const control = await openStream(ws1, "session/control", { args: {} }, { maxFrames: 1 });
if (control.error) {
  log(`[3] session/control → error 帧：${JSON.stringify(control.error).slice(0, 200)}`);
} else {
  const base = control.frames[0];
  log(`[3] session/control 首帧：type=${base?.type}`);
  if (base?.type === "baseline") {
    const v = base.value ?? {};
    log(`[3] baseline.queues 会话数=${Object.keys(v.queues ?? {}).length}；jobs=${Object.keys(v.jobs ?? {}).length}；projections=${Object.keys(v.projections ?? {}).length}`);
    const qSample = Object.values(v.queues ?? {})[0];
    log(`[3] 队列项样本（首个会话队列）：${JSON.stringify(qSample).slice(0, 200)}`);
  } else {
    log(`[3] 首帧非 baseline：${JSON.stringify(base).slice(0, 200)}`);
  }
}

// ---- 4. $events → ready 帧（必须）+ 3s 观察窗看有无 waterfall/emit ----
const events = await openStream(ws1, "$events", { args: {} }, { maxFrames: 3, graceMs: 3000 });
if (events.error) {
  log(`[4] $events → error 帧：${JSON.stringify(events.error).slice(0, 200)}`);
} else {
  const ready = events.frames[0];
  if (ready?.type === "ready") {
    log(`[4] $events ready 帧：clientId=${ready.clientId}；host.home=${ready.host?.home}`);
    if (events.frames.length > 1) {
      log(`[4] 后续帧样本：${JSON.stringify(events.frames[1]).slice(0, 400)}`);
    } else {
      log(`[4] 3s 内无 waterfall/emit 帧（本探针不触发审批/提问/会话活动，可接受）`);
    }
  } else {
    log(`[4] $events 首帧非 ready：${JSON.stringify(ready).slice(0, 300)}`);
  }
}

// ---- 收尾：cancel 全部流 + 关闭物理连接 ----
ws1.close();
log(`[6] 物理连接已关闭（cancel 帧随流终止发送，见上方逐流 cancel）`);

const notesText = [
  `# 批 3 事件流层真机实测证据`,
  ``,
  `- 时间：${new Date().toISOString()}`,
  `- 目标：${BASE_URL}（本机 DSH 0.1.2-rc.1，dsh web）`,
  `- 探针：tmp/probe-stream.mjs（只读：list + remote.mux 三流 + 不存在会话 error 帧探测；未 create/prompt/cancel）`,
  ``,
  `## 结论`,
  ``,
  ...notes.map((n) => `- ${n}`),
  ``,
  `## 备注`,
  ``,
  `- remote.mux 帧协议：open/cancel（客户端）；item/end/error（服务端）。`,
  `- $events 的 open payload 必须为 {args:{}}（网关精确校验空 args）。`,
  `- follow snapshot 是批 4 首屏播种入口；cursor 用于翻页（throughSeq）。`,
].join("\n");
await writeFile(join(__dirname, "probe-stream.notes.md"), notesText, "utf8");
log(`证据已写入 tmp/probe-stream.notes.md`);
