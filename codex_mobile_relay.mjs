#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import tls from "node:tls";

const port = Number(readArg("--port") ?? process.env.PORT ?? 8791);
const targetOrigin = new URL(process.env.TARGET_ORIGIN ?? "https://chatgpt.com");
const logPath = process.env.LOG_FILE ?? defaultLogPath();
const remoteHostName = process.env.MOTEX_HOST_NAME ?? "main";
const chunkBytes = 96 * 1024;
const captureThreadList = process.env.MOTEX_CAPTURE_THREAD_LIST === "1";
const captureRemoteControl = process.env.MOTEX_CAPTURE_REMOTE_CONTROL === "1";
const captureDir = process.env.MOTEX_CAPTURE_DIR ?? defaultCaptureDir();
const probeActiveFirstThread = process.env.MOTEX_PROBE_ACTIVE_FIRST_THREAD === "1";
const probeThreadSource = process.env.MOTEX_PROBE_THREAD_SOURCE;
const probeSource = process.env.MOTEX_PROBE_SOURCE;
const probeThreadListFixture = process.env.MOTEX_PROBE_THREAD_LIST_FIXTURE;
const sessionIndexPath = process.env.MOTEX_SESSION_INDEX_PATH ?? defaultSessionIndexPath();

const chunkBuffers = new Map();
const captureChunkBuffers = new Map();
let captureCount = 0;
let nextConnectionId = 1;
let cachedThreadListFixture = null;
let cachedSessionIndexMtimeMs = -1;
let cachedThreadNames = new Map();

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function defaultLogPath() {
  return process.platform === "win32"
    ? `${process.env.TEMP ?? "."}\\codex-mobile-relay.log`
    : "/tmp/codex-mobile-relay.log";
}

function defaultCaptureDir() {
  return process.platform === "win32"
    ? `${process.env.TEMP ?? "."}\\motex-thread-list-captures`
    : "/tmp/motex-thread-list-captures";
}

function defaultSessionIndexPath() {
  const codexHome = process.env.CODEX_HOME;
  if (codexHome) return `${codexHome}/session_index.jsonl`;

  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return "session_index.jsonl";
  return process.platform === "win32"
    ? `${home}\\.codex\\session_index.jsonl`
    : `${home}/.codex/session_index.jsonl`;
}

function log(event) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  console.log(line);
  fs.appendFileSync(logPath, `${line}\n`);
}

function targetUrlFor(reqUrl) {
  const url = new URL(reqUrl, `${targetOrigin.origin}/`);
  return `${targetOrigin.origin}${url.pathname}${url.search}`;
}

function proxyHeaders(headers) {
  const blocked = new Set([
    "connection",
    "content-length",
    "host",
    "sec-websocket-extensions",
    "sec-websocket-key",
    "sec-websocket-version",
    "transfer-encoding",
    "upgrade",
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !blocked.has(name.toLowerCase())),
  );
}

function responseHeaders(headers) {
  const keep = ["content-type", "cache-control", "x-request-id", "x-oai-request-id"];
  return Object.fromEntries(keep.map((name) => [name, headers.get(name)]).filter(([, value]) => value));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function proxyHttp(req, res) {
  const targetUrl = targetUrlFor(req.url);
  const body = patchEnrollBody(req, await readRequestBody(req));

  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: proxyHeaders(req.headers),
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      redirect: "manual",
    });
    const responseBody = Buffer.from(await response.arrayBuffer());
    log({ kind: "http", method: req.method, path: req.url, status: response.status });
    res.writeHead(response.status, responseHeaders(response.headers));
    res.end(responseBody);
  } catch (error) {
    log({ kind: "http_error", method: req.method, path: req.url, error: String(error?.message ?? error) });
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`relay HTTP proxy failed: ${error?.message ?? error}\n`);
  }
}

