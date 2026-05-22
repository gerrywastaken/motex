# Motex

This is the small version of the Linux/Windows Codex mobile remote-control experiment.

It has two moving parts:

- `codex_mobile_relay.mjs` proxies local Codex backend traffic to `https://chatgpt.com`.
- `codex_mobile_remote.mjs` starts the relay, starts `codex app-server`, and runs the TUI with `--remote ws://127.0.0.1:4500`.

The relay makes one intentional change:

- When Codex returns a `thread/list` response, missing thread names are filled from the preview or cwd.
- Threads marked `notLoaded` are changed to `idle` so the mobile app will render and open them.

It does not rewrite sources, spoof platforms, fan out fake rows, or rename sessions permanently.

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
codex resume --remote ws://127.0.0.1:4500
```

Resume the most recent session:

```bash
motex resume --last
```

Run only the bridge/app-server for mobile access:

```bash
motex bridge
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
