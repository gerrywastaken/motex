#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const command = args.command;
const relayPort = Number(args.options.relayPort ?? process.env.CODEX_MOBILE_RELAY_PORT ?? defaultRelayPort(command));
const appPort = Number(args.options.appPort ?? process.env.CODEX_MOBILE_APP_PORT ?? defaultAppPort(command));
const appServerUrl = `ws://127.0.0.1:${appPort}`;
const backendBaseUrl = `http://127.0.0.1:${relayPort}/backend-api`;
const codexBin = process.env.MOTEX_CODEX_BIN ?? (process.platform === "win32" ? "codex.cmd" : "codex");
const cliName = displayCommandName();
const childProcesses = [];
const scriptPath = fileURLToPath(import.meta.url);
const serviceName = process.env.MOTEX_SERVICE_NAME ?? "motex-bridge.service";
const remoteEnableTimeoutMs = parsePositiveInt(process.env.MOTEX_REMOTE_ENABLE_TIMEOUT_MS, 15_000);
const watchdogIntervalMs = parsePositiveInt(process.env.MOTEX_WATCHDOG_INTERVAL_MS, 30_000);
const watchdogFailureLimit = parsePositiveInt(process.env.MOTEX_WATCHDOG_FAILURES, 3);

installSignalHandlers();

