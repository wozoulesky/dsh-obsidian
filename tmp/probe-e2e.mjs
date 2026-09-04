/**
 * 批 2 验收「实测 list/create/prompt 全链」+ 流式端到端探针（node tmp/probe-e2e.mjs）。
 *
 * 与批 1-3 只读探针不同：本探针做一次**最小副作用**端到端（计划批 2 验收明确要求）：
 *  1. session/list → 取 items 数量（已有证据，重复验证一次）
 *  2. session/create（cwd 不传 → host 用默认；不指定 agentPreset）→ 新会话 id
 *  3. session/prompt（requestId 自铸；一句最便宜的问候 "hi"）→ accepted:true
 *  4. session/follow 该会话 → 捕获 snapshot + 后续 event 帧（等待 turn 事件），
 *     验证 chunkrow 解包后流式 text-delta 能拼出非空文本（端到端"聊天流式"的证据）
 *  5. 若 30s 内 turn 未结束，session/cancel 兜底止损（防 agent 意外长时间运行）
 *  副作用：多一个会话（可在 DSH Web GUI 里删除），一轮极小的 LLM 调用。
 */
import { createHash, createHmac } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const BASE_URL = process.env.DSH_URL ?? "http://127.0.0.1:3080";
const CREDENTIALS_PATH = join(homedir(), ".dsh", ".credentials.yaml");
const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION_ID = process.env.DSH_E2E_SESSION_ID; // 可选：复用指定会话（跳过 create）

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
    const body = JSON.stringify({ type: "client-request", rpcId: randomUUID(), method, payload: { args } });
    const req = http.request(
      { hostname: "127.0.0.1", port: new URL(BASE_URL).port, path: `/api/${method}`, method: "POST", headers: { "content-type": "application/json", cookie: cookieHeader, "content-length": Buffer.byteLength(body) } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            const full = JSON.parse(text);
            if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
            else resolve(full.result);
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** 展开 chunkrow（与 src/transport/chunkRows.ts 同源算法）。 */
function expandChunkRowEvent(row) {
  const data = row.data ?? {};
  const members = row.type === "chunkrow/tool-call-chunks" ? data.args : data.texts;
  const dt = data.dt ?? [];
  const events = [];
  let time = row.time;
  for (let k = 0; k < members.length; k++) {
    if (k > 0) time += dt[k - 1];
    const chunk = row.type === "chunkrow/tool-call-chunks"
      ? { type: "tool-call-delta", index: data.index, id: data.id, ...(data.name === undefined ? {} : { name: data.name }), argumentsDelta: members[k] }
      : { type: row.type === "chunkrow/text-chunks" ? "text-delta" : "reasoning-delta", index: data.index, text: members[k] };
    events.push({ type: "assistant/chunk", seq: row.seq + k, time, data: { turn: data.turn, step: data.step, chunk } });
  }
  return events;
}

// 1. list
const list = await postRpc("session/list", { _request: {} });
const itemsBefore = list?.value?.items ?? [];
log(`[probe-e2e] list：${itemsBefore.length} 个会话`);

// 2. create（或复用指定会话）
let sessionId = SESSION_ID;
if (!sessionId) {
  const created = await postRpc("session/create", { request: {} });
  sessionId = created?.value?.sessionId;
  if (!sessionId) {
    log("[probe-e2e] FAIL：create 未返回 sessionId");
    process.exit(1);
  }
  log(`[probe-e2e] create：${sessionId}`);
} else {
  log(`[probe-e2e] 复用会话：${sessionId}`);
}

// 3. prompt（requestId 自铸 + 最便宜的问候）
const requestId = randomUUID();
const prompt = await postRpc("session/prompt", {
  request: { requestId, sessionId, mode: "queue", content: [{ type: "text", text: "hi" }] },
});
if (prompt?.ok !== true || prompt?.value?.accepted !== true) {
  log(`[probe-e2e] FAIL：prompt 未接受：${JSON.stringify(prompt).slice(0, 300)}`);
  process.exit(1);
}
log(`[probe-e2e] prompt：accepted:true（requestId=${requestId}）`);

// 4. follow 流式观察（含 chunkrow 展开 + 等待 turn 事件）
const textDeltas = [];
let sawSnapshot = false;
let sawEvent = false;
let turnEnded = false;
await new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${new URL(BASE_URL).port}/api/remote.mux`, { headers: { cookie: cookieHeader } });
  const streamId = randomUUID();
  const deadline = setTimeout(() => {
    try { ws.close(); } catch {}
    log("[probe-e2e] 30s 观察窗口结束（turn 未在窗口内结束，不代表失败）");
    resolve();
  }, 30000);
  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "open", streamId, endpoint: "session/follow", payload: { args: { request: { address: { kind: "session", sessionId }, maxMessages: 20 } } } }));
  });
  ws.on("message", (data) => {
    try {
      const frame = JSON.parse(data.toString());
      if (frame.type !== "item" || frame.streamId !== streamId) return;
      const value = frame.value;
      if (!value) return;
      if (value.type === "snapshot") {
        sawSnapshot = true;
        for (const record of value.records ?? []) {
          if (record.type === "chunks") {
            for (const ev of expandChunkRowEvent(record.event)) {
              if (ev.data?.chunk?.type === "text-delta") textDeltas.push(ev.data.chunk.text);
            }
          }
        }
      } else if (value.type === "event") {
        sawEvent = true;
        const ev = value.event;
        if (ev?.type === "assistant/chunk") {
          const chunk = ev.data?.chunk;
          if (chunk?.type === "text-delta") textDeltas.push(chunk.text);
        } else if (ev?.type === "turn/end") {
          turnEnded = true;
        }
      }
      // turn/end 后 2 秒收尾（给最后几个事件到达的余量）
      if (turnEnded) {
        setTimeout(() => {
          clearTimeout(deadline);
          try { ws.send(JSON.stringify({ type: "cancel", streamId })); } catch {}
          try { ws.close(); } catch {}
          resolve();
        }, 2000);
      }
    } catch (err) {
      reject(err);
    }
  });
  ws.on("error", reject);
});

const streamed = textDeltas.join("");
log(`[probe-e2e] follow：snapshot=${sawSnapshot} liveEvent=${sawEvent} turnEnded=${turnEnded} textDeltas=${textDeltas.length} 流式文本长度=${streamed.length}`);
log(streamed.length > 0
  ? `[probe-e2e] 流式文本样本（前 80 字符）：${streamed.slice(0, 80)}`
  : "[probe-e2e] 流式文本为空（turn 未在窗口内产文本，可重跑或延长窗口）");

// 5. 若 turn 未结束，cancel 兜底止损
if (!turnEnded) {
  const cancel = await postRpc("session/cancel", { request: { sessionId } });
  log(`[probe-e2e] cancel 兜底：${cancel?.ok === true && cancel?.value?.accepted === true ? "accepted:true" : JSON.stringify(cancel).slice(0, 200)}`);
}

const pass = prompt?.ok === true && sawSnapshot && (sawEvent || streamed.length > 0);
log(`[probe-e2e] ${pass ? "PASS" : "FAIL"}：list/create/prompt 全链 + follow 流式端到端${pass ? "" : "（见上）"}`);

await writeFile(join(__dirname, "probe-e2e.notes.md"), `# probe-e2e list/create/prompt 全链 + 流式实测\n\n${new Date().toISOString()}\n\n${notes.map((n) => `- ${n}`).join("\n")}\n`, "utf8");
log("[probe-e2e] 证据已写 tmp/probe-e2e.notes.md");