function patchEnrollBody(req, body) {
  if (!remoteHostName) return body;

  const path = new URL(req.url, "http://127.0.0.1").pathname;
  if (req.method !== "POST" || path !== "/backend-api/wham/remote/control/server/enroll") {
    return body;
  }

  try {
    const payload = JSON.parse(body.toString("utf8"));
    if (!payload || typeof payload !== "object") return body;

    const previous = payload.name;
    payload.name = remoteHostName;
    log({ kind: "patched_enroll_name", from: previous ?? null, to: remoteHostName });
    return Buffer.from(JSON.stringify(payload), "utf8");
  } catch (error) {
    log({ kind: "patch_enroll_name_failed", error: String(error?.message ?? error) });
    return body;
  }
}

class WsFrameParser {
  constructor(onFrame) {
    this.buffer = Buffer.alloc(0);
    this.onFrame = onFrame;
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = takeFrame(this.buffer);
      if (!frame) return;
      this.buffer = this.buffer.subarray(frame.nextOffset);
      this.onFrame(frame);
    }
  }
}

function takeFrame(buffer) {
  if (buffer.length < 2) return null;

  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("websocket frame too large");
    }
    length = Number(bigLength);
    offset += 8;
  }

  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) return null;

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] ^= mask[i % 4];
    }
  }

  return { fin, opcode, payload, nextOffset: offset + length };
}

function encodeFrame(frame, maskPayload) {
  const payload = Buffer.from(frame.payload ?? Buffer.alloc(0));
  let headerLength = 2;
  if (payload.length >= 126 && payload.length <= 0xffff) headerLength += 2;
  if (payload.length > 0xffff) headerLength += 8;

  const out = Buffer.alloc(headerLength + (maskPayload ? 4 : 0) + payload.length);
  out[0] = (frame.fin === false ? 0 : 0x80) | frame.opcode;

  let offset = 2;
  if (payload.length < 126) {
    out[1] = (maskPayload ? 0x80 : 0) | payload.length;
  } else if (payload.length <= 0xffff) {
    out[1] = (maskPayload ? 0x80 : 0) | 126;
    out.writeUInt16BE(payload.length, offset);
    offset += 2;
  } else {
    out[1] = (maskPayload ? 0x80 : 0) | 127;
    out.writeBigUInt64BE(BigInt(payload.length), offset);
    offset += 8;
  }

  if (!maskPayload) {
    payload.copy(out, offset);
    return out;
  }

  const mask = crypto.randomBytes(4);
  mask.copy(out, offset);
  offset += 4;
  for (let i = 0; i < payload.length; i += 1) {
    out[offset + i] = payload[i] ^ mask[i % 4];
  }
  return out;
}