if (command === "bridge") {
  if (await appServerReady()) {
    await enableRemoteControl();
    console.log(`Motex is already running at ${appServerUrl}`);
    console.log(`Resume with: ${cliName} resume`);
  } else {
    await runBridge();
  }
} else if (command === "canary") {
  await runBridge();
} else if (command === "reconnect") {
  await reconnect();
} else if (command === "service") {
  await service(args.serviceCommand, args.codexArgs);
} else if (command === "service-restart-worker") {
  await serviceRestartWorker();
} else if (command === "service-takeover-worker") {
  await serviceTakeoverWorker();
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
    serviceCommand: undefined,
  };

  let commandSeen = false;
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    if (!commandSeen && (arg === "--help" || arg === "-h" || arg === "help")) {
      parsed.command = "help";
      commandSeen = true;
      continue;
    }

    if (!commandSeen && (arg === "resume" || arg === "bridge" || arg === "canary" || arg === "reconnect")) {
      parsed.command = arg;
      commandSeen = true;
      continue;
    }

    if (!commandSeen && arg === "service") {
      parsed.command = arg;
      parsed.serviceCommand = rawArgs[index + 1] ?? "status";
      index += parsed.serviceCommand ? 1 : 0;
      commandSeen = true;
      continue;
    }

    if (!commandSeen && (arg === "service-restart-worker" || arg === "service-takeover-worker")) {
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

function defaultRelayPort(activeCommand) {
  return activeCommand === "canary" ? 8792 : 8791;
}

function defaultAppPort(activeCommand) {
  return activeCommand === "canary" ? 4501 : 4500;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function runWithBridge(runTui) {
  if (await appServerReady()) {
    await enableRemoteControl();
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
    env: relayEnv(relayLog),
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

  await enableRemoteControl();
  const stopWatchdog = runTui ? null : startBridgeWatchdog();

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
  stopWatchdog?.();
  if (process.exitCode === 0) process.exitCode = 1;
}

function relayEnv(relayLog) {
  const env = { ...process.env, LOG_FILE: relayLog };
  if (command === "canary" && !env.MOTEX_HOST_NAME) {
    env.MOTEX_HOST_NAME = "main-canary";
  }
  return env;
}

async function reconnect() {
  if (!(await appServerReady())) {
    console.error(`app-server is not ready at http://127.0.0.1:${appPort}/readyz`);
    process.exitCode = 1;
    return;
  }
  await enableRemoteControl();
}

async function service(subcommand, extraArgs) {
  if (process.platform === "win32") {
    console.error("motex service uses systemd --user and is only available on Linux.");
    process.exitCode = 1;
    return;
  }

  if (subcommand === "install") {
    await serviceInstall();
    return;
  }

  if (subcommand === "print") {
    console.log(serviceUnitText());
    return;
  }

  if (subcommand === "restart") {
    await serviceRestart();
    return;
  }

  if (subcommand === "takeover") {
    await serviceTakeover();
    return;
  }

  if (subcommand === "start" || subcommand === "stop" || subcommand === "status" || subcommand === "enable" || subcommand === "disable") {
    process.exitCode = spawnSync("systemctl", ["--user", subcommand, serviceName, ...extraArgs], {
      stdio: "inherit",
    }).status ?? 1;
    return;
  }

  if (subcommand === "logs") {
    process.exitCode = spawnSync("journalctl", ["--user", "-u", serviceName, "-n", "80", "--no-pager", ...extraArgs], {
      stdio: "inherit",
    }).status ?? 1;
    return;
  }

  console.error(`unknown service command: ${subcommand ?? ""}`);
  console.error(`Usage: ${cliName} service install|print|enable|disable|start|stop|restart|takeover|status|logs`);
  process.exitCode = 2;
}

async function serviceInstall() {
  const unitDir = path.join(process.env.HOME ?? "", ".config", "systemd", "user");
  if (!process.env.HOME) {
    console.error("HOME is not set; cannot locate the user systemd unit directory.");
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(unitDir, { recursive: true });
  const unitPath = path.join(unitDir, serviceName);
  fs.writeFileSync(unitPath, serviceUnitText(), { mode: 0o644 });

  const reload = spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  if ((reload.status ?? 1) !== 0) {
    process.exitCode = reload.status ?? 1;
    return;
  }

  console.log(`installed: ${unitPath}`);
  console.log(`start:     ${cliName} service start`);
  console.log(`restart:   ${cliName} service restart`);
  console.log(`status:    ${cliName} service status`);
}

function serviceUnitText() {
  return `[Unit]
Description=Motex Codex mobile bridge
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=120
StartLimitBurst=10

[Service]
Type=simple
ExecStart=${systemdEscape(process.execPath)} ${systemdEscape(scriptPath)} bridge
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=10
WorkingDirectory=%h
Environment=MOTEX_HOST_NAME=main
Environment=CODEX_MOBILE_RELAY_PORT=8791
Environment=CODEX_MOBILE_APP_PORT=4500
Environment=MOTEX_REMOTE_ENABLE_TIMEOUT_MS=15000
Environment=MOTEX_WATCHDOG_INTERVAL_MS=30000
Environment=MOTEX_WATCHDOG_FAILURES=3

[Install]
WantedBy=default.target
`;
}

function systemdEscape(value) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

async function serviceRestart() {
  const result = runWorkerUnit("motex-safe-restart", "service-restart-worker");

  if ((result.status ?? 1) !== 0) {
    process.exitCode = result.status ?? 1;
    return;
  }

  console.log("safe restart handed to systemd as motex-safe-restart.");
  console.log(`watch: ${cliName} service logs`);
}

async function serviceTakeover() {
  const result = runWorkerUnit("motex-safe-takeover", "service-takeover-worker");

  if ((result.status ?? 1) !== 0) {
    process.exitCode = result.status ?? 1;
    return;
  }

  console.log("safe takeover handed to systemd as motex-safe-takeover.");
  console.log("It will stop only listeners on the configured Motex ports, then start the service.");
  console.log(`watch: ${cliName} service logs`);
}

function runWorkerUnit(unitName, workerCommand) {
  return spawnSync("systemd-run", [
    "--user",
    "--unit",
    unitName,
    "--collect",
    process.execPath,
    scriptPath,
    workerCommand,
  ], {
    stdio: "inherit",
  });
}

async function serviceRestartWorker() {
  const restarted = spawnSync("systemctl", ["--user", "restart", serviceName], { stdio: "inherit" });
  if ((restarted.status ?? 1) !== 0) {
    process.exitCode = restarted.status ?? 1;
    return;
  }

  if (!(await waitForAppServer())) {
    process.exitCode = 1;
    return;
  }

  await enableRemoteControl();
}

async function serviceTakeoverWorker() {
  spawnSync("systemctl", ["--user", "stop", serviceName], { stdio: "inherit" });

  await stopListenersOnPort(appPort);
  await stopListenersOnPort(relayPort);

  const started = spawnSync("systemctl", ["--user", "start", serviceName], { stdio: "inherit" });
  if ((started.status ?? 1) !== 0) {
    process.exitCode = started.status ?? 1;
    return;
  }

  if (!(await waitForAppServer())) {
    process.exitCode = 1;
    return;
  }

  await enableRemoteControl();
}

async function stopListenersOnPort(port) {
  const pids = listenerPids(port);
  if (pids.length === 0) return;

  console.log(`stopping listeners on :${port}: ${pids.join(", ")}`);
  for (const pid of pids) killPid(pid, "SIGTERM");

  if (await waitForPortFree(port, 3_000)) return;

  for (const pid of pids) killPid(pid, "SIGKILL");
  await waitForPortFree(port, 2_000);
}

function listenerPids(port) {
  const result = spawnSync("ss", ["-ltnp", `sport = :${port}`], { encoding: "utf8" });
  const out = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const pids = new Set();
  for (const match of out.matchAll(/pid=(\d+)/g)) {
    const pid = Number(match[1]);
    if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) pids.add(pid);
  }
  return [...pids];
}

function killPid(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

async function waitForPortFree(port, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (listenerPids(port).length === 0) return true;
    await sleep(200);
  }
  return listenerPids(port).length === 0;
}

async function resume(extraArgs) {
  return await runCodexProcess(
    withDefaultRemoteCwd(["resume", "--remote", appServerUrl], extraArgs, {
      respectAllFlag: true,
    }),
  );
}

async function runCodex(extraArgs) {
  return await runCodexProcess(
    withDefaultRemoteCwd(["--remote", appServerUrl], extraArgs),
  );
}

function withDefaultRemoteCwd(baseArgs, extraArgs, options = {}) {
  const codexArgs = [...baseArgs];
  if (shouldAddDefaultRemoteCwd(extraArgs, options)) {
    codexArgs.push("-C", process.cwd());
  }
  codexArgs.push(...extraArgs);
  return codexArgs;
}

function shouldAddDefaultRemoteCwd(extraArgs, options = {}) {
  if (hasCwdArg(extraArgs)) return false;
  if (options.respectAllFlag && extraArgs.includes("--all")) return false;
  return true;
}

function hasCwdArg(args) {
  return args.some((arg) => arg === "-C" || arg === "--cd" || arg.startsWith("--cd="));
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
  let logClosed = false;
  const writeLog = (chunk) => {
    if (!logClosed && !out.destroyed && out.writable) {
      out.write(chunk);
    }
  };
  const closeLog = (line) => {
    if (logClosed) return;
    logClosed = true;
    if (!out.destroyed) {
      out.end(line);
    }
  };
  out.on("error", () => {
    logClosed = true;
  });

  const child = spawn(commandName, args, {
    detached: process.platform !== "win32",
    env: options.env,
    stdio: ["ignore", options.captureStdout === false ? "ignore" : "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  if (child.stdout) child.stdout.on("data", writeLog);
  child.stderr.on("data", writeLog);
  childProcesses.push(child);
  child.on("error", (error) => {
    closeLog(`\n[failed to start ${commandName}: ${error.message}]\n`);
    console.error(`failed to start ${commandName}: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    closeLog(`\n[process exited: ${code ?? signal}]\n`);
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

function startBridgeWatchdog() {
  let checking = false;
  let failures = 0;

  console.log(
    `watchdog:   checking every ${watchdogIntervalMs}ms; systemd restart after ${watchdogFailureLimit} failures`,
  );

  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;

    try {
      await checkBridgeHealth();
      if (failures > 0) {
        console.log("watchdog:   recovered");
      }
      failures = 0;
    } catch (error) {
      failures += 1;
      console.error(
        `watchdog:   failure ${failures}/${watchdogFailureLimit}: ${errorMessage(error)}`,
      );

      if (failures >= watchdogFailureLimit) {
        console.error("watchdog:   failure limit reached; exiting for systemd restart");
        clearInterval(timer);
        await shutdown();
        process.exit(1);
      }
    } finally {
      checking = false;
    }
  }, watchdogIntervalMs);

  return () => clearInterval(timer);
}

async function checkBridgeHealth() {
  if (!(await relayReady())) {
    throw new Error(`relay is not ready at http://127.0.0.1:${relayPort}/healthz`);
  }

  if (!(await appServerReady())) {
    throw new Error(`app-server is not ready at http://127.0.0.1:${appPort}/readyz`);
  }

  await enableRemoteControl({ quiet: true });
}

async function relayReady() {
  try {
    const response = await fetch(`http://127.0.0.1:${relayPort}/healthz`);
    return response.ok;
  } catch {
    return false;
  }
}

async function enableRemoteControl(options = {}) {
  const quiet = options.quiet === true;
  try {
    const status = await callAppServerRemoteEnable();
    if (status?.status === "connected") {
      if (!quiet) console.log(`remote:     connected as ${status.serverName ?? "this host"}`);
    } else if (status?.status) {
      if (!quiet) console.log(`remote:     ${status.status}`);
    }
  } catch (error) {
    const message = errorMessage(error);
    if (message.includes("Method not found") || message.includes("Unsupported method")) {
      if (!quiet) console.log("remote:     using legacy remote_control feature flag");
      return;
    }
    if (!quiet) console.error(`remote-control enable failed: ${message}`);
    throw error;
  }
}

function errorMessage(error) {
  return String(error?.message ?? error);
}

function callAppServerRemoteEnable() {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== "function") {
      reject(new Error("Node.js 22 or newer is required to enable remote control"));
      return;
    }

    const socket = new WebSocket(appServerUrl);
    const pending = new Map();
    let nextId = 1;
    let latestStatus = null;

    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("timed out waiting for remote control to connect"));
    }, remoteEnableTimeoutMs);

    function cleanup() {
      clearTimeout(timer);
      socket.close();
    }

    function fail(error) {
      cleanup();
      reject(error);
    }

    function request(method, params) {
      const id = nextId++;
      pending.set(id, method);
      const message = { id, method };
      if (params !== undefined) message.params = params;
      socket.send(JSON.stringify(message));
      return id;
    }

    socket.addEventListener("open", () => {
      request("initialize", {
        clientInfo: {
          name: "motex",
          title: "Motex",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
        },
      });
    });

    socket.addEventListener("message", (event) => {
      handleAppServerMessage(JSON.parse(event.data));
    });

    socket.addEventListener("error", () => {
      fail(new Error(`failed to connect to app-server at ${appServerUrl}`));
    });

    function handleAppServerMessage(message) {
      if (message.method === "remoteControl/status/changed") {
        latestStatus = message.params ?? null;
        if (latestStatus?.status === "connected") {
          cleanup();
          resolve(latestStatus);
        } else if (latestStatus?.status === "errored") {
          fail(new Error("remote control status changed to errored"));
        }
        return;
      }

      if (message.id === undefined) return;

      const method = pending.get(message.id);
      pending.delete(message.id);

      if (message.error) {
        fail(new Error(message.error.message ?? JSON.stringify(message.error)));
        return;
      }

      if (method === "initialize") {
        socket.send(JSON.stringify({ method: "initialized", params: {} }));
        request("remoteControl/enable");
        return;
      }

      if (method === "remoteControl/enable") {
        latestStatus = message.result ?? latestStatus;
        if (latestStatus?.status === "connected") {
          cleanup();
          resolve(latestStatus);
        }
      }
    }
  });
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
  motex reconnect [--app-port 4500]
  motex canary [--relay-port 8792] [--app-port 4501]
  motex service install|print|enable|disable|start|stop|restart|takeover|status|logs

Examples:
  motex
  motex resume
  motex resume --last
  motex reconnect
  motex service restart
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
