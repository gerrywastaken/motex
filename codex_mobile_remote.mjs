#!/usr/bin/env node
import path from "node:path";
import { spawn } from "node:child_process";

const args = parseArgs(process.argv.slice(2));
const codexBin = process.env.MOTEX_CODEX_BIN ?? (process.platform === "win32" ? "codex.cmd" : "codex");
const cliName = displayCommandName();

if (args.command === "help") {
  usage();
  process.exit(0);
}

if (args.command === "stop") {
  process.exitCode = await runCodex(["remote-control", "stop"]);
} else if (args.command === "bridge") {
  process.exitCode = await startRemoteControl();
} else if (args.command === "resume") {
  process.exitCode = await runWithRemoteControl(["resume", ...args.codexArgs]);
} else {
  process.exitCode = await runWithRemoteControl(args.codexArgs);
}

function parseArgs(rawArgs) {
  if (rawArgs.length === 0) return { command: "run", codexArgs: [] };

  const [first, ...rest] = rawArgs;
  if (first === "--help" || first === "-h" || first === "help") {
    return { command: "help", codexArgs: [] };
  }
  if (first === "resume" || first === "bridge" || first === "stop") {
    return { command: first, codexArgs: rest };
  }
  return { command: "run", codexArgs: rawArgs };
}

async function runWithRemoteControl(codexArgs) {
  const remoteStatus = await startRemoteControl();
  if (remoteStatus !== 0) return remoteStatus;
  return await runCodex(codexArgs);
}

async function startRemoteControl() {
  console.log(`remote: starting with ${codexBin} remote-control start`);
  return await runCodex(["remote-control", "start"]);
}

function runCodex(codexArgs) {
  return new Promise((resolve) => {
    const child = spawn(codexBin, codexArgs, {
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    child.on("error", (error) => {
      console.error(`failed to start ${codexBin}: ${error.message}`);
      console.error("Set MOTEX_CODEX_BIN=/path/to/codex if Codex is installed somewhere unusual.");
      resolve(1);
    });
    child.on("exit", (code, signal) => resolve(code ?? signalCode(signal)));
  });
}

function signalCode(signal) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return signal ? 1 : 0;
}

function usage() {
  console.log(`Usage:
  ${cliName} [CODEX_OPTIONS] [PROMPT]
  ${cliName} resume [CODEX_RESUME_OPTIONS]
  ${cliName} bridge
  ${cliName} stop

Examples:
  ${cliName}
  ${cliName} resume
  ${cliName} resume --last
  ${cliName} resume --all
  ${cliName} -C ~/project "fix the failing test"

Motex first runs 'codex remote-control start', then runs Codex normally.
It does not add '--all' or change Codex's resume defaults.`);
}

function displayCommandName() {
  const basename = path.basename(process.argv[1] ?? "");
  if (basename === "codex_mobile_remote.mjs") return "motex";
  if (!basename) return "motex";
  return basename.endsWith(".mjs") ? `./${basename}` : basename;
}
