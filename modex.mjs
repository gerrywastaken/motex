#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const codexBin = process.platform === "win32" ? "codex.cmd" : "codex";

if (hasRemoteArg(args) || shouldPassThrough(args)) {
  runCodex(args);
} else {
  const remote = process.env.MODEX_REMOTE ?? findCodexRemoteControlSocket();
  if (!remote) {
    console.error("modex: no Codex remote-control socket found.");
    console.error("modex: start one first with `codex remote-control` or `codex remote-control start`.");
    process.exit(1);
  }
  runCodex(["--remote", remote, ...withResumeCwd(args)]);
}

function hasRemoteArg(values) {
  return values.some((value) => value === "--remote" || value.startsWith("--remote="));
}

function withResumeCwd(values) {
  if (firstCommand(values) !== "resume") return values;
  if (values.some((value) => value === "--all" || value === "-C" || value === "--cd" || value.startsWith("--cd="))) {
    return values;
  }
  return ["resume", "-C", process.cwd(), ...values.slice(1)];
}

function shouldPassThrough(values) {
  if (values.some((value) => value === "-h" || value === "--help" || value === "-V" || value === "--version")) {
    return true;
  }
  return ["help", "remote-control"].includes(firstCommand(values));
}

function firstCommand(values) {
  const optionsWithValues = new Set([
    "-a",
    "-c",
    "-C",
    "-i",
    "-m",
    "-p",
    "-s",
    "--add-dir",
    "--ask-for-approval",
    "--cd",
    "--config",
    "--disable",
    "--enable",
    "--image",
    "--local-provider",
    "--model",
    "--profile",
    "--profile-v2",
    "--remote-auth-token-env",
    "--sandbox",
  ]);

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--") return values[index + 1] ?? null;
    if (optionsWithValues.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("-")) continue;
    return value;
  }
  return null;
}

function findCodexRemoteControlSocket() {
  const sockets = socketCandidates()
    .map((socketPath) => socketInfo(socketPath))
    .filter(Boolean);

  sockets.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sockets[0] ? `unix://${sockets[0].path}` : null;
}

function socketCandidates() {
  return uniquePaths([...daemonSocketCandidates(), ...temporarySocketCandidates()]);
}

function daemonSocketCandidates() {
  return codexHomeCandidates().map((codexHome) =>
    path.join(codexHome, "app-server-control", "app-server-control.sock"),
  );
}

function codexHomeCandidates() {
  const candidates = [];
  if (process.env.CODEX_HOME) candidates.push(process.env.CODEX_HOME);
  if (process.env.HOME) candidates.push(path.join(process.env.HOME, ".codex"));
  if (process.env.USERPROFILE) candidates.push(path.join(process.env.USERPROFILE, ".codex"));
  return uniquePaths(candidates);
}

function temporarySocketCandidates() {
  const tmp = os.tmpdir();
  let entries;
  try {
    entries = fs.readdirSync(tmp, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("codex-rc-")) continue;
    candidates.push(path.join(tmp, entry.name, "rc.sock"));
  }
  return candidates;
}

function socketInfo(socketPath) {
  let stat;
  try {
    stat = fs.statSync(socketPath);
  } catch {
    return null;
  }
  return stat.isSocket() ? { path: socketPath, mtimeMs: stat.mtimeMs } : null;
}

function uniquePaths(values) {
  return [...new Set(values)];
}

function runCodex(codexArgs) {
  const child = spawn(codexBin, codexArgs, { stdio: "inherit" });
  child.on("error", (error) => {
    console.error(`modex: failed to run ${codexBin}: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}