function websocketAcceptKey(secWebSocketKey) {
  return crypto
    .createHash("sha1")
    .update(`${secWebSocketKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function connectToChatGptWebsocket(req) {
  const targetUrl = new URL(targetUrlFor(req.url));
  const key = crypto.randomBytes(16).toString("base64");
  const headers = {
    Host: targetOrigin.host,
    Upgrade: "websocket",
    Connection: "Upgrade",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": key,
    ...proxyHeaders(req.headers),
  };
  patchRemoteHostHeaders(headers);

  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      Number(targetUrl.port || 443),
      targetUrl.hostname,
      { servername: targetUrl.hostname },
      () => {
        const request = [
          `GET ${targetUrl.pathname}${targetUrl.search} HTTP/1.1`,
          ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
          "",
          "",
        ].join("\r\n");
        socket.write(request);
      },
    );

    let handshake = Buffer.alloc(0);
    socket.on("data", function onData(chunk) {
      handshake = Buffer.concat([handshake, chunk]);
      const headerEnd = handshake.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      socket.off("data", onData);
      const headerText = handshake.subarray(0, headerEnd).toString("utf8");
      const statusLine = headerText.split("\r\n")[0] ?? "";
      if (!statusLine.includes(" 101 ")) {
        socket.destroy();
        reject(new Error(`remote websocket upgrade failed: ${statusLine}`));
        return;
      }

      const accept = headerText
        .split("\r\n")
        .find((line) => line.toLowerCase().startsWith("sec-websocket-accept:"))
        ?.split(":")
        .slice(1)
        .join(":")
        .trim();
      if (accept !== websocketAcceptKey(key)) {
        socket.destroy();
        reject(new Error("remote websocket accept key mismatch"));
        return;
      }

      resolve({ socket, head: handshake.subarray(headerEnd + 4) });
    });

    socket.on("error", reject);
  });
}

function patchRemoteHostHeaders(headers) {
  if (!remoteHostName) return;

  setHeader(
    headers,
    "x-codex-name",
    Buffer.from(remoteHostName, "utf8").toString("base64"),
  );
  log({ kind: "patched_websocket_host_name", to: remoteHostName });
}

function setHeader(headers, name, value) {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) {
      delete headers[key];
    }
  }
  headers[name] = value;
}

function isThreadListItem(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.id === "string" &&
    typeof value.cwd === "string" &&
    value.status &&
    typeof value.status === "object"
  );
}

function fallbackThreadName(thread) {
  const preview = String(thread.preview ?? "").trim();
  const previewLine = preview.split(/\r?\n/).find((line) => line.trim());
  if (previewLine) return previewLine.trim().slice(0, 120);

  const parts = String(thread.cwd ?? "").split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || "Codex thread";
}

function sessionIndexThreadName(threadId) {
  return sessionIndexThreadNames().get(threadId);
}

function sessionIndexThreadNames() {
  let stat;
  try {
    stat = fs.statSync(sessionIndexPath);
  } catch {
    cachedSessionIndexMtimeMs = -1;
    cachedThreadNames = new Map();
    return cachedThreadNames;
  }

  if (stat.mtimeMs === cachedSessionIndexMtimeMs) {
    return cachedThreadNames;
  }

  const names = new Map();
  const lines = fs.readFileSync(sessionIndexPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      const id = typeof item.id === "string" ? item.id : null;
      const name = typeof item.thread_name === "string" ? item.thread_name.trim() : "";
      if (id && name) names.set(id, name);
    } catch {
      // Ignore partially written or historical index lines.
    }
  }

  cachedSessionIndexMtimeMs = stat.mtimeMs;
  cachedThreadNames = names;
  return cachedThreadNames;
}

function patchThreadListResponse(message) {
  if (probeThreadListFixture && replaceThreadListResponseFromFixture(message)) {
    return true;
  }

  const rows = message?.result?.data;
  if (!Array.isArray(rows) || !rows.some(isThreadListItem)) return false;

  let changed = false;
  let named = 0;
  let indexed = 0;
  let loaded = 0;
  let activated = 0;
  let sourced = 0;
  let threadSourced = 0;

  for (const row of rows) {
    if (!isThreadListItem(row)) continue;

    const indexedName = sessionIndexThreadName(row.id);
    if (indexedName && row.name !== indexedName) {
      row.name = indexedName;
      indexed += 1;
      changed = true;
    } else if (typeof row.name !== "string" || !row.name.trim()) {
      row.name = fallbackThreadName(row);
      named += 1;
      changed = true;
    }

    if (row.status.type === "notLoaded") {
      row.status = { type: "idle" };
      loaded += 1;
      changed = true;
    }

    if (probeSource && row.source !== probeSource) {
      row.source = probeSource;
      sourced += 1;
      changed = true;
    }

    if (probeThreadSource && row.threadSource !== probeThreadSource) {
      row.threadSource = probeThreadSource;
      threadSourced += 1;
      changed = true;
    }
  }

  if (probeActiveFirstThread) {
    const first = rows.find(isThreadListItem);
    if (first && first.status?.type !== "active") {
      first.status = { type: "active", activeFlags: [] };
      activated = 1;
      changed = true;
    }
  }

  if (changed) {
    log({
      kind: "patched_thread_list",
      request_id: message.id ?? null,
      rows: rows.length,
      filled_names: named,
      indexed_names: indexed,
      marked_loaded: loaded,
      marked_active: activated,
      forced_source: sourced,
      forced_thread_source: threadSourced,
    });
  }
  return changed;
}

function replaceThreadListResponseFromFixture(message) {
  if (!message?.result || !Array.isArray(message.result.data)) return false;

  try {
    cachedThreadListFixture ??= JSON.parse(fs.readFileSync(probeThreadListFixture, "utf8"));
    const requestId = message.id;
    for (const key of Object.keys(message)) delete message[key];
    Object.assign(message, JSON.parse(JSON.stringify(cachedThreadListFixture)));
    if (requestId !== undefined) message.id = requestId;
    log({
      kind: "replaced_thread_list_from_fixture",
      request_id: message.id ?? null,
      rows: Array.isArray(message.result?.data) ? message.result.data.length : null,
      fixture: probeThreadListFixture,
    });
    return true;
  } catch (error) {
    log({
      kind: "replace_thread_list_from_fixture_failed",
      error: String(error?.message ?? error),
      fixture: probeThreadListFixture,
    });
    return false;
  }
}

function patchRemoteControlStatus(message) {
  if (!remoteHostName || message?.method !== "remoteControl/status/changed") return false;

  const params = message.params;
  if (!params || typeof params !== "object") return false;
  if (params.serverName === remoteHostName) return false;

  const previous = params.serverName;
  params.serverName = remoteHostName;
  log({ kind: "patched_status_server_name", from: previous ?? null, to: remoteHostName });
  return true;
}

function patchJson(value) {
  if (!value || typeof value !== "object") return false;
  let changed = false;
  changed = patchThreadListResponse(value) || changed;
  changed = patchThreadListResponse(value.message) || changed;
  changed = patchRemoteControlStatus(value) || changed;
  changed = patchRemoteControlStatus(value.message) || changed;
  return changed;
}

function makeJsonRpcSummaryLogger(connectionId) {
  const pendingResponseMethods = new Map();
  return (direction, value, stage = "raw") => {
    logJsonRpcSummary(connectionId, pendingResponseMethods, direction, value, stage);
  };
}

function makeFrameShapeLogger(connectionId) {
  return (event) => {
    log({ connection_id: connectionId, ...event });
  };
}

function logJsonRpcSummary(connectionId, pendingResponseMethods, direction, value, stage) {
  for (const message of jsonRpcCandidates(value)) {
    if (typeof message.method === "string") {
      if (message.id !== undefined && message.id !== null) {
        pendingResponseMethods.set(responseKey(oppositeDirection(direction), message.id), message.method);
      }
      log({
        kind: "jsonrpc_method",
        connection_id: connectionId,
        direction,
        stage,
        method: message.method,
        request_id: message.id ?? null,
        has_params: message.params !== undefined,
        param_keys: objectKeys(message.params),
        envelope_type: value?.type ?? null,
        event_type: value?.event?.type ?? null,
      });
      logKnownShapeMismatch(connectionId, direction, stage, message.method, message, "request");
      continue;
    }

    if (message.id === undefined || message.id === null) continue;
    if (!Object.hasOwn(message, "result") && !Object.hasOwn(message, "error")) continue;

    const key = responseKey(direction, message.id);
    const method = pendingResponseMethods.get(key) ?? null;
    pendingResponseMethods.delete(key);

    log({
      kind: Object.hasOwn(message, "error") ? "jsonrpc_error" : "jsonrpc_response",
      connection_id: connectionId,
      direction,
      stage,
      method,
      request_id: message.id,
      result_keys: objectKeys(message.result),
      error_code: message.error && typeof message.error === "object" ? message.error.code ?? null : null,
      has_error_message: Boolean(message.error && typeof message.error === "object" && message.error.message),
      envelope_type: value?.type ?? null,
      event_type: value?.event?.type ?? null,
    });
    if (method) {
      logKnownShapeMismatch(connectionId, direction, stage, method, message, "response");
    }
  }
}

function logKnownShapeMismatch(connectionId, direction, stage, method, message, messageKind) {
  if (method !== "thread/list") return;

  if (messageKind === "request") {
    const allowed = new Set([
      "archived",
      "cursor",
      "cwd",
      "limit",
      "modelProviders",
      "searchTerm",
      "sortDirection",
      "sortKey",
      "sourceKinds",
      "useStateDbOnly",
    ]);
    const keys = objectKeys(message.params) ?? [];
    const unexpected = keys.filter((key) => !allowed.has(key));
    if (message.params !== undefined && (!message.params || typeof message.params !== "object" || Array.isArray(message.params))) {
      log({
        kind: "jsonrpc_shape_mismatch",
        connection_id: connectionId,
        direction,
        stage,
        method,
        message_kind: messageKind,
        request_id: message.id ?? null,
        reason: "params_not_object",
        param_type: valueType(message.params),
      });
      return;
    }
    if (unexpected.length > 0) {
      log({
        kind: "jsonrpc_shape_mismatch",
        connection_id: connectionId,
        direction,
        stage,
        method,
        message_kind: messageKind,
        request_id: message.id ?? null,
        reason: "unexpected_param_keys",
        param_keys: keys,
        unexpected_param_keys: unexpected,
      });
    }
    return;
  }

  const data = message.result?.data;
  if (!Array.isArray(data)) {
    log({
      kind: "jsonrpc_shape_mismatch",
      connection_id: connectionId,
      direction,
      stage,
      method,
      message_kind: messageKind,
      request_id: message.id ?? null,
      reason: "result_data_not_array",
      result_keys: objectKeys(message.result),
      data_type: valueType(data),
    });
    return;
  }

  const mismatches = [];
  for (let index = 0; index < data.length; index += 1) {
    const row = data[index];
    if (isThreadListItem(row)) continue;
    mismatches.push(threadListRowShape(row, index));
    if (mismatches.length >= 5) break;
  }

  if (mismatches.length > 0) {
    log({
      kind: "jsonrpc_shape_mismatch",
      connection_id: connectionId,
      direction,
      stage,
      method,
      message_kind: messageKind,
      request_id: message.id ?? null,
      reason: "unexpected_thread_rows",
      row_count: data.length,
      mismatch_count: data.filter((row) => !isThreadListItem(row)).length,
      sample_rows: mismatches,
    });
  }
}

function threadListRowShape(row, index) {
  return {
    index,
    type: valueType(row),
    keys: objectKeys(row),
    id_type: valueType(row?.id),
    cwd_type: valueType(row?.cwd),
    name_type: valueType(row?.name),
    preview_type: valueType(row?.preview),
    source_type: valueType(row?.source),
    status_type: valueType(row?.status),
    status_keys: objectKeys(row?.status),
  };
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function jsonRpcCandidates(value) {
  if (!value || typeof value !== "object") return [];
  const candidates = [];
  if (isJsonRpcLike(value)) candidates.push(value);
  if (value.message && value.message !== value && isJsonRpcLike(value.message)) {
    candidates.push(value.message);
  }
  return candidates;
}

function isJsonRpcLike(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    (
      typeof value.method === "string" ||
      Object.hasOwn(value, "result") ||
      Object.hasOwn(value, "error")
    )
  );
}

function objectKeys(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.keys(value).slice(0, 24);
}

function responseKey(direction, id) {
  return `${direction}:${String(id)}`;
}

function oppositeDirection(direction) {
  return direction === "chatgpt-to-codex" ? "codex-to-chatgpt" : "chatgpt-to-codex";
}

function captureRemoteControlMessage(direction, value) {
  if ((!captureThreadList && !captureRemoteControl) || !value || typeof value !== "object") return;

  const candidate = captureCandidate(value) ?? captureCandidate(value.message);
  if (!candidate) return;

  fs.mkdirSync(captureDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  captureCount += 1;
  const path = `${captureDir}/${String(captureCount).padStart(4, "0")}-${stamp}-${direction}-${candidate.kind}.json`;
  fs.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  log({
    kind: "captured_thread_list",
    direction,
    capture_type: candidate.captureType,
    message_kind: candidate.kind,
    method: candidate.method ?? null,
    request_id: candidate.requestId ?? null,
    envelope_type: candidate.envelopeType ?? null,
    event_type: candidate.eventType ?? null,
    rows: candidate.rows ?? null,
    path,
  });
}

function captureCandidate(value) {
  const threadListCandidate = threadListCaptureCandidate(value);
  if (threadListCandidate) return threadListCandidate;
  if (!captureRemoteControl) return null;

  return {
    captureType: "remote-control",
    kind: remoteControlMessageKind(value),
    method: value.method ?? value.message?.method ?? null,
    requestId: value.id ?? value.message?.id ?? null,
    envelopeType: value.type ?? null,
    eventType: value.event?.type ?? null,
  };
}

function threadListCaptureCandidate(value) {
  if (!value || typeof value !== "object") return null;

  if (value.method === "thread/list") {
    return {
      captureType: "thread-list",
      kind: "request",
      method: value.method,
      requestId: value.id ?? null,
    };
  }

  if (Array.isArray(value?.result?.data) && value.result.data.some(isThreadListItem)) {
    return {
      captureType: "thread-list",
      kind: "response",
      requestId: value.id ?? null,
      rows: value.result.data.length,
    };
  }

  return null;
}

function remoteControlMessageKind(value) {
  if (value.method) return "jsonrpc-request";
  if (value.result !== undefined) return "jsonrpc-response";
  if (value.error !== undefined) return "jsonrpc-error";
  if (value.event?.type) return `event-${value.event.type}`;
  if (value.type) return value.type;
  return "message";
}

function textFrame(text) {
  return { fin: true, opcode: 1, payload: Buffer.from(text, "utf8") };
}

function chunkKey(message) {
  return [
    message.client_id ?? "",
    message.stream_id ?? "",
    message.seq_id ?? "",
    message.type ?? "",
  ].join("|");
}

function chunkRemoteMessage(template, innerText) {
  const buffer = Buffer.from(innerText, "utf8");
  const count = Math.max(1, Math.ceil(buffer.length / chunkBytes));
  const out = [];

  for (let index = 0; index < count; index += 1) {
    const chunk = buffer.subarray(index * chunkBytes, (index + 1) * chunkBytes);
    out.push(JSON.stringify({
      ...template,
      segment_id: index,
      segment_count: count,
      message_size_bytes: buffer.length,
      message_chunk_base64: chunk.toString("base64"),
    }));
  }

  return out;
}

function patchOutgoingCodexText(text, logJsonRpc = () => {}, logFrameShape = () => {}) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    logFrameShape({
      kind: "websocket_text_non_json",
      direction: "codex-to-chatgpt",
      stage: "raw",
      bytes: Buffer.byteLength(text, "utf8"),
      error: String(error?.message ?? error),
    });
    return [textFrame(text)];
  }

  if (parsed.type === "server_message_chunk") {
    const completed = collectChunk(parsed, text);
    if (!completed) return [];

    let inner;
    try {
      inner = JSON.parse(Buffer.concat(completed.chunks).toString("utf8"));
    } catch (error) {
      logFrameShape({
        kind: "websocket_chunk_non_json",
        direction: "codex-to-chatgpt",
        stage: "raw",
        envelope_type: parsed.type,
        message_size_bytes: parsed.message_size_bytes ?? null,
        segment_count: parsed.segment_count ?? null,
        error: String(error?.message ?? error),
      });
      return completed.originalTexts.map(textFrame);
    }

    logJsonRpc("codex-to-chatgpt", inner);
    captureRemoteControlMessage("codex-to-chatgpt-raw", inner);

    if (!patchJson(inner)) {
      return completed.originalTexts.map(textFrame);
    }

    captureRemoteControlMessage("codex-to-chatgpt-patched", inner);
    return chunkRemoteMessage(parsed, JSON.stringify(inner)).map(textFrame);
  }

  logJsonRpc("codex-to-chatgpt", parsed);
  captureRemoteControlMessage("codex-to-chatgpt-raw", parsed);
  if (!patchJson(parsed)) {
    return [textFrame(text)];
  }
  captureRemoteControlMessage("codex-to-chatgpt-patched", parsed);
  return [textFrame(JSON.stringify(parsed))];
}

function observeIncomingChatGptText(text, logJsonRpc = () => {}, logFrameShape = () => {}) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    logFrameShape({
      kind: "websocket_text_non_json",
      direction: "chatgpt-to-codex",
      stage: "raw",
      bytes: Buffer.byteLength(text, "utf8"),
      error: String(error?.message ?? error),
    });
    return [textFrame(text)];
  }

  if (parsed.type === "server_message_chunk") {
    const completed = collectChunk(parsed, text, captureChunkBuffers);
    if (!completed) return [textFrame(text)];

    try {
      const inner = JSON.parse(Buffer.concat(completed.chunks).toString("utf8"));
      logJsonRpc("chatgpt-to-codex", inner);
      captureRemoteControlMessage("chatgpt-to-codex", inner);
    } catch (error) {
      logFrameShape({
        kind: "websocket_chunk_non_json",
        direction: "chatgpt-to-codex",
        stage: "raw",
        envelope_type: parsed.type,
        message_size_bytes: parsed.message_size_bytes ?? null,
        segment_count: parsed.segment_count ?? null,
        error: String(error?.message ?? error),
      });
      // Summary and capture are best-effort; do not interfere with the proxied stream.
    }

    return [textFrame(text)];
  }

  logJsonRpc("chatgpt-to-codex", parsed);
  captureRemoteControlMessage("chatgpt-to-codex", parsed);
  return [textFrame(text)];
}

function collectChunk(message, originalText, buffers = chunkBuffers) {
  const key = chunkKey(message);
  const entry = buffers.get(key) ?? {
    count: message.segment_count,
    chunks: new Map(),
    originalTexts: new Map(),
  };

  entry.count = message.segment_count;
  entry.chunks.set(message.segment_id, Buffer.from(message.message_chunk_base64, "base64"));
  entry.originalTexts.set(message.segment_id, originalText);
  buffers.set(key, entry);

  const chunks = [];
  const originalTexts = [];
  for (let index = 0; index < entry.count; index += 1) {
    const chunk = entry.chunks.get(index);
    const text = entry.originalTexts.get(index);
    if (chunk === undefined || text === undefined) return null;
    chunks.push(chunk);
    originalTexts.push(text);
  }

  buffers.delete(key);
  return { chunks, originalTexts };
}

function makeTextFrameTransformer(transformText, observeFrame = () => {}) {
  let opcode = null;
  let fragments = [];

  return (frame) => {
    if (frame.opcode === 1 || frame.opcode === 2) {
      opcode = frame.opcode;
      fragments = [frame.payload];
    } else if (frame.opcode === 0 && opcode !== null) {
      fragments.push(frame.payload);
    } else {
      observeFrame({
        kind: "websocket_unhandled_frame",
        opcode: frame.opcode,
        fin: frame.fin,
        bytes: frame.payload.length,
      });
      return [frame];
    }

    if (!frame.fin) return [];

    const payload = Buffer.concat(fragments);
    const currentOpcode = opcode;
    const fragmentCount = fragments.length;
    opcode = null;
    fragments = [];

    if (currentOpcode !== 1) {
      observeFrame({
        kind: "websocket_non_text_message",
        opcode: currentOpcode,
        fin: true,
        bytes: payload.length,
        fragments: fragmentCount,
      });
      return [{ fin: true, opcode: currentOpcode, payload }];
    }
    return transformText(payload.toString("utf8"));
  };
}

async function proxyWebsocket(req, localSocket, head) {
  const localKey = req.headers["sec-websocket-key"];
  if (!localKey) {
    localSocket.end("HTTP/1.1 400 Bad Request\r\n\r\nmissing sec-websocket-key\n");
    return;
  }

  let remote;
  try {
    remote = await connectToChatGptWebsocket(req);
  } catch (error) {
    log({ kind: "ws_connect_error", error: String(error?.message ?? error) });
    localSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    return;
  }

  localSocket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${websocketAcceptKey(localKey)}`,
    "",
    "",
  ].join("\r\n"));
  const connectionId = nextConnectionId++;
  const logJsonRpc = makeJsonRpcSummaryLogger(connectionId);
  const logFrameShape = makeFrameShapeLogger(connectionId);
  log({ kind: "ws_connected", connection_id: connectionId, path: req.url });

  const transformLocalText = makeTextFrameTransformer(
    (text) => patchOutgoingCodexText(text, logJsonRpc, logFrameShape),
    (event) => logFrameShape({ direction: "codex-to-chatgpt", ...event }),
  );
  const transformRemoteText = makeTextFrameTransformer(
    (text) => observeIncomingChatGptText(text, logJsonRpc, logFrameShape),
    (event) => logFrameShape({ direction: "chatgpt-to-codex", ...event }),
  );
  const localParser = new WsFrameParser((frame) => {
    if (frame.opcode === 0x8) return closeBoth(localSocket, remote.socket, frame, true);
    if (frame.opcode === 0x9) return localSocket.write(encodeFrame({ fin: true, opcode: 0xA, payload: frame.payload }, false));
    if (frame.opcode === 0xA) return;

    for (const outFrame of transformLocalText(frame)) {
      remote.socket.write(encodeFrame(outFrame, true));
    }
  });

  const remoteParser = new WsFrameParser((frame) => {
    if (frame.opcode === 0x8) return closeBoth(remote.socket, localSocket, frame, false);
    if (frame.opcode === 0x9) return remote.socket.write(encodeFrame({ fin: true, opcode: 0xA, payload: frame.payload }, true));
    if (frame.opcode === 0xA) return;

    for (const outFrame of transformRemoteText(frame)) {
      localSocket.write(encodeFrame(outFrame, false));
    }
  });

  if (head?.length) localParser.push(head);
  if (remote.head?.length) remoteParser.push(remote.head);

  localSocket.on("data", (chunk) => localParser.push(chunk));
  remote.socket.on("data", (chunk) => remoteParser.push(chunk));
  localSocket.on("close", () => remote.socket.destroy());
  remote.socket.on("close", () => localSocket.destroy());
  localSocket.on("error", (error) => log({ kind: "local_socket_error", error: String(error.message) }));
  remote.socket.on("error", (error) => log({ kind: "remote_socket_error", error: String(error.message) }));
}

