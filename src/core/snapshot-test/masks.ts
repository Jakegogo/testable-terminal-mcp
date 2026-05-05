/**
 * Preset masks for common dynamic fields. Tests reference them by name
 * (`["claude-tui", "common-time"]`) so the .snap file stays portable.
 *
 * Per spec §13.3 — V1 ships 4 presets. New dynamic fields land as
 * case-level masks in the test, not as new presets (avoid mask-library
 * proliferation and the resulting "which mask matches first?" debugging).
 */

import type { SnapMask } from "./store.js";

// ─── preset map ─────────────────────────────────────────────────────────────

export const PRESETS: Record<string, SnapMask[]> = {
  "claude-tui": [
    { pattern: "Crunched for \\d+s", replace: "Crunched for <MASKED>s" },
    { pattern: "Claude Code v\\d+\\.\\d+\\.\\d+", replace: "Claude Code v<MASKED>" },
    { pattern: "Welcome back \\w+", replace: "Welcome back <USER>" },
    { pattern: "pid=\\d+", replace: "pid=<MASKED>" },
  ],
  "kimi-tui": [
    { pattern: "Kimi v\\d+\\.\\d+\\.\\d+", replace: "Kimi v<MASKED>" },
    { pattern: "Session: [a-z0-9]{8,}", replace: "Session: <SID>" },
  ],
  "aikey-cli": [
    { pattern: "aikey v\\d+\\.\\d+\\.\\d+(?:-[a-z0-9.]+)?", replace: "aikey v<MASKED>" },
    { pattern: "session [0-9a-f]{6,}", replace: "session <SID>" },
  ],
  "common-time": [
    {
      pattern: "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+\\-]\\d{2}:\\d{2})?",
      replace: "<TIMESTAMP>",
    },
    {
      pattern: "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
      replace: "<UUID>",
    },
    {
      pattern: "\\b\\d{1,4}ms\\b",
      replace: "<MS>",
    },
  ],
};

/**
 * Resolve a list of preset names + caller-provided inline masks into a
 * concrete SnapMask[]. Unknown names throw a structured error so typos
 * in test code surface immediately (vs silently doing nothing).
 */
export function resolveMasks(names: ReadonlyArray<string>, inline: ReadonlyArray<SnapMask> = []): SnapMask[] {
  const out: SnapMask[] = [];
  for (const n of names) {
    const preset = PRESETS[n];
    if (!preset) {
      throw new Error(`unknown mask preset "${n}" (available: ${Object.keys(PRESETS).join(", ")})`);
    }
    out.push(...preset);
  }
  out.push(...inline);
  return out;
}

/** All preset names — exposed for the review CLI's diagnostic output. */
export function presetNames(): string[] {
  return Object.keys(PRESETS);
}
