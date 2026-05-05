/**
 * askClaude — one-shot helper for "send prompt → wait reply → return text".
 *
 * Status: V1 reference implementation, NOT a V1 stable API surface (see
 * 技术方案 §4.3 — askClaude is marked ⚠️ V2 publication). The shape may
 * change. For tests / scripts, prefer using `startSession` + waiters
 * directly so you control the wait policy.
 *
 * What this encapsulates (so callers don't reimplement):
 *   1. Spawn claude under login-shell wrap
 *   2. Wait for `❯ ` prompt (via waitForReady)
 *   3. Write prompt + delay + sendKey('enter') (round 6: paste-mode safe)
 *   4. Wait for `⏺ ` reply marker
 *   5. Race idle vs `✻ Crunched` for "reply complete" signal
 *   6. Extract reply text (between ⏺ and end-marker)
 *   7. Always close session, even on error
 */

import { startSession, type SessionConfig } from "../terminal-session.js";
import type { ScreenRead } from "../snapshot.js";
import type { DisplayMode } from "../types.js";
import { isTestableTerminalError, TestableTerminalError } from "../errors.js";
import { logger } from "../../utils/logger.js";

export interface AskClaudeOptions {
  prompt: string;
  command?: string;             // default "claude"
  args?: string[];
  rows?: number;
  cols?: number;
  loginShell?: boolean;          // default true
  /** Total budget. Default 180s. */
  timeoutMs?: number;
  /** How long screen must be quiet to consider reply complete. Default 1500ms. */
  replyStabilityMs?: number;
  /** Return ANSI form of reply too. */
  includeAnsi?: boolean;
  display?: DisplayMode;
  historyLogPath?: string;
  viewerWindowTitle?: string;
}

export interface AskClaudeResult {
  reply: string;
  ansiReply?: string;
  exitCode: number | null;
  ok: boolean;
  reason?: string;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_REPLY_STABILITY_MS = 1500;

export async function askClaude(opts: AskClaudeOptions): Promise<AskClaudeResult> {
  const totalTimeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const replyStability = opts.replyStabilityMs ?? DEFAULT_REPLY_STABILITY_MS;

  const cfg: SessionConfig = {
    command: opts.command ?? "claude",
    args: opts.args,
    rows: opts.rows,
    cols: opts.cols,
    loginShell: opts.loginShell ?? true,
    display: opts.display,
    historyLogPath: opts.historyLogPath,
    viewerWindowTitle: opts.viewerWindowTitle,
  };

  const session = await startSession(cfg);
  logger.debug("ask-claude.spawned", { pid: session.pid });

  try {
    await session.waitForReady({ readyPattern: /❯\s/, timeoutMs: 30_000 });
    logger.debug("ask-claude.ready");

    session.write(opts.prompt);
    // Round 6 lesson: split prompt and Enter so Ink doesn't classify as paste.
    await delay(150);
    session.sendKey("enter");

    // Wait for reply marker (⏺) — tells us claude has started responding.
    await session.waitForRegex(/⏺/, { timeoutMs: totalTimeout });
    logger.debug("ask-claude.reply_started");

    // Reply complete = either screen idle for replyStabilityMs, OR
    // `✻ Crunched for Xs` marker visible. Whichever comes first.
    const idleP = session.waitForIdle({ stabilityMs: replyStability, timeoutMs: totalTimeout });
    const crunchedP = session.waitForRegex(/✻\s+Crunched for/, { timeoutMs: totalTimeout })
      .then(() => session.snapshot());
    const finalSnap = await Promise.race([idleP, crunchedP]);

    const reply = extractClaudeReply(finalSnap);
    if (!reply) {
      return {
        reply: "",
        exitCode: session.stats().exitCode,
        ok: false,
        reason: "no ⏺ marker in final screen",
      };
    }
    return {
      reply: reply.plain,
      ansiReply: opts.includeAnsi ? reply.ansi : undefined,
      exitCode: session.stats().exitCode,
      ok: true,
    };
  } catch (err) {
    if (isTestableTerminalError(err)) {
      const snap = err.details.snapshot as ScreenRead | undefined;
      const partialReply = snap ? extractClaudeReply(snap) : null;
      return {
        reply: partialReply?.plain ?? "",
        ansiReply: opts.includeAnsi ? partialReply?.ansi : undefined,
        exitCode: session.stats().exitCode,
        ok: false,
        reason: `${(err as TestableTerminalError).code}: ${err.message}`,
      };
    }
    throw err;
  } finally {
    await session.close();
  }
}

/**
 * Extract the first ⏺-marked reply block from a screen snapshot.
 * Walks lines from the first `⏺ ` to one of the end markers (✻, ✳, ❯,
 * `⏵⏵` status bar, separator). Plain + ANSI returned in lockstep so
 * callers can render either form.
 */
export function extractClaudeReply(s: ScreenRead): { plain: string; ansi: string } | null {
  const collectedPlain: string[] = [];
  const collectedAnsi: string[] = [];
  let inReply = false;

  for (let idx = 0; idx < s.plainLines.length; idx++) {
    const line = s.plainLines[idx]!;
    const aLine = s.ansiLines[idx] ?? "";
    const trimmedStart = line.replace(/^\s+/, "");

    if (trimmedStart.startsWith("⏺ ")) {
      inReply = true;
      const at = line.indexOf("⏺ ");
      collectedPlain.push(line.slice(at + 2).trimEnd());
      collectedAnsi.push(aLine);
      continue;
    }
    if (!inReply) continue;

    const t = line.trim();
    if (t.startsWith("✻ ") || t.startsWith("✳ ")) break;
    if (t.startsWith("❯")) break;
    if (line.includes("⏵⏵")) break;
    if (/^─{20,}/.test(t)) break;

    collectedPlain.push(line.trimEnd());
    collectedAnsi.push(aLine);
  }

  if (collectedPlain.length === 0) return null;
  while (collectedPlain.length && collectedPlain[0]!.trim() === "") {
    collectedPlain.shift();
    collectedAnsi.shift();
  }
  while (collectedPlain.length && collectedPlain[collectedPlain.length - 1]!.trim() === "") {
    collectedPlain.pop();
    collectedAnsi.pop();
  }
  return { plain: collectedPlain.join("\n"), ansi: collectedAnsi.join("\n") };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