function closeBoth(source, target, frame, maskForTarget) {
  target.write(encodeFrame(frame, maskForTarget));
  source.end();
  target.end();
}

function onlyBackendApi(req, res) {
  if (req.method === "GET" && (req.url === "/healthz" || req.url === "/readyz")) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok\n");
    return false;
  }

  if (req.url.startsWith("/backend-api/")) return true;
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("codex mobile relay only proxies /backend-api/\n");
  return false;
}

const server = http.createServer((req, res) => {
  if (!onlyBackendApi(req, res)) return;
  proxyHttp(req, res).catch((error) => {
    log({ kind: "http_handler_error", error: String(error?.message ?? error) });
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`relay failed: ${error?.message ?? error}\n`);
  });
});

server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/backend-api/")) {
    socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    return;
  }
  proxyWebsocket(req, socket, head).catch((error) => {
    log({ kind: "upgrade_handler_error", error: String(error?.message ?? error) });
    socket.destroy();
  });
});

setInterval(() => {
  chunkBuffers.clear();
  captureChunkBuffers.clear();
}, 120_000).unref();

server.listen(port, "127.0.0.1", () => {
  log({
    kind: "listening",
    local_base: `http://127.0.0.1:${port}/backend-api`,
    target_origin: targetOrigin.origin,
    log_path: logPath,
    capture_thread_list: captureThreadList,
    capture_remote_control: captureRemoteControl,
    capture_dir: captureThreadList || captureRemoteControl ? captureDir : undefined,
  });
});
