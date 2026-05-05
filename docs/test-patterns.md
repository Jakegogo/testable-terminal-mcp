# Test patterns and gotchas

Every TUI agent — claude, codex, kimi, custom CLIs — has its own quirks.
This doc lists the patterns we've found necessary across spike runs and
real-agent CI, so you don't have to rediscover them.

## 1. Dismiss TUI startup modals

**Symptom**: Real agent appears to ignore the test's first prompt.
Output looks fine in screen capture but no response comes back.

**Cause**: Many TUIs show an interactive modal on first launch
(software-update prompt, terms acceptance, key picker, ...). The user
presses Enter / q / s to dismiss, *then* the prompt area appears. If
your test sends a write before dismissing, the modal eats the input.

**Examples seen in the wild**:

| Agent  | Modal                                            | Dismiss key |
|--------|--------------------------------------------------|-------------|
| Kimi   | Software-update notice (Enter=upgrade / q=skip / s=skip-this-version) | `q` or `s` |
| Codex  | Login picker if no `aikey use` set                | `q` |
| Some custom CLIs | API-key picker if vault has multiple aliases | depends |

**Pattern** — wait for "we're at main view" *first*, then dismiss any
modal *blindly*, then start driving:

```yaml
session: { command: kimi, login_shell: true, simulate_precmd_hooks: true }
steps:
  - expect_regex:
      pattern: '(?i)(welcome|❯|>\s|kimi)'   # main view marker
      timeout_ms: 8000
  - send_key: q                               # dismiss any update modal
  - sleep_ms: 200                             # tiny settle for redraw
  - write: "5 + 10 = ?\n"
  - expect_text: { text: '15', timeout_ms: 30000 }
```

If the modal isn't there, `send_key: q` is harmless — it goes to whatever
prompt is up. If it IS there, it dismisses cleanly.

## 2. expect-pattern must NOT overlap with your input

**Symptom**: `expect_text: "OK"` returns immediately, but the agent
hasn't actually produced output. The test "passes" but you're not
actually testing the agent.

**Cause**: When you `write("write something with OK\n")`, the TUI
echoes that line back to the screen *before* processing it. If your
expect pattern is "OK", it matches the echo of your own input.

**Bad**:
```yaml
- write: "Reply with OK\n"
- expect_text: { text: 'OK' }    # ← matches echo of input, not response
```

**Good (sentinel)**:
```yaml
- write: "Reply with the exact string SENTINEL_4f2a\n"
- expect_text: { text: 'SENTINEL_4f2a' }
                       # ← still matches echo BEFORE response,
                       #   but two occurrences let you verify
```

**Better (deterministic prompt with structural answer)**:
```yaml
- write: "5 + 10 = ? Reply with just the number.\n"
- expect_regex:
    pattern: '\b15\b'             # response is structurally distinct
    timeout_ms: 30000             # from the input echo
```

Use a token your prompt cannot contain — a number, a UUID, or a unique
string like `SENTINEL_<hex>`. The string `OK`, `done`, `success` etc
are almost never safe.

## 3. Use `loginShell: true` for any agent that depends on shell env

Without it: `pty.spawn("claude")` runs in npm's environment.
`~/.zshrc` is never sourced. PATH extensions, aliases, env vars set by
shell hooks are all missing. On macOS, this often means PATH starts
with python's path instead of `~/.aikey/bin/`, so the aikey wrappers
never fire and your agent talks to the real upstream API directly,
bypassing whatever proxy / vault routing you have configured.

**Always**:
```ts
startSession({
  command: "claude",
  loginShell: true,
  // ...
});
```

YAML equivalent:
```yaml
session:
  command: claude
  login_shell: true
```

## 4. Use `simulatePrecmdHooks: true` for hook-based tools

aikey, nvm, direnv, pyenv, atuin, oh-my-zsh's plugin system — all
register a `precmd` function in zsh (or `PROMPT_COMMAND` in bash) that
fires *before each interactive prompt*. They use this to inject
state-dependent env vars: aikey reads `~/.aikey/active.env` and exports
`OPENAI_API_KEY` / `KIMI_API_KEY` / etc; nvm switches Node version
based on `.nvmrc`; direnv loads `.envrc`.

When you spawn `zsh -ilc 'cmd'` (which is what `loginShell: true`
does), the prompt cycle never happens. precmd never fires. The env
that the hook would have set is missing.

**Symptom**: codex says "Missing environment variable: OPENAI_API_KEY".
kimi says "LLM not set". Direct shell run works fine, your test
doesn't.

