#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import tls from "node:tls";

const port = Number(readArg("--port") ?? process.env.PORT ?? 8791);
const targetOrigin = new URL(process.env.TARGET_ORIGIN ?? "https://chatgpt.com");
const logPath = process.env.LOG_FILE ?? defaultLogPath();
const chunkBytes = 96 * 1024;

const chunkBuffers = new Map();

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function defaultLogPath() {
  return process.platform === "win32"
    ? `${process.env.TEMP ?? "."}\\codex-mobile-relay.log`
    : "/tmp/codex-mobile-relay.log";
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
  const body = await readRequestBody(req);

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

function patchThreadListResponse(message) {
  const rows = message?.result?.data;
  if (!Array.isArray(rows) || !rows.some(isThreadListItem)) return false;

  let changed = false;
  let named = 0;
  let loaded = 0;

  for (const row of rows) {
    if (!isThreadListItem(row)) continue;

    if (typeof row.name !== "string" || !row.name.trim()) {
      row.name = fallbackThreadName(row);
      named += 1;
      changed = true;
    }

    if (row.status.type === "notLoaded") {
      row.status = { type: "idle" };
      loaded += 1;
      changed = true;
    }
  }

  if (changed) {
    log({
      kind: "patched_thread_list",
      request_id: message.id ?? null,
      rows: rows.length,
      filled_names: named,
      marked_loaded: loaded,
    });
  }
  return changed;
}

function patchJson(value) {
  if (!value || typeof value !== "object") return false;
  const patchedDirect = patchThreadListResponse(value);
  const patchedEnvelope = patchThreadListResponse(value.message);
  return patchedDirect || patchedEnvelope;
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

function patchOutgoingCodexText(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [textFrame(text)];
  }

  if (parsed.type === "server_message_chunk") {
    const completed = collectChunk(parsed, text);
    if (!completed) return [];

    let inner;
    try {
      inner = JSON.parse(Buffer.concat(completed.chunks).toString("utf8"));
    } catch {
      return completed.originalTexts.map(textFrame);
    }

    if (!patchJson(inner)) {
      return completed.originalTexts.map(textFrame);
    }

    return chunkRemoteMessage(parsed, JSON.stringify(inner)).map(textFrame);
  }

  if (!patchJson(parsed)) {
    return [textFrame(text)];
  }
  return [textFrame(JSON.stringify(parsed))];
}

function collectChunk(message, originalText) {
  const key = chunkKey(message);
  const entry = chunkBuffers.get(key) ?? {
    count: message.segment_count,
    chunks: new Map(),
    originalTexts: new Map(),
  };

  entry.count = message.segment_count;
  entry.chunks.set(message.segment_id, Buffer.from(message.message_chunk_base64, "base64"));
  entry.originalTexts.set(message.segment_id, originalText);
  chunkBuffers.set(key, entry);

  const chunks = [];
  const originalTexts = [];
  for (let index = 0; index < entry.count; index += 1) {
    const chunk = entry.chunks.get(index);
    const text = entry.originalTexts.get(index);
    if (chunk === undefined || text === undefined) return null;
    chunks.push(chunk);
    originalTexts.push(text);
  }

  chunkBuffers.delete(key);
  return { chunks, originalTexts };
}

function makeTextFrameTransformer(transformText) {
  let opcode = null;
  let fragments = [];

  return (frame) => {
    if (frame.opcode === 1 || frame.opcode === 2) {
      opcode = frame.opcode;
      fragments = [frame.payload];
    } else if (frame.opcode === 0 && opcode !== null) {
      fragments.push(frame.payload);
    } else {
      return [frame];
    }

    if (!frame.fin) return [];

    const payload = Buffer.concat(fragments);
    const currentOpcode = opcode;
    opcode = null;
    fragments = [];

    if (currentOpcode !== 1) return [{ fin: true, opcode: currentOpcode, payload }];
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
  log({ kind: "ws_connected", path: req.url });

  const transformLocalText = makeTextFrameTransformer(patchOutgoingCodexText);
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

    localSocket.write(encodeFrame(frame, false));
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

setInterval(() => chunkBuffers.clear(), 120_000).unref();

server.listen(port, "127.0.0.1", () => {
  log({
    kind: "listening",
    local_base: `http://127.0.0.1:${port}/backend-api`,
    target_origin: targetOrigin.origin,
    log_path: logPath,
  });
});
