/**
 * Session raw-history accumulator.
 *
 * Round 6 design: every PTY byte is accumulated in an in-memory FIFO ring
 * buffer (default 20MB), independent of `display` mode. Optional
 * `historyLogPath` mirrors bytes to disk too.
 *
 * APIs (4 getters):
 *   getRawHistoryBytes(): Buffer        — raw bytes (ANSI included)
 *   getRawHistory():       string        — UTF-8 of above
 *   getCleanHistory():     string        — ANSI-stripped (best-effort,
 *                                          tolerates ring-truncated head)
 *   getHistoryStats():     {bytes,...}   — diagnostics
 *
 * Why these 4: callers split into "I want the raw artifact"
 * (getRawHistoryBytes for binary log dump) vs "I want grep-able text"
 * (getCleanHistory for `assert log contains X`).
 */

import * as fs from "node:fs";
import type { HistoryStats } from "../types.js";

export interface HistoryConfig {
  maxHistoryBytes: number;
  /** When set, raw bytes are appended here as they arrive. */
  historyLogPath: string | null;
}

export class SessionHistory {
  private readonly maxBytes: number;
  private readonly diskPath: string | null;
  private diskStream: fs.WriteStream | null = null;

  // FIFO ring of byte chunks. Oldest dropped when over maxBytes.
  private chunks: Buffer[] = [];
  private bytes = 0;
  private chunkCount = 0;
  private truncated = false;

  constructor(cfg: HistoryConfig) {
    this.maxBytes = cfg.maxHistoryBytes;
    this.diskPath = cfg.historyLogPath;
    if (this.diskPath) {
      // Append-mode: viewer's `cat <log>; tail -f <log>` works correctly
      // whether the file pre-existed or not.
      this.diskStream = fs.createWriteStream(this.diskPath, { flags: "a" });
    }
  }

  /**
   * Append a chunk of raw bytes. Called by the session on every onData.
   *
   * Sliding-window semantics: after append, the ring contains exactly the
   * last `maxBytes` bytes of the cumulative stream — at byte granularity,
   * not chunk granularity. This handles three cases correctly:
   *
   *   1. Normal small chunks → standard FIFO eviction
   *   2. One oversized chunk (>maxBytes) → slice its tail
   *   3. Small chunks AFTER an oversized one — the oversized chunk's tail
   *      gets head-sliced, not whole-shifted, so subsequent prompt redraws
   *      don't evict the saved tail
   *
   * Repro for case 3: Ubuntu/macOS node 20 + bash batches `for i in $(seq
   * 1 80); do echo LINE_$i; done` into one ~720B chunk. The trailing
   * `bash-3.2$ ` prompt redraw arrives as a separate ~10B chunk. The old
   * implementation FIFO-shifted the entire 720B chunk to fit the 10B,
   * leaving history with just the prompt. The byte-level slice fixes
   * this — every appended byte stays in the ring until pushed out by
   * fresher bytes.
   */
  append(data: string): void {
    this.chunkCount += 1;
    if (this.diskStream) this.diskStream.write(data);

    const buf = Buffer.from(data, "utf8");
    this.chunks.push(buf);
    this.bytes += buf.length;

    // Trim front to fit. Each iteration either drops the whole front
    // chunk (if its length ≤ overflow) or slices the front chunk's head
    // (if its length > overflow), keeping the chunk's tail.
    while (this.bytes > this.maxBytes) {
      const overflow = this.bytes - this.maxBytes;
      const front = this.chunks[0]!;
      if (front.length <= overflow) {
        this.chunks.shift();
        this.bytes -= front.length;
      } else {
        // Slice off the head of `front`. Buffer.subarray shares the
        // underlying ArrayBuffer (zero-copy); cheap on hot paths.
        this.chunks[0] = front.subarray(overflow);
        this.bytes -= overflow;
      }
      this.truncated = true;
    }
  }

  /**
   * Flush + close the disk stream. Returns a Promise that resolves when the
   * underlying file handle has actually been closed — callers in tests can
   * `await` this before unlinking the directory to avoid races.
   *
   * Production callers (Session.attach onExit) can fire-and-forget; the
   * stream gets reaped by Node's GC eventually.
   */
  endDiskStream(): Promise<void> {
    if (!this.diskStream) return Promise.resolve();
    const stream = this.diskStream;
    this.diskStream = null;
    return new Promise((resolve) => {
      stream.end(() => resolve());
    });
  }

  // ─── getters ────────────────────────────────────────────────────────────────

  getRawHistoryBytes(): Buffer {
    return Buffer.concat(this.chunks);
  }

  getRawHistory(): string {
    return this.getRawHistoryBytes().toString("utf8");
  }

  getCleanHistory(): string {
    return stripAnsi(this.getRawHistory());
  }

  getHistoryStats(): HistoryStats {
    return {
      bytes: this.bytes,
      chunks: this.chunkCount,
      truncated: this.truncated,
      path: this.diskPath,
    };
  }
}

// ─── ANSI stripping (tolerant to mid-sequence truncation) ───────────────────

// Round 6 design: when ring buffer drops the head, remaining bytes may
// start mid-escape. The regex below matches whole sequences only, so a
// dangling fragment is left as literal noise (ugly but doesn't break grep).

const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;          // \x1b[<params><intermediate><final>
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g; // \x1b]...\x07 or ...\x1b\\
const ANSI_OTHER = /\x1b[@-Z\\-_]/g;                   // ESC + single-char (e.g. \x1bD, \x1bE)

/** Best-effort ANSI strip. Public for callers that want it on arbitrary strings. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_CSI, "").replace(ANSI_OSC, "").replace(ANSI_OTHER, "");
}