**Fix**: `simulatePrecmdHooks: true` invokes the hook chain manually
before exec. Zero-config — works for any tool that registers there:

```ts
startSession({
  command: "codex",
  args: ["exec", "5+10=?"],
  loginShell: true,
  simulatePrecmdHooks: true,    // ← triggers aikey_precmd, nvm_precmd, etc.
});
```

YAML:
```yaml
session:
  command: codex
  args: ["exec", "5+10=?"]
  login_shell: true
  simulate_precmd_hooks: true
```

## 5. Don't auto-append `\r` to `write()`

Round-6 lesson from the spike: Ink-based TUIs (Claude, Kimi) treat
`text + \r` as a bracketed-paste sequence and *eat the Enter*. They
see the text but never act on it. Always send Enter as a separate
keypress:

```ts
session.write("Hello world");
session.sendKey("enter");
```

Or in YAML:
```yaml
- write: "Hello world"
- send_key: enter
```

For non-interactive `--print` style invocations (claude/kimi/codex all
support some flag for one-shot), you don't need this — the binary
exits after producing one response. Just spawn with the prompt as an
arg:

```ts
startSession({
  command: "claude",
  args: ["--print", "5 + 10 = ?"],
});
```

## 6. Bash `-il` does NOT read `.bashrc` by default

Spec round-8 finding. When fresh-login captures env via
`bash -ilc '...'`, bash sources `/etc/profile`, then the first existing
of `~/.bash_profile` / `~/.bash_login` / `~/.profile`. **It does not
source `~/.bashrc`** unless `.bash_profile` explicitly does so.

If your test fixture writes to `.bashrc` and asserts the change is
visible in fresh-login, it won't be — that's a real signal of an
installer bug (writing to the wrong rc file). The fix is in the
installer (or your test), not in our env-snapshot.

zsh `-il` reads `.zshrc` straightforwardly; this gotcha is bash-only.

## 7. ConPTY (Windows) eats some ANSI sequences

Windows ConPTY translates ANSI sequences into Win32 console calls,
*then* replays them in its own format. Some sequences round-trip
exactly; some don't. Known cases:

| Sequence | macOS / Linux | Windows ConPTY |
|----------|---------------|----------------|
| SGR colors (`\x1b[31m...`) | Captured byte-for-byte | Translated → may differ |
| OSC 8 (hyperlinks) | Captured | Often dropped |
| Cursor pos (`\x1b[6n` reply) | Captured (round-11 fix) | Same |
| Bracketed paste `\x1b[?2004h` | Captured | Translated |

**For snapshot tests**: keep `include_ansi: false` (default). When
you opt in to ANSI snapshots, expect Windows mismatch and add to mask
list. Plain text round-trips reliably.

## 8. macOS bash is 3.2 — don't use bash 4+ features in fixtures

Apple still ships bash 3.2 (last GPLv2 release before they switched
to zsh as default). Fixtures that use `[[ -v VAR ]]` (4.2+),
namerefs (4.3+), or associative arrays (4.0+) will fail on macOS
runners. Test fixture scripts use POSIX `sh` syntax for portability.

## 9. Don't rely on `process.env.SHELL` in test code

CI runners have varied defaults:

| Runner             | `$SHELL`          |
|--------------------|-------------------|
| macos-latest       | `/bin/zsh`        |
| ubuntu-latest      | `/bin/bash`       |
| windows-latest     | `C:\Program Files\PowerShell\7\pwsh.exe` (varies) |

Tests that depend on a specific shell should pin `shellPath` explicitly:

```ts
captureEnvSnapshot({
  ...,
  shellPath: "/bin/zsh",   // not process.env.SHELL
});
```

Or skip if the desired shell isn't available:

```ts
const ZSH = ["/bin/zsh", "/usr/bin/zsh"].find(p => fs.existsSync(p));
if (!ZSH) return; // fixture is zsh-specific; bail clean
```

## 10. Always write a small artifact dump on failure

When a test fails on CI, you can't re-run it interactively. The
artifact dump is your only forensic source:

```ts
try {
  // ... test body
} catch (err) {
  session.dumpArtifacts({ dir: `./artifacts/${testName}` });
  throw err;
}
```

The dump contains:
- `raw.log` — every PTY byte, ANSI included
- `clean.log` — ANSI-stripped, grep-friendly
- `screen.txt` — current viewport
- `events.jsonl` — lifecycle events (input.write, output.data, ...)
- `env.json` — env at session create (secret-shape redacted)
- `meta.json` — sessionId, command, dimensions, status, exit code

The YAML runner dumps automatically on failure to `./artifacts/<case-slug>/`.
