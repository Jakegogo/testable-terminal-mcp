/**
 * assert.idempotent_install — run a command twice, check that round 2's
 * resulting (env + files) state matches round 1's.
 *
 * Why this matters: many install scripts unconditionally append to .zshrc
 * ("export PATH=$NEW:$PATH" without a guard). Running the installer N times
 * yields N copies of the line and an N-deep PATH. This assert is the
 * automated "is this script safe to re-run?" check.
 *
 * Implementation:
 *   round 1:
 *     env_snapshot(name=before-r1)        — for diff context only
 *     hashAll(filesToCompare)             — round-1 baseline
 *     run(command)
 *     env_snapshot(name=after-r1)
 *     hashAll(filesToCompare)             — round-1 result
 *   round 2:
 *     run(command)                         — no fresh env_snapshot before; round-1's after IS round-2's before
 *     env_snapshot(name=after-r2)
 *     hashAll(filesToCompare)             — round-2 result
 *   compare:
 *     env: after-r1 == after-r2 (modulo allowed-changes-at-round-2)
 *     files: round-1-result == round-2-result for each compared file
 *
 * The runner is injected — caller (Session) supplies an async function that
 * runs the command in the live PTY shell + waits for completion. This file
 * stays pure-orchestration; the runner is a one-line callback.
 *
 * Failure → E_TT_ASSERT_NOT_IDEMPOTENT with structured envDiff + fileDiff.
 */

import { ErrorCode, TestableTerminalError } from "../../errors.js";
import { computeChanges } from "./env-diff.js";
import { hashAll } from "../file-baseline.js";
import { platform as hostPlatform, type PlatformInfo } from "../../platform.js";
import type { EnvChange, EnvSnapshot, FileBaseline, SandboxRef } from "../../types.js";

export interface IdempotentInstallOpts {
  sandbox: SandboxRef;
  /** Caller-provided runner. Returns when the command has fully completed. */
  runCommand: () => Promise<void>;
  /** Capture the current env after each round. */
  captureEnv: (name: string) => Promise<EnvSnapshot>;
  /** Files to compare for content stability across rounds (sandbox-relative or absolute). */
  filesToCompare: ReadonlyArray<string>;
  /** Override platform (test-only). */
  platform?: PlatformInfo;
  /** Override clock for hashAll. */
  now?: () => Date;
}

export interface IdempotentDiff {
  envChanges: ReadonlyArray<EnvChange>;
  fileDiffs: ReadonlyArray<{ path: string; round1Sha256: string | null; round2Sha256: string | null }>;
}

export async function assertIdempotentInstall(opts: IdempotentInstallOpts): Promise<void> {
  const platform = opts.platform ?? hostPlatform;

  // Round 1.
  await opts.runCommand();
  const afterR1 = await opts.captureEnv("idempotent-after-r1");
  const filesR1 = hashAll({ id: "idempotent-r1", sandbox: opts.sandbox, paths: opts.filesToCompare, now: opts.now });

  // Round 2.
  await opts.runCommand();
  const afterR2 = await opts.captureEnv("idempotent-after-r2");
  const filesR2 = hashAll({ id: "idempotent-r2", sandbox: opts.sandbox, paths: opts.filesToCompare, now: opts.now });

  const envChanges = computeChanges(afterR1.env, afterR2.env, platform);
  const fileDiffs = filesR1.map((b, i) => {
    const a = filesR2[i]!;
    if (b.sha256 === a.sha256) return null;
    return { path: b.path, round1Sha256: b.sha256, round2Sha256: a.sha256 };
  }).filter((x): x is NonNullable<typeof x> => x !== null);

  if (envChanges.length === 0 && fileDiffs.length === 0) return;

  throw new TestableTerminalError(
    ErrorCode.ASSERT_NOT_IDEMPOTENT,
    `command is not idempotent: ${envChanges.length} env change(s), ${fileDiffs.length} file diff(s) between rounds`,
    {
      envChanges,
      fileDiffs,
      hint: "installer should guard against re-running (e.g. `grep -q '# managed' ~/.zshrc || cat >> ~/.zshrc <<EOF`)",
    },
  );
}
