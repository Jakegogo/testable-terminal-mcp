/**
 * Stub-binary fixture builder — generates a tarball containing a tiny shell
 * script that imitates `claude --version` / `kimi --version` for installer
 * tests. Building at test runtime avoids checked-in opaque binary blobs.
 *
 * Layout produced by buildStubTarball({ name: "claude", version: "v1" }):
 *   <tarball>.tar.gz
 *     └── claude        (chmod 755, shebang, prints "claude v1")
 *
 * The tarball is rooted at the tool name (no top-level dir) so the installer
 * can `tar -xzf <ball> -C <sandbox>/.local/bin/` and hit the right path.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface BuildOptions {
  /** Binary name (e.g. "claude"). Used as the file inside the tarball. */
  name: string;
  /** Version string the stub prints on `--version` (e.g. "v1"). */
  version: string;
  /** Output directory. The tarball file goes here. Defaults to a fresh tmpdir. */
  outDir?: string;
  /** Filename within outDir. Default: `<name>-<version>.tar.gz`. */
  filename?: string;
}

export interface BuildResult {
  /** Absolute path of the produced tarball. */
  tarball: string;
  /** Suggested file:// URL pointing at the tarball (for installer tests). */
  fileUrl: string;
}

/**
 * Build a self-contained stub-binary tarball. POSIX only (M5a fixtures match
 * the spec — Windows fixtures land with the Windows installer in M8).
 */
export function buildStubTarball(opts: BuildOptions): BuildResult {
  const outDir = opts.outDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ttm-stub-"));
  fs.mkdirSync(outDir, { recursive: true });
  const filename = opts.filename ?? `${opts.name}-${opts.version}.tar.gz`;
  const tarball = path.join(outDir, filename);

  // Build a temp staging dir holding the stub script, then tar -czf.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "ttm-stub-stage-"));
  try {
    const stubPath = path.join(stage, opts.name);
    // Use printf rather than echo so behavior is consistent across shells.
    const script = `#!/bin/sh
case "$1" in
  --version|-v)  printf "${opts.name} ${opts.version}\\n" ;;
  *)             printf "${opts.name} ${opts.version} (stub) — args: $*\\n" ;;
esac
`;
    fs.writeFileSync(stubPath, script, { mode: 0o755 });
    fs.chmodSync(stubPath, 0o755);

    const r = spawnSync("tar", ["-czf", tarball, "-C", stage, opts.name], { encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(`tar failed (status ${r.status}): ${r.stderr}`);
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }

  return { tarball, fileUrl: `file://${tarball}` };
}
