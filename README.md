# Motex

Motex is a tiny wrapper that starts the Codex mobile remote-control daemon before
opening the normal Codex CLI.

It intentionally keeps Codex behavior familiar:

- `motex` runs `codex`
- `motex resume` runs `codex resume`
- `motex resume --last` runs `codex resume --last`
- `motex resume --all` only happens when you pass `--all`

Motex does not proxy traffic, rewrite sessions, or add hidden Codex flags.

## Install

Motex requires Node.js 22 or newer.

Install the command from this directory with npm:

```bash
npm install -g .
```

For local development with npm:

```bash
npm link
```

For local development with pnpm, use `pnpm link --global` so pnpm creates the
global CLI shim for the package `"bin"` entry:

```bash
pnpm link --global
```

If pnpm has not configured a global bin directory yet:

```bash
pnpm setup
```

Then restart your shell and rerun `pnpm link --global`.

## Use

Start Codex in the current directory with mobile remote-control enabled:

```bash
motex
```

Pass normal Codex arguments through:

```bash
motex -C ~/project "fix the failing test"
```

Use Codex's normal resume flow:

```bash
motex resume
```

Resume the most recent session:

```bash
motex resume --last
```

Show every saved session:

```bash
motex resume --all
```

Start the remote-control daemon without opening the TUI:

```bash
motex bridge
```

Stop Codex remote-control:

```bash
motex stop
```

## Codex Binary

Motex runs `codex` from your `PATH` (`codex.cmd` on Windows). To force a
specific Codex binary:

```bash
MOTEX_CODEX_BIN=/path/to/codex motex
```

## Windows

Use the same commands from PowerShell:

```powershell
motex
motex resume
```
