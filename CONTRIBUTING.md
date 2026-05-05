# Contributing to testable-terminal-mcp

Thanks for your interest. This doc covers development setup, branch /
PR conventions, and how to trigger CI lanes that don't run by default.

## Development setup

```bash
git clone https://github.com/Jakegogo/testable-terminal-mcp.git
cd testable-terminal-mcp
npm ci
npm run build
npm test     # 420 tests / ~14s
```

Requires Node 20+. The `postinstall` step `chmod +x` on
`node_modules/node-pty/prebuilds/*/spawn-helper` — npm strips the
exec bit during install, and node-pty needs it to launch.

## Branch + PR conventions

- Branch off `main`. Use prefixes when meaningful:
  `fix/`, `feat/`, `docs/`, `test/`, `refactor/`, `ci/`
- Keep commits focused; squash on merge if the branch grew long.
- Reference the spec milestone (M1–M11) in commit body when
  implementing a milestone item.

## CI lanes that don't run on every PR

The default tier1 + tier2 matrix runs on every PR. Two lanes are gated:

### `run-real-agent` label — opt-in real-agent CI

Adding the label `run-real-agent` to a PR triggers the `real-agent`
job on macOS + Linux runners. This job:

1. Installs aikey CLI from
   [aikeylabs/launch](https://github.com/aikeylabs/launch) GitHub
   Releases
2. Installs `claude` / `codex` / `kimi` binaries (via npm or vendor
   distribution scripts; see [.github/workflows/ci.yml](.github/workflows/ci.yml))
3. Populates aikey vault from GitHub secrets:
   - `ANTHROPIC_API_KEY`
   - `ANTHROPIC_BASE_URL` (third-party endpoint, optional)
   - `KIMI_API_KEY`
   - `OPENAI_API_KEY`
4. Runs `RUN_REAL_AGENT_TESTS=1 npx vitest run tests/integration-agent`

To add the label:

```bash
gh pr edit <PR-NUM> --add-label "run-real-agent"
```

After the run completes, drop the label so subsequent pushes don't
re-trigger:

```bash
gh pr edit <PR-NUM> --remove-label "run-real-agent"
```

### `run-real-agent-tmate` label — manual runner login

GitHub-hosted runners are normally non-interactive. For cases where
the automated `aikey add ... --from-stdin` flow isn't enough — for
example, you need to:

- Add an OAuth account (`aikey auth add` opens a browser and
  redirects to a callback)
- Switch which alias is active for `kimi` / experiment with key
  precedence
- Diagnose why aikey routing is failing on the runner

Adding the label `run-real-agent-tmate` (in addition to
`run-real-agent`) inserts a `mxschmitt/action-tmate@v3` step *before*
the test execution. The workflow pauses and prints a tmate SSH command
in the job log, e.g.:

```
SSH: ssh xyz123@nyc1.tmate.io
```

Connect from your laptop:

```bash
ssh xyz123@nyc1.tmate.io
```

You're now in a shell on the runner with aikey installed, vault
populated from secrets, and the project checked out at `$GITHUB_WORKSPACE`.
Common things to do:

```bash
# See what aikey thinks
aikey list
aikey status
aikey doctor

# OAuth flow (browser-based; requires you to open the URL on YOUR laptop)
aikey auth add
# Follow the printed URL on your laptop's browser; the runner's
# auth callback will receive the OAuth token

# Switch active key
aikey use <other-alias>

# Try the test path manually
RUN_REAL_AGENT_TESTS=1 npx vitest run tests/integration-agent/claude-smoke.test.ts

# When done, signal the workflow to continue
touch ~/continue
exit
```

The tmate step is configured with `limit-access-to-actor: true` —
only the GitHub user who triggered the workflow can SSH in. Don't
share the SSH command publicly.

After the tests run, drop both labels so subsequent pushes don't
re-spin a tmate session:

```bash
gh pr edit <PR-NUM> --remove-label "run-real-agent-tmate" \
                    --remove-label "run-real-agent"
```

**Important caveats**:

- Each tmate session is a fresh runner. Anything you change
  manually (added OAuth account, modified vault) **does NOT
  persist** to the next CI run. Use this only for debugging /
  exploration.
- For persistent state across CI runs, you need a self-hosted
  runner (out of scope for this project).
- OAuth flows that need a callback to localhost won't work
  out-of-the-box on the runner — you'd need to forward a port
  via tmate or use a device-flow OAuth variant.

### Nightly cron — Windows mock-agent

Cron `0 3 * * *` UTC fires the `windows-mock-agent` job on
windows-latest. It boots the in-process mock LLM server, spawns claude
binary if available on the runner, asserts the link works without
hitting the real Anthropic API.

To trigger manually for testing:

```bash
gh workflow run ci.yml --ref main
# or via the GitHub UI — Actions → ci → Run workflow
```

## Pre-flight checklist before opening a PR

```bash
npm run typecheck     # strict + noUncheckedIndexedAccess
npm test              # 420 tests / ~14s
```

If you touched aikey integration / hook-based tools:

```bash
RUN_REAL_AGENT_TESTS=1 npx vitest run tests/integration-agent
# Requires aikey configured locally (`aikey use <alias>` for each provider).
```

## Adding new tests

### Unit (`tests/unit/`)

Pure-function tests. No PTY. Run in milliseconds. Add freely.

### Integration (`tests/integration-*/`)

PTY-driven. Each file picks ONE focus area:

- `integration-bash/` — POSIX bash smoke
- `integration-sandbox/` — virtual HOME + env-injector
- `integration-install-test/` — installer assertion fixtures
- `integration-snapshot/` — `.snap` round-trip
- `integration-yaml/` — YAML runner E2E
- `integration-mcp/` — MCP stdio + tool dispatch
- `integration-mock-llm/` — fixture LLM server contract
- `integration-windows/` — windows-only (skipped on POSIX)
- `integration-agent/` — real LLM (gated by `RUN_REAL_AGENT_TESTS=1`)

When adding integration tests against TUI agents, follow the patterns
in [docs/test-patterns.md](docs/test-patterns.md):

1. Always use `loginShell: true` if the binary depends on shell-set
   env (most agents do)
2. Set `simulatePrecmdHooks: true` if the binary depends on hook-based
   tools (aikey, nvm, direnv, ...)
3. Use sentinel patterns in expect — never an `expect_text` that
   could match the prompt itself or your own input echo
4. Handle TUI startup modals with `send_key` (`q` / `enter` / `esc`)
   before driving the actual workflow

## Reporting bugs

Open an issue with:

1. Reproducer (minimal `.yaml` case or Node script)
2. Expected output
3. Actual output (raw history dump from `session.getRawHistory()`)
4. Environment: `node --version`, `npm --version`, OS
5. If the bug is with a real agent, redact API keys but keep the
   provider + binary version (`claude --version`)

For PTY / ConPTY behavior questions specifically, attach the artifact
dump from a failing run:

```bash
# Inside a failing session
session.dumpArtifacts({ dir: "./debug-artifacts" });
# Then attach the dir contents (raw.log, clean.log, events.jsonl, meta.json)
```

## Security

Never commit:

- `.env` / `.env.*` (gitignored, but double-check)
- Any file containing `sk-`, `aikey_personal_`, OAuth tokens
- Real API keys in test fixtures (use `tests/fixtures/mock-llm-server.ts`
  for fake responses)

If you accidentally pushed a secret, rotate it immediately at the
provider, then `git push --force-with-lease` after rewriting history.
GitHub secret scanning will flag obvious patterns post-push.

## License

MIT. By contributing, you agree your contributions are licensed under
the same terms.
