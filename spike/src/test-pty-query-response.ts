/**
 * test-pty-query-response — pin the bidirectional PTY ↔ xterm.headless wiring
 * so terminal-capability queries (DSR `\x1b[6n`, Primary/Secondary Device
 * Attributes `\x1b[c` / `\x1b[>c`) get xterm-synthesized responses delivered
 * back to the PTY's stdin.
 *
 * Why this test exists (regression guard):
 *   Codex 0.128.0 (and other ratatui-style TUIs) emit `\x1b[6n` at startup
 *   and BLOCK waiting for a cursor-position response. xterm.headless's
 *   parser already produces a synthesized response, but until 2026-05-05
 *   the spike's session.ts attached only `proc.onData` (PTY → xterm) and
 *   never `term.onData` (xterm → PTY), so synthesized responses were
 *   silently discarded. Codex hung after the banner. See
 *   `update/spike-验证结果.md` 坑 4 (status: fixed 2026-05-05).
 *
 *   This test fails if anyone removes the `this.term.onData(...)` wiring
 *   in `attach()`.
 *
 * Loopback strategy:
 *   Spawn `bash -c '<script>'`. Script runs `stty -echo` (so the read of
 *   the response doesn't double-render onto stdout), writes the query to
 *   stdout, reads up to N bytes from stdin until the terminator (R for DSR,
 *   c for DA), then writes the captured bytes to a tmp file via `od`.
 *   We verify the file contents match the expected response after the
 *   session exits — a tmp file is used because the printed message may
 *   scroll out of the visible terminal buffer before snapshot.
 *
 * Run:
 *   npm run spike:test-pty-query-response
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { startSession, stripTerminalQueriesFromMirror } from "./lib/session.js";

const log = (...a: unknown[]) => process.stderr.write(`[query-rsp-test] ${a.map(String).join(" ")}\n`);

interface QueryCase {
  name: string;
  /** Bytes the spawned process writes to stdout to trigger the query. */
  query: string;
  /** The byte that terminates the response (used as `read -d`). */
  terminator: string;
  /**
   * RegExp the captured response (with terminator appended) must match.
   * Anchored against the binary-decoded captured bytes.
   */
  expectedPattern: RegExp;
}

