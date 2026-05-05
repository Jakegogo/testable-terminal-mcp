# testable-terminal-mcp

Cross-platform CLI/TUI testing infrastructure: PTY + headless terminal +
sandbox + MCP/YAML adapters. Drive any terminal-based agent (Claude Code,
Codex, Kimi, custom CLIs) inside a virtual HOME, capture output
deterministically, assert via snapshots / env-diff / file-baseline.

> 中文版: [README.zh-CN.md](README.zh-CN.md)

## What it does

Three layers, all exposed:

1. **Tier 1 — Headless protocol-level testing.** A `node-pty` process is
   wired into a headless `@xterm/headless` parser. Tests drive it with
   `write` / `sendKey` / `resize` and assert on `snapshot` / `expect_text`
   / `expect_regex` / `waitForIdle`. No real terminal window required;
   runs on every CI tier.

2. **Tier 2 — Sandbox + install-test toolkit.** Spawn an agent inside a
   virtual HOME (`HOME=<tmpdir>`) so installer scripts that touch
   `~/.zshrc` / `~/.aikey/` don't pollute the dev's actual home. Capture
   env snapshots in two modes (`current` for in-process, `fresh-login`
   for what a fresh terminal would see), then assert PATH duplicates,
   env diff, file changes, idempotence, monitored-paths leakage.

3. **Tier 3 — Real Terminal.app / Windows Terminal driving (M11
   deferred).** For release-time visual smoke; not on PR CI.

Two adapters wrap the core API:

- **MCP server** (`testable-terminal-mcp` binary) — 24 stdio JSON-RPC
  tools. Plugs into Claude Desktop / Cursor / any MCP client.
- **YAML runner** (`ttm-run`) — author cases as YAML, run via
  `ttm-run case.yaml`. Suitable for golden-path CI without writing JS.

## Quick start

### Install

```bash
git clone https://github.com/Jakegogo/testable-terminal-mcp.git
cd testable-terminal-mcp
npm ci
npm run build
```

Requires Node 20+.

### Run a YAML case

```yaml
# examples/bash-smoke.yaml
name: bash-smoke
session:
  command: bash
  rows: 24
  cols: 80
steps:
  - expect_regex: { pattern: '\$\s', timeout_ms: 3000 }
  - write: "echo HELLO\n"
  - expect_text: { text: HELLO, timeout_ms: 3000 }
```

```bash
npx tsx src/bin/yaml-runner.ts examples/bash-smoke.yaml
# ✓ pass  bash-smoke.yaml — 3 steps
```

### Use as MCP server

```json
// claude_desktop_config.json
{
  "mcpServers": {
    "testable-terminal-mcp": {
      "command": "node",
      "args": ["/abs/path/to/testable-terminal-mcp/dist/bin/mcp-server.js"]
    }
  }
}
```

After restart, Claude Desktop sees 24 tools (`terminal.*`, `sandbox.*`,
`assert.*`). Ask the agent: "Use testable-terminal-mcp to spawn bash,
echo HELLO, snapshot, close."

### Use as a Node library

```ts
import { startSession } from "testable-terminal-mcp";

const session = await startSession({
  command: "bash",
  rows: 24,
  cols: 80,
});
session.write("echo HELLO\n");
await session.waitForText("HELLO", { timeoutMs: 3000 });
const snap = session.snapshot({ range: "viewport" });
console.log(snap.plainText);
await session.close();
```

## Architecture

```
                ┌───────────────────────┐
                │  Adapters             │
   stdio ──────▶│  ├─ MCP server        │
                │  ├─ YAML runner       │
   ttm-run ────▶│  └─ ttm-review CLI    │
                └───────────┬───────────┘
                            │
                ┌───────────▼───────────┐
                │  Core API             │
                │  ├─ Session (PTY)     │
                │  ├─ Sandbox manager   │
                │  ├─ Snapshot test     │
                │  ├─ Install-test tools│
                │  └─ Download cache    │
                └───────────┬───────────┘
                            │
            ┌───────────────┴────────────────┐
            ▼                                ▼
      ┌──────────┐                     ┌──────────┐
      │ node-pty │                     │ @xterm/  │
      │ (process)│ ──── pty data ───▶  │ headless │
      └──────────┘                     │ (parser) │
                                       └──────────┘
```

Hot path:

- `node-pty` spawns the agent as a real OS process behind a PTY.
- Output bytes flow into `@xterm/headless`, which gives a screen
  snapshot identical to what a real terminal would render (modulo
  font / color rendering — that's Tier 3).
- Tests drive `Session.write` / `sendKey` and read `Session.snapshot`.
- Sandbox manager (when configured) wraps the PTY spawn with a virtual
  `HOME`, lifetime-managed.
- Snapshot tests serialize screen state to `.snap` files (insta-style)
  for golden-file regression.

## Module layout

```
src/
├── bin/                  # CLI entry points
│   ├── mcp-server.ts     # testable-terminal-mcp (stdio MCP)
│   ├── yaml-runner.ts    # ttm-run
│   └── review.ts         # ttm-review
├── core/
│   ├── terminal-session.ts          # Session class — Tier 1 entry
│   ├── snapshot.ts                  # screen capture
│   ├── shell-wrap.ts                # login-shell wrap (POSIX + pwsh)
│   ├── sandbox/
│   │   ├── manager.ts               # mkdtemp + lifecycle + registry
│   │   ├── env-injector.ts          # 3 inheritance modes + PATH overlay
│   │   ├── seed.ts                  # profile (minimal/host-zshrc)
│   │   └── aikey-init.ts            # aikey `make sandbox` integration
│   ├── install-test/
│   │   ├── env-snapshot.ts          # current / fresh-login modes
│   │   ├── file-baseline.ts         # sha256 baseline
│   │   └── asserts/                 # 5 assert tools
│   ├── snapshot-test/               # insta-style .snap engine
│   ├── download-cache/              # multi-version binary cache
│   └── session/                     # waiters, history, viewer-bridge
└── adapters/
    ├── mcp/                         # MCP stdio adapter
    └── yaml/                        # YAML case adapter
```

## Test pyramid

420 tests / 47 files. Default `npm test` runs everything; CI matrix
splits into tier1 / tier2 / windows-only.

| Tier   | What             | Where                                        | When            |
|--------|------------------|----------------------------------------------|-----------------|
| Unit   | Pure functions   | `tests/unit/`                                | Every change    |
| Tier 1 | PTY + bash       | `tests/integration-bash/`                    | Every PR (POSIX)|
| Tier 2 | Sandbox / snapshot / install-test / yaml / mcp / mock-llm | `tests/integration-{sandbox,snapshot,install-test,yaml,mcp,mock-llm}/` | Every PR        |
| Windows| ConPTY + pwsh    | `tests/integration-windows{,-mock-agent}/`   | windows-latest  |
| Real   | live agents      | `tests/integration-agent/`                   | Opt-in (label)  |

Run subsets:

```bash
npm test                        # everything that doesn't need real agents
npm run test:unit               # ~minute, 250+ unit tests
npm run test:integration-bash   # POSIX PTY + bash (~14s)

# Real agents (live API): needs aikey configured locally
RUN_REAL_AGENT_TESTS=1 npx vitest run tests/integration-agent
```

## Tech stack

- **node-pty 1.1**  — PTY abstraction (POSIX + Windows ConPTY)
- **@xterm/headless 5.5** — terminal parser (no DOM)
- **zod** — runtime schema validation
- **vitest** — test runner
- **TypeScript 5.4 strict + noUncheckedIndexedAccess**

No bundler. No ESM/CJS gymnastics — `createRequire` for the two CJS deps,
ESM elsewhere. No transitive YAML lib — custom `yaml-mini.ts` (~250L)
parses the test-case subset.

## Error codes

All errors thrown from core are `TestableTerminalError` with an enum
code from `src/core/errors.ts`. Naming convention:

| Suffix       | Meaning                                              |
|--------------|------------------------------------------------------|
| `_FAILED`    | IO / system-level failure                            |
| `_TIMEOUT`   | Caller's budget exceeded; partial state may exist    |
| `_NOT_ALLOWED` | Policy / security rejection                        |
| `_NOT_FOUND` | Referenced resource doesn't exist                    |
| `_LIMIT`     | Resource cap hit                                     |
| `_INVALID`   | Input shape valid but semantically wrong             |
| `_CRASHED`   | Supervised process died unexpectedly                 |

Common codes: `E_TT_EXPECT_TIMEOUT`, `E_TT_SESSION_NOT_FOUND`,
`E_TT_SANDBOX_AIKEY_INIT_FAILED`, `E_TT_ASSERT_*`. Full list in
[src/core/errors.ts](src/core/errors.ts).

## Writing test cases

See [docs/test-patterns.md](docs/test-patterns.md) for the patterns and
gotchas, in particular:

- TUI startup modal dismiss (kimi update prompt etc.)
- expect-pattern must not overlap with your own input (sentinel pattern)
- aikey integration: `loginShell: true` + `simulatePrecmdHooks: true`
  triggers `precmd` hook chain transparently

## CI

`.github/workflows/ci.yml` defines 5 jobs:

- `tier1` — matrix (3 OS × 2 Node) — unit + bash integration
- `tier2` — matrix (3 OS × Node 22) — sandbox / snapshot / install-test /
  yaml / mcp / mock-llm
- `windows-only` — pwsh ConPTY smoke + Windows mock-agent
- `real-agent` — opt-in via PR label `run-real-agent` (live API calls)
- `windows-mock-agent` — nightly cron only

## Development

```bash
# Run tests in watch mode
npm run test:watch

# Type-check only
npm run typecheck

# Build
npm run build

# Run a single test file
npx vitest run tests/integration-bash/smoke.test.ts
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch / PR / label conventions.

## License

MIT.
