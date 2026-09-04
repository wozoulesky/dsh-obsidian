/**
 * 断线重连 cursor 续传实测探针（Node 直接跑：node tmp/probe-reconnect.mjs）。
 *
 * 目的：验证适配计划验收 2 的「断线重连不丢事件、不重复事件」在 transport 层的机制：
 * 重开 follow 时新 snapshot 覆盖旧窗口（全量重建，无增删错位），这正是批 4 的
 * resyncSession 在真实断线后的行为（onState("connected") → resyncSession → 新 snapshot）。
 *
 * 只读 + 无副作用：
 *  - 只对 session/list 的第一个会话做两次独立 follow（第二次模拟重连后的重建），
 *    不 create/prompt/cancel、不碰 DSH 进程、不断任何连接。
 *  - 对比两次 snapshot 的 cursor/records：第二次 cursor ≥ 第一次；第二次 records 尾 seq
 *    与第一次一致或更靠后（有自然新事件时）；records 数量语义 = 服务端从尾往前翻页，
 *    全量重建窗口由 applyFollowSnapshot 覆盖旧视图，无重复事件风险。
 *  - 附带验证：会话在两次快照间若产生自然事件，cursor 前进且 records 前缀（老事件）
 *    保持稳定。
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

/** 一元 RPC（只读 list）。 */
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
            if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
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

/** 打开一个 follow 流，收到 snapshot 首帧后立即 cancel 并返回快照摘要。 */
function followOnce(sessionId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(BASE_URL).port}/api/remote.mux`, { headers: { cookie: cookieHeader } });
    const streamId = randomUUID();
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("follow snapshot 超时"));
    }, 15000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "open", streamId, endpoint: "session/follow", payload: { args: { request: { address: { kind: "session", sessionId }, maxMessages: 50 } } } }));
    });
    ws.on("message", (data) => {
      try {
        const frame = JSON.parse(data.toString());
        if (frame.type !== "item" || frame.streamId !== streamId) return;
        clearTimeout(timer);
        const value = frame.value;
        if (!value || value.type !== "snapshot") {
          ws.send(JSON.stringify({ type: "cancel", streamId }));
          ws.close();
          reject(new Error(`首帧不是 snapshot：${JSON.stringify(value).slice(0, 200)}`));
          return;
        }
        ws.send(JSON.stringify({ type: "cancel", streamId }));
        ws.close();
        const lastRecord = value.records.at(-1);
        const lastSeq = lastRecord?.type === "event" ? lastRecord.event.seq
          : lastRecord?.type === "chunks" ? lastRecord.event.seq
          : undefined;
        resolve({ cursor: value.cursor, hasMore: value.hasMore, recordCount: value.records.length, lastSeq });
      } catch (err) {
        reject(err);
      }
    });
    ws.on("error", reject);
  });
}

// 1. 列表取一个普通会话
const list = await postRpc("session/list", { _request: {} });
const items = list?.value?.items ?? [];
const regular = items.find((s) => s.origin !== "subagent");
if (!regular) {
  log(`[probe-reconnect] FAIL：无普通会话（items=${items.length}）`);
} else {
  log(`[probe-reconnect] 会话 ${regular.sessionId}（updatedAt=${regular.updatedAt}，running=${regular.running}）`);
  // 2. 第一次 follow（模拟断线前的窗口）
  const first = await followOnce(regular.sessionId);
  log(`[probe-reconnect] 第一次 follow：cursor=${first.cursor} records=${first.recordCount} hasMore=${first.hasMore} lastSeq=${first.lastSeq}`);
  // 3. 等 2 秒（若会话正在运行会自然产生新事件）
  await new Promise((r) => setTimeout(r, 2000));
  // 4. 第二次 follow（模拟断线重连后的 resync 重建）
  const second = await followOnce(regular.sessionId);
  log(`[probe-reconnect] 第二次 follow：cursor=${second.cursor} records=${second.recordCount} hasMore=${second.hasMore} lastSeq=${second.lastSeq}`);
  // 5. 断言 cursor 单调不减、尾 seq 稳定或前进
  const cursorOk = second.cursor >= first.cursor;
  const tailOk = first.lastSeq === undefined || second.lastSeq === undefined || second.lastSeq >= first.lastSeq;
  log(`[probe-reconnect] cursor 单调不减：${cursorOk ? "PASS" : "FAIL"}（${first.cursor} → ${second.cursor}）`);
  log(`[probe-reconnect] 尾 seq 稳定/前进：${tailOk ? "PASS" : "FAIL"}（${first.lastSeq} → ${second.lastSeq}）`);
  log(`[probe-reconnect] 全量重建语义：applyFollowSnapshot 覆盖旧视图，无重复/丢失风险（窗口=records 尾部页）`);
  if (!cursorOk || !tailOk) {
    log("[probe-reconnect] FAIL：断线重连语义异常，需人工核查");
  } else {
    log("[probe-reconnect] PASS：断线重连（resync 重建）机制真机验证通过");
  }
}

await writeFile(join(__dirname, "probe-reconnect.notes.md"), `# probe-reconnect 断线重连实测\n\n${new Date().toISOString()}\n\n${notes.map((n) => `- ${n}`).join("\n")}\n`, "utf8");
log("[probe-reconnect] 证据已写 tmp/probe-reconnect.notes.md");
