/**
 * Artifact dump — failure-forensics layer.
 *
 * On expect timeout / session abnormal exit / explicit caller request,
 * we drop a directory of files that captures everything someone needs to
 * diagnose what happened, no live access to the running process required.
 *
 * Files dumped (per technical spec §16):
 *   raw.log               — full PTY byte stream, ANSI included
 *   clean.log             — ANSI-stripped (grep-friendly)
 *   screen.txt            — current snapshot's plain text
 *   screen.ansi.txt       — current snapshot's ANSI form (opt-in)
 *   events.jsonl          — one TerminalEvent per line, lifecycle audit
 *   env.json              — env at session creation, secret-shape redacted
 *   meta.json             — session id, command, dimensions, status, timing
 *
 * The whole thing is pure-fn from a `DumpInput`: tests can construct an
 * input with synthetic data and assert on file contents without ever
 * spawning a PTY.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ErrorCode, TestableTerminalError } from "./errors.js";
import { redactEnv } from "./security.js";
import type { TerminalEvent, TerminalSessionStatus } from "./types.js";

export interface DumpInput {
  /** Stable session id; used in meta.json and (optionally) the dump dir name. */
  sessionId: string;
  command: string;
  args: string[];
  cwd: string;
  rows: number;
  cols: number;
  status: TerminalSessionStatus;
  exitCode: number | null;
  exitSignal: number | undefined;
  createdAt: Date;

  /** Raw PTY bytes (ANSI included). Source: Session.getRawHistoryBytes(). */
  rawHistory: Buffer;
  /** ANSI-stripped form of the same. Caller passes pre-stripped to avoid duplicate work. */
  cleanHistory: string;
  /** Whether the ring buffer truncated the head — captured to meta.json. */
  rawTruncated: boolean;

  /** Current screen text (snapshot.text). */
  screenPlain: string;
  /** Current screen ANSI text. Will be written iff includeAnsiSnapshot=true. */
  screenAnsi: string;

  /** Lifecycle events accumulated across the session. */
  events: TerminalEvent[];

  /** Caller-provided env at session creation. Secret-shape values get redacted. */
  env: Record<string, string>;
  /** Glob patterns for env redaction. From config.security.redactEnvPatterns. */
  redactEnvPatterns: ReadonlyArray<string>;
}

export interface DumpOptions {
  /** Output directory. Will be mkdir'd recursively. */
  outDir: string;
  /** Include the ANSI snapshot file (round 6). Defaults to false. */
  includeAnsiSnapshot?: boolean;
  /** Override clock for testing (default: new Date()). */
  now?: () => Date;
}

export interface DumpResult {
  dir: string;
  files: string[];
  totalBytes: number;
}

/**
 * Write all artifact files to outDir. Returns the list of files written.
 *
 * Throws E_TT_ARTIFACT_WRITE_FAILED on IO error (caller may want to log
 * but continue; this function does not auto-retry).
 */
export function dumpArtifacts(input: DumpInput, opts: DumpOptions): DumpResult {
  const now = (opts.now ?? (() => new Date()))();
  const includeAnsi = opts.includeAnsiSnapshot ?? false;

  try {
    fs.mkdirSync(opts.outDir, { recursive: true });

    const files: string[] = [];
    let totalBytes = 0;
    const writeFile = (name: string, data: string | Buffer): void => {
      const p = path.join(opts.outDir, name);
      fs.writeFileSync(p, data);
      files.push(name);
      totalBytes += typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.length;
    };

    // 1. raw.log — preserve bytes verbatim
    writeFile("raw.log", input.rawHistory);

    // 2. clean.log — already-stripped text
    writeFile("clean.log", input.cleanHistory);

    // 3. screen.txt — current snapshot plain
    writeFile("screen.txt", renderScreenTxt(input, now));

    // 4. screen.ansi.txt — opt-in
    if (includeAnsi && input.screenAnsi.length > 0) {
      writeFile("screen.ansi.txt", input.screenAnsi);
    }

    // 5. events.jsonl — one event per line
    writeFile("events.jsonl", input.events.map((e) => JSON.stringify(e)).join("\n") + (input.events.length > 0 ? "\n" : ""));

    // 6. env.json — redacted
    const redacted = redactEnv(input.env, input.redactEnvPatterns);
    writeFile("env.json", JSON.stringify(redacted, null, 2) + "\n");

    // 7. meta.json — diagnostic facts
    const meta = {
      session_id: input.sessionId,
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      rows: input.rows,
      cols: input.cols,
      status: input.status,
      exit_code: input.exitCode,
      exit_signal: input.exitSignal ?? null,
      raw_truncated: input.rawTruncated,
      raw_bytes: input.rawHistory.length,
      created_at: input.createdAt.toISOString(),
      dumped_at: now.toISOString(),
      duration_ms: now.getTime() - input.createdAt.getTime(),
      include_ansi_snapshot: includeAnsi,
      events_count: input.events.length,
    };
    writeFile("meta.json", JSON.stringify(meta, null, 2) + "\n");

    return { dir: opts.outDir, files, totalBytes };
  } catch (err) {
    throw new TestableTerminalError(
      ErrorCode.ARTIFACT_WRITE_FAILED,
      `failed to dump artifacts to ${opts.outDir}: ${(err as Error).message}`,
      { dir: opts.outDir, cause: (err as Error).message },
    );
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function renderScreenTxt(input: DumpInput, dumpedAt: Date): string {
  const lines = [
    "================ TERMINAL SNAPSHOT ================",
    `session_id: ${input.sessionId}`,
    `command: ${input.command}${input.args.length ? " " + input.args.join(" ") : ""}`,
    `rows: ${input.rows}`,
    `cols: ${input.cols}`,
    `status: ${input.status}`,
    `exit_code: ${input.exitCode === null ? "(null)" : input.exitCode}`,
    `time: ${dumpedAt.toISOString()}`,
    "",
    input.screenPlain,
    "===================================================",
  ];
  return lines.join("\n") + "\n";
}

/**
 * Generate a filesystem-safe slug from `<name>-<timestamp>`. Used by
 * Session.dumpArtifacts when caller doesn't pass an explicit outDir.
 */
export function defaultDumpDirName(name: string, timestamp: Date = new Date()): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "_");
  const ts = timestamp.toISOString().replace(/[:.]/g, "-");
  return `${safe}-${ts}`;
}