const cases: QueryCase[] = [
  {
    name: "DSR cursor position (\\x1b[6n)",
    query: "\\x1b[6n",
    terminator: "R",
    // CSI Pn ; Pn R
    expectedPattern: /^\x1b\[\d+;\d+R$/,
  },
  {
    name: "Primary Device Attributes (\\x1b[c)",
    query: "\\x1b[c",
    terminator: "c",
    // CSI ? Pn ; Pn c (xterm-headless emits "\x1b[?1;2c")
    expectedPattern: /^\x1b\[\?[\d;]+c$/,
  },
];

async function runCase(c: QueryCase): Promise<void> {
  log(`case=${c.name}`);

  const tmpFile = `/tmp/spike-query-rsp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`;
  // Why stty -echo: PTY's local-line-discipline echoes stdin back to stdout
  // by default, which would double-render the response on the snapshot and
  // garble the test output. Disabling echo keeps the response confined to
  // bash's `read` consumption.
  // Why per-byte read: `IFS= read -d <X>` over a multi-byte sequence is
  // unreliable when the terminator appears mid-sequence; reading one byte
  // at a time and breaking on the terminator pattern is robust.
  // Why /tmp file (not stdout printf): the printed message can scroll out
  // of the visible terminal buffer before the snapshot is read; a file
  // gives us out-of-band ground truth.
  const script = `
stty -echo
printf '${c.query}'
captured=""
while IFS= read -r -t 2 -n 1 ch 2>/dev/null; do
  captured="$captured$ch"
  case "$captured" in *${c.terminator}) break;; esac
done
printf '%s' "$captured" > ${tmpFile}
`;

  const session = await startSession({
    command: "bash",
    args: ["-c", script],
    loginShell: false,
    rows: 24,
    cols: 80,
  });

  try {
    const { exitCode } = await session.waitForExit({ timeoutMs: 5_000 });
    assert.equal(exitCode, 0, `bash loopback script must exit 0, got ${exitCode}`);

    const captured = fs.readFileSync(tmpFile, "binary");
    log(`  captured ${captured.length} bytes: ${JSON.stringify(captured)}`);
    assert.ok(
      c.expectedPattern.test(captured),
      `response must match ${c.expectedPattern}; got ${JSON.stringify(captured)}.\n` +
      `If this fails, the term.onData → proc.write wiring in session.ts attach() is missing or broken.`,
    );
    log(`  ✓ pass`);
  } finally {
    await session.close();
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

/**
 * Pure-function test: stripTerminalQueriesFromMirror correctly removes
 * QUERY sequences while leaving display state (alt-screen, SGR, OSC title,
 * etc.) untouched. This is the second half of the bidirectional fix —
 * without stripping, the user's real terminal sees codex's queries via
 * mirror, auto-responds, and the response bytes loop back into the TUI's
 * input field as visible escape junk (observed on Apple Terminal v470).
 */
function caseStripperUnit(): void {
  log("case=stripTerminalQueriesFromMirror — pure-function unit checks");

  // Queries must be stripped.
  const queryCases: Array<[string, string]> = [
    ["DSR cursor",     "\x1b[6n"],
    ["DSR status",     "\x1b[5n"],
    ["Primary DA",     "\x1b[c"],
    ["Primary DA-0",   "\x1b[0c"],
    ["Secondary DA",   "\x1b[>c"],
    ["Tertiary DA",    "\x1b[=c"],
    ["kitty kb query", "\x1b[?u"],
    ["OSC 10 (ST)",    "\x1b]10;?\x1b\\"],
    ["OSC 10 (BEL)",   "\x1b]10;?\x07"],
    ["OSC 11 (ST)",    "\x1b]11;?\x1b\\"],
    ["OSC 4;3 (BEL)",  "\x1b]4;3;?\x07"],
  ];
  for (const [name, q] of queryCases) {
    const stripped = stripTerminalQueriesFromMirror(`PRE${q}POST`);
    assert.equal(stripped, "PREPOST", `${name}: expected query removed, got ${JSON.stringify(stripped)}`);
  }

  // Display state must NOT be stripped.
  const keepCases: Array<[string, string]> = [
    ["alt-screen on",     "\x1b[?1049h"],
    ["alt-screen off",    "\x1b[?1049l"],
    ["bracketed paste",   "\x1b[?2004h"],
    ["focus reporting",   "\x1b[?1004h"],
    ["sync output on",    "\x1b[?2026h"],
    ["set title",         "\x1b]0;hello\x07"],
    ["SGR red",           "\x1b[31m"],
    ["cursor up",         "\x1b[A"],
    ["DSR response",      "\x1b[1;1R"],   // response, not query
    ["DA response",       "\x1b[?1;2c"],  // response (has ?), not query
    ["OSC 10 response",   "\x1b]10;rgb:e6ce/e6ce/e6ce\x07"],
  ];
  for (const [name, s] of keepCases) {
    const stripped = stripTerminalQueriesFromMirror(`PRE${s}POST`);
    assert.equal(stripped, `PRE${s}POST`, `${name}: must NOT be stripped, got ${JSON.stringify(stripped)}`);
  }

  // Realistic codex startup burst — multiple queries inline with mode-setters.
  // Captured from spike:codex:interactive output before the fix.
  const codexBurst =
    "\x1b[?2004h\x1b[>7u\x1b[?1004h\x1b[6n\x1b[?u\x1b[c\x1b]10;?\x1b\\\x1b]0;testable-terminal-mcp\x07\x1b[?2026h";
  const expected =
    "\x1b[?2004h\x1b[>7u\x1b[?1004h\x1b]0;testable-terminal-mcp\x07\x1b[?2026h";
  const got = stripTerminalQueriesFromMirror(codexBurst);
  assert.equal(got, expected,
    `codex startup burst: queries should be removed, mode-setters/title kept.\n  got: ${JSON.stringify(got)}\n  expected: ${JSON.stringify(expected)}`);

  log(`  ✓ pass (${queryCases.length} queries stripped, ${keepCases.length} state kept, codex burst correct)`);
}

async function main(): Promise<number> {
  let failures = 0;
  try {
    caseStripperUnit();
  } catch (err) {
    log(`✗ FAIL [stripper]: ${(err as Error).message}`);
    failures += 1;
  }
  for (const c of cases) {
    try {
      await runCase(c);
    } catch (err) {
      log(`✗ FAIL [${c.name}]: ${(err as Error).message}`);
      failures += 1;
    }
  }

  if (failures > 0) {
    log(`\n${failures} test(s) failed`);
    return 1;
  }
  log(`\nall ${cases.length + 1} test(s) passed`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log(`unexpected error: ${(err as Error).stack ?? err}`);
    process.exit(2);
  },
);
