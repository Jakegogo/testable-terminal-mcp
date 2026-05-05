/**
 * Windows integration test gate.
 *
 * Tests in this directory only run on a Windows host. On macOS / Linux they
 * skip cleanly (no failures, no false positives). Use describeIfWindows()
 * as the top-level wrapper.
 *
 * These tests verify the Windows-specific code paths in shell-wrap.ts,
 * env-injector.ts, snapshot.ts (ConPTY tolerance), and viewer.ts
 * (Windows Terminal launching). They cannot be run from a macOS or Linux
 * developer machine — only on a Windows host or windows-latest CI runner.
 */

import { describe } from "vitest";
import { platform as hostPlatform } from "../../src/core/platform.js";

export function describeIfWindows(name: string, fn: () => void): void {
  if (!hostPlatform.isWindows) {
    describe.skip(`${name} (Windows-only)`, fn);
    return;
  }
  describe(name, fn);
}

export const IS_WINDOWS = hostPlatform.isWindows;
