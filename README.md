# Motex

This is the small version of the Linux/Windows Codex mobile remote-control experiment.

It has two moving parts:

- `codex_mobile_relay.mjs` proxies local Codex backend traffic to `https://chatgpt.com`.
- `codex_mobile_remote.mjs` starts the relay, starts `codex app-server`, and runs the TUI with `--remote ws://127.0.0.1:4500`.

The relay makes one intentional change:

- When Codex returns a `thread/list` response, `/rename` names from
  `~/.codex/session_index.jsonl` are applied, and any remaining missing names
  are filled from the preview or cwd.
- Threads marked `notLoaded` are changed to `idle` so the mobile app will render and open them.

It does not rewrite sources, spoof platforms, fan out fake rows, or rename sessions permanently.

The relay also logs lightweight websocket JSON-RPC summaries by default. These
include method names, request ids, directions, and object key names, but not full
params or result payloads. For known calls such as `thread/list`, Motex logs a
`jsonrpc_shape_mismatch` event if request params or response rows stop matching
the shape Motex expects.

## Run

Motex requires Node.js 22 or newer.

Install the command from this directory with npm:

```bash
npm install -g .
```

For local development with npm, `npm link` works too:

```bash
npm link
```

For local development with pnpm, use `pnpm link --global` so pnpm creates the global CLI shim for the package `"bin"` entry:

```bash
pnpm link --global
```

If pnpm has not configured a global bin directory yet:

```bash
pnpm setup
```

Then restart your shell and rerun `pnpm link --global`.

Start Codex in the current directory with mobile remote support:

```bash
motex
```

Pass normal Codex arguments through:

```bash
motex -C ~/project "fix the failing test"
```

When the Codex TUI exits, the wrapper stops the relay and app-server if it started them.

Use Codex's resume flow through Motex:

```bash
motex resume
```

Under the hood that resumes through the Motex app-server:

```bash
codex resume --remote ws://127.0.0.1:4500 -C "$PWD"
```

Motex adds `-C "$PWD"` in remote mode so Codex keeps the same current-directory
filtering as plain `codex resume`. Pass your own `-C`/`--cd` to override it, or
pass `--all` after `resume` to intentionally list all sessions.

Resume the most recent session:

```bash
motex resume --last
```

## Modex

`modex` is a smaller wrapper for the official Codex remote-control server. It
does not start a Motex relay or a second app-server. It finds the official
remote-control Unix socket and runs Codex with `--remote unix://...`.

Start official remote control in one terminal:

```bash
codex remote-control
```

Or start the official daemon:

```bash
codex remote-control start
```

Attach the terminal TUI to that same server from another terminal:

```bash
modex resume
```

For foreground `codex remote-control`, `modex` uses
`/tmp/codex-rc-*/rc.sock`. For daemonized `codex remote-control start`, it uses
`~/.codex/app-server-control/app-server-control.sock`.

The foreground form is roughly equivalent to:

```bash
codex --remote "unix://$(find /tmp -maxdepth 2 -type s -path '/tmp/codex-rc-*/rc.sock' -print -quit)" resume
```

Use `resume` when you want the terminal to attach to an existing remote-control
session. For a new remote-backed terminal session, run `modex` the same way you
would run `codex`.

Pass normal Codex arguments after `modex`:

```bash
modex
modex resume --last
modex -C ~/project "fix the failing test"
```

If Codex changes the socket path, override discovery explicitly:

```bash
MODEX_REMOTE=unix:///path/to/rc.sock modex resume
```

Run only the bridge/app-server for mobile access:

```bash
motex bridge
```

Reconnect mobile remote control without restarting the bridge:

```bash
motex reconnect
```

Start a second test bridge on alternate local ports without touching the main
bridge:

```bash
motex canary
```

By default the canary uses:

- `http://127.0.0.1:8792/backend-api`
- `ws://127.0.0.1:4501`
- host name `main-canary`

## Safe Remote Restart

For unattended use on Linux, install the user service:

```bash
motex service install
motex service enable
motex service start
```

When run as a service, Motex keeps checking the relay health endpoint, the local
app-server health endpoint, and the remote-control connection path. If any check
fails repeatedly, Motex exits with a failure code so `systemd --user` restarts
the bridge by itself. That recovery does not depend on an attached Codex session
still being alive.

This restores the mobile bridge, not existing terminal websocket clients. A
terminal Codex session attached to the restarted app-server may need to be
resumed again after the bridge comes back.

After that, restart the bridge through systemd instead of restarting it from the
attached Codex session:

```bash
motex service restart
```

`motex service restart` hands the restart to a transient `systemd --user` unit
named `motex-safe-restart`. That unit restarts `motex-bridge.service`, waits for
the app-server health check, and re-enables remote control. The restart keeps
running even if the current Codex TUI loses its connection while the app-server
comes back.

If you already have a manually started Motex bridge on the main ports and want
systemd to take ownership, use:

```bash
motex service takeover
```

`takeover` is intentionally explicit. It starts a transient systemd unit,
stops only the processes listening on the configured Motex ports, starts
`motex-bridge.service`, waits for the app-server health check, and re-enables
remote control. Use this when you are ready for the current TUI connection to
drop briefly while systemd brings the bridge back.

Useful service commands:

```bash
motex service print
motex service enable
motex service disable
motex service status
motex service takeover
motex service logs
motex service stop
```

## Windows

Use the same commands from PowerShell:

```powershell
motex
```

The wrapper calls `codex.cmd` on Windows and `codex` elsewhere.

## Trust Boundary

This is a local proxy for authenticated ChatGPT/Codex backend traffic. Keep it bound to `127.0.0.1`.

Do not expose either of these directly to a network:

- `http://127.0.0.1:8791/backend-api`
- `ws://127.0.0.1:4500`

Logs are written to your temp directory:

- `codex-mobile-relay.log`
- `codex-mobile-app-server.log`

Useful protocol-drift log entries:

- `jsonrpc_method`
- `jsonrpc_response`
- `jsonrpc_error`
- `jsonrpc_shape_mismatch`
