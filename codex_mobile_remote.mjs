#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const command = args.command;
const relayPort = Number(args.options.relayPort ?? process.env.CODEX_MOBILE_RELAY_PORT ?? 8791);
const appPort = Number(args.options.appPort ?? process.env.CODEX_MOBILE_APP_PORT ?? 4500);
const appServerUrl = `ws://127.0.0.1:${appPort}`;
const backendBaseUrl = `http://127.0.0.1:${relayPort}/backend-api`;
const codexBin = process.platform === "win32" ? "codex.cmd" : "codex";
const cliName = displayCommandName();
const childProcesses = [];

installSignalHandlers();

if (command === "bridge") {
  if (await appServerReady()) {
    console.log(`Motex is already running at ${appServerUrl}`);
    console.log(`Resume with: ${cliName} resume`);
  } else {
    await runBridge();
  }
} else if (command === "help") {
  usage();
} else if (command === "resume") {
  await runWithBridge(() => resume(args.codexArgs));
} else if (command === "run") {
  await runWithBridge(() => runCodex(args.codexArgs));
} else {
  usage();
  process.exitCode = 2;
}

function parseArgs(rawArgs) {
const parsed = {
    command: "run",
    options: {
      relayPort: undefined,
      appPort: undefined,
    },
    codexArgs: [],
  };

  let commandSeen = false;
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    if (!commandSeen && (arg === "--help" || arg === "-h" || arg === "help")) {
      parsed.command = "help";
      commandSeen = true;
      continue;
    }

    if (!commandSeen && (arg === "resume" || arg === "bridge")) {
      parsed.command = arg;
      commandSeen = true;
      continue;
    }

    if (arg === "--relay-port") {
      parsed.options.relayPort = rawArgs[++index];
      continue;
    }

    if (arg === "--app-port") {
      parsed.options.appPort = rawArgs[++index];
      continue;
    }

    if (parsed.command === "bridge") {
      parsed.command = arg;
      commandSeen = true;
      continue;
    }

    parsed.codexArgs.push(arg);
    commandSeen = true;
  }

  return parsed;
}

async function runWithBridge(runTui) {
  if (await appServerReady()) {
    process.exitCode = await runTui();
    return;
  }
  await runBridge(runTui);
}

async function runBridge(runTui = null) {
  const relayLog = logFile("relay");
  const appLog = logFile("app-server");

  const relay = spawnManaged(process.execPath, [
    path.join(here, "codex_mobile_relay.mjs"),
    "--port",
    String(relayPort),
  ], relayLog, {
    env: { ...process.env, LOG_FILE: relayLog },
    captureStdout: false,
  });

  const appServer = spawnManaged(codexBin, [
    "-c",
    `chatgpt_base_url="${backendBaseUrl}"`,
    "app-server",
    "--enable",
    "remote_control",
    "--listen",
    appServerUrl,
  ], appLog);

  console.log(`relay:      ${backendBaseUrl}`);
  console.log(`app-server: ${appServerUrl}`);
  console.log(`logs:       ${relayLog}`);
  console.log(`logs:       ${appLog}`);
  console.log("");

  if (!(await waitForAppServer())) {
    await shutdown();
    process.exitCode = 1;
    return;
  }

  if (runTui) {
    const code = await runTui();
    await shutdown();
    process.exitCode = code;
    return;
  }

  console.log("Resume a local TUI with:");
  console.log(`  ${cliName} resume`);
  console.log("");
  console.log("Leave this process running while using Codex mobile.");

  await waitForExit(relay, appServer);
}

async function resume(extraArgs) {
  const resumeArgs = ["resume", "--remote", appServerUrl];
  resumeArgs.push(...extraArgs);
  return await runCodexProcess(resumeArgs);
}

async function runCodex(extraArgs) {
  return await runCodexProcess(["--remote", appServerUrl, ...extraArgs]);
}

async function runCodexProcess(codexArgs) {
  const child = spawn(codexBin, codexArgs, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  return await new Promise((resolve) => {
    child.on("error", (error) => {
      console.error(`failed to start ${codexBin}: ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => resolve(code ?? signalCode(signal)));
  });
}

function spawnManaged(commandName, args, logPath, options = {}) {
  const out = fs.createWriteStream(logPath, { flags: "a" });
  const child = spawn(commandName, args, {
    detached: process.platform !== "win32",
    env: options.env,
    stdio: ["ignore", options.captureStdout === false ? "ignore" : "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  if (child.stdout) child.stdout.pipe(out);
  child.stderr.pipe(out);
  childProcesses.push(child);
  child.on("error", (error) => {
    out.write(`\n[failed to start ${commandName}: ${error.message}]\n`);
    out.end();
    console.error(`failed to start ${commandName}: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    out.write(`\n[process exited: ${code ?? signal}]\n`);
    out.end();
  });
  return child;
}

async function waitForAppServer() {
  const readyz = `http://127.0.0.1:${appPort}/readyz`;
  for (let i = 0; i < 50; i += 1) {
    if (await appServerReady()) return true;
    await sleep(200);
  }
  console.log(`app-server did not report ready yet: ${readyz}`);
  return false;
}

async function appServerReady() {
  try {
    const response = await fetch(`http://127.0.0.1:${appPort}/readyz`);
    return response.ok;
  } catch {
    return false;
  }
}

function waitForExit(...children) {
  return new Promise((resolve) => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) {
        shutdown(child).then(() => {
          process.exitCode = child.exitCode ?? signalCode(child.signalCode);
          resolve();
        });
        return;
      }
      child.on("exit", async (code, signal) => {
        await shutdown(child);
        process.exitCode = code ?? signalCode(signal);
        resolve();
      });
    }
  });
}

async function shutdown(except = null) {
  const stopping = childProcesses
    .filter((child) => child !== except && !child.killed)
    .map((child) => stopChildTree(child));
  await Promise.allSettled(stopping);
}

async function stopChildTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  killChildTree(child, "SIGTERM");
  const stopped = await waitForChild(child, 2_000);
  if (stopped) return;

  killChildTree(child, "SIGKILL");
  await waitForChild(child, 1_000);
}

function killChildTree(child, signal) {
  if (!child.pid) return;

  if (process.platform === "win32") {
    if (signal === "SIGKILL") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      child.kill();
    }
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

function waitForChild(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);

    function onExit() {
      clearTimeout(timer);
      resolve(true);
    }

    child.once("exit", onExit);
  });
}

function signalCode(signal) {
  return signal ? 1 : 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logFile(name) {
  const dir = process.env.TEMP ?? process.env.TMP ?? process.env.TMPDIR ?? "/tmp";
  return path.join(dir, `codex-mobile-${name}.log`);
}

function usage() {
  console.log(`Usage:
  motex [CODEX_OPTIONS] [PROMPT]
  motex resume [CODEX_RESUME_OPTIONS]
  motex bridge [--relay-port 8791] [--app-port 4500]

Examples:
  motex
  motex resume
  motex resume --last
  motex -C ~/project "fix the failing test"`);
}

function displayCommandName() {
  const basename = path.basename(process.argv[1] ?? "");
  if (!basename) return "motex";
  return basename.endsWith(".mjs") ? `./${basename}` : basename;
}

function installSignalHandlers() {
  process.on("SIGINT", async () => {
    await shutdown();
    process.exit(130);
  });
  process.on("SIGTERM", async () => {
    await shutdown();
    process.exit(143);
  });
}
