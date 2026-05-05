/**
 * assert.env_no_path_duplicates — fail if PATH contains the same dir twice.
 *
 * Pure: takes a snapshot, returns void or throws E_TT_ASSERT_PATH_DUPLICATES.
 *
 * Why this matters: when an installer prepends its bin dir to PATH (the
 * canonical "export PATH=$NEW:$PATH" pattern) and the user runs the
 * installer multiple times, the same dir ends up listed N times. Lookup
 * still works, but the longer PATH slows shell startup and tools like
 * compinit complain. This assert catches it.
 *
 * Windows: PATH is split on `;`, comparison is case-insensitive (Windows
 * filesystem semantics).
 */

import { ErrorCode, TestableTerminalError } from "../../errors.js";
import type { EnvSnapshot } from "../../types.js";
import { platform as hostPlatform, type PlatformInfo } from "../../platform.js";

export interface AssertNoPathDuplicatesOpts {
  snapshot: EnvSnapshot;
  /** Override platform branch (test-only). */
  platform?: PlatformInfo;
}

export interface PathDuplicate {
  dir: string;
  count: number;
}

export function assertEnvNoPathDuplicates(opts: AssertNoPathDuplicatesOpts): void {
  const platform = opts.platform ?? hostPlatform;
  const sep = platform.pathSep;
  const raw = opts.snapshot.env.PATH ?? opts.snapshot.env.Path ?? "";
  const parts = raw.split(sep).filter((s) => s.length > 0);

  const counts = new Map<string, { count: number; original: string }>();
  for (const p of parts) {
    const key = platform.isWindows ? p.toLowerCase() : p;
    const prev = counts.get(key);
    if (prev) prev.count += 1;
    else counts.set(key, { count: 1, original: p });
  }
  const duplicates: PathDuplicate[] = [];
  for (const { count, original } of counts.values()) {
    if (count > 1) duplicates.push({ dir: original, count });
  }
  if (duplicates.length > 0) {
    throw new TestableTerminalError(
      ErrorCode.ASSERT_PATH_DUPLICATES,
      `PATH has ${duplicates.length} duplicated dir(s): ${duplicates.map((d) => `${d.dir} (×${d.count})`).join(", ")}`,
      { duplicates, snapshotName: opts.snapshot.name, snapshotMode: opts.snapshot.mode },
    );
  }
}
