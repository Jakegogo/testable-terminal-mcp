/**
 * installers — fetch a CLI tarball, extract into a sandbox bin dir, probe.
 *
 * Source URL is resolved from `downloadSources` config (config.multiVersion).
 * For M5a the default points at file:// fixture URLs so tests + manual smoke
 * are self-contained. M5b swaps in real https URLs.
 *
 * URL template substitution:
 *   {tool}      → "claude" / "kimi" / ...
 *   {version}   → "v1" / "1.0.0" / ...
 *   {platform}  → "darwin" / "linux" / "win32"
 *   {arch}      → "arm64" / "x64"
 *
 * Extraction:
 *   .tar.gz / .tgz       → `tar -xzf`
 *   .tar.xz / .txz       → `tar -xJf`
 *   .zip                 → POSIX: `unzip -o`,  Windows: `Expand-Archive`
 *
 * Probe:
 *   Run `<dst>/<tool> --version`. Exit 0 = pass; non-zero / no-such-file =
 *   `E_TT_VERSION_EXTRACT_FAILED`. Inside-sandbox installer doesn't trust
 *   the tarball's claim to "be a working binary".
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ErrorCode, TestableTerminalError } from "../errors.js";
import { platform as hostPlatform, type PlatformInfo } from "../platform.js";
import type { SandboxRef } from "../types.js";
import { DownloadCache, pickArchiveExt } from "./cache.js";

// ─── public types ────────────────────────────────────────────────────────────

export type DownloadSourceMap = Record<string, Record<string, string>>;

export interface InstallOptions {
  sandbox: SandboxRef;
  tool: string;
  version: string;
  /** tool → platform-key → URL template. */
  downloadSources: DownloadSourceMap;
  /** Cache instance to use. */
  cache: DownloadCache;
  /** Expected sha256 (hex). When omitted, the install still records the actual hash. */
  expectedSha256?: string;
  /** Override platform branch (test-only). */
  platform?: PlatformInfo;
}

export interface InstallResult {
  /** Absolute path to the installed (extracted) binary. */
  binaryPath: string;
  /** Cached tarball used. */
  tarball: string;
  /** Hex sha256 actually observed. */
  sha256: string;
  /** Whether the cache had it (true) or we just downloaded (false). */
  cacheHit: boolean;
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Resolve URL → ensure cached → extract into sandbox → probe → return path.
 *
 * Errors raised:
 *   E_TT_VERSION_NOT_FOUND       — no template for {tool}/{platform-arch}
 *   E_TT_VERSION_DOWNLOAD_FAILED — fetch (file:// or https) failed
 *   E_TT_VERSION_CHECKSUM_MISMATCH — expected sha256 didn't match
 *   E_TT_VERSION_EXTRACT_FAILED  — tar/unzip failed OR --version probe failed
 */
export async function installVersion(opts: InstallOptions): Promise<InstallResult> {
  const plat = opts.platform ?? hostPlatform;
  const url = resolveDownloadUrl({
    tool: opts.tool,
    version: opts.version,
    platform: plat,
    sources: opts.downloadSources,
  });

  // ── cache check ─────────────────────────────────────────────────────────
  let entry = opts.cache.get(opts.tool, opts.version);
  let cacheHit = entry !== null;

  if (!entry) {
    // ── download ──────────────────────────────────────────────────────────
    const { tarballPath, sha256 } = await fetchToTemp(url);
    if (opts.expectedSha256 && opts.expectedSha256.toLowerCase() !== sha256.toLowerCase()) {
      try { fs.unlinkSync(tarballPath); } catch { /* ignore */ }
      throw new TestableTerminalError(
        ErrorCode.VERSION_CHECKSUM_MISMATCH,
        `sha256 mismatch for ${opts.tool}@${opts.version}: expected ${opts.expectedSha256}, got ${sha256}`,
        { tool: opts.tool, version: opts.version, expected: opts.expectedSha256, actual: sha256 },
      );
    }
    entry = opts.cache.put({
      tool: opts.tool,
      version: opts.version,
      tarballSource: tarballPath,
      sha256,
    });
  }

  // ── extract ─────────────────────────────────────────────────────────────
  const dstDir = path.join(opts.sandbox.path, ".local", "bin");
  fs.mkdirSync(dstDir, { recursive: true });
  extractArchive(entry.tarball, dstDir, plat);

  // ── chmod (POSIX) ──────────────────────────────────────────────────────
  const binaryName = plat.isWindows ? `${opts.tool}.exe` : opts.tool;
  const binaryPath = path.join(dstDir, binaryName);
  if (!fs.existsSync(binaryPath)) {
    throw new TestableTerminalError(
      ErrorCode.VERSION_EXTRACT_FAILED,
      `extract succeeded but expected binary not found: ${binaryPath}`,
      { binaryPath, tool: opts.tool, version: opts.version },
    );
  }
  if (!plat.isWindows) {
    try { fs.chmodSync(binaryPath, 0o755); } catch { /* best-effort */ }
  }

  // ── probe ───────────────────────────────────────────────────────────────
  probeBinary(binaryPath);

  return { binaryPath, tarball: entry.tarball, sha256: entry.sha256, cacheHit };
}

// ─── URL resolution ─────────────────────────────────────────────────────────

export interface ResolveUrlOpts {
  tool: string;
  version: string;
  platform: PlatformInfo;
  sources: DownloadSourceMap;
}

/**
 * Pick the URL template for (tool, platform, arch) and substitute placeholders.
 *
 * Lookup key precedence:
 *   `<platform.os>-<platform.arch>`   (e.g. "darwin-arm64")
 *   `<platform.os>`                    (e.g. "darwin")
 *   `default`
 */
export function resolveDownloadUrl(opts: ResolveUrlOpts): string {
  const toolMap = opts.sources[opts.tool];
  if (!toolMap) {
    throw new TestableTerminalError(
      ErrorCode.VERSION_NOT_FOUND,
      `no download source configured for tool "${opts.tool}"`,
      { hint: "set multiVersion.downloadSources[tool] in config", tool: opts.tool },
    );
  }
  const keys = [`${opts.platform.os}-${opts.platform.arch}`, opts.platform.os, "default"];
  let template: string | undefined;
  for (const k of keys) {
    if (typeof toolMap[k] === "string") { template = toolMap[k]; break; }
  }
  if (!template) {
    throw new TestableTerminalError(
      ErrorCode.VERSION_NOT_FOUND,
      `no URL template for ${opts.tool} on ${opts.platform.os}-${opts.platform.arch}`,
      { tool: opts.tool, platform: opts.platform.os, arch: opts.platform.arch, available: Object.keys(toolMap) },
    );
  }
  return template
    .replace(/\{tool\}/g, opts.tool)
    .replace(/\{version\}/g, opts.version)
    .replace(/\{platform\}/g, opts.platform.os)
    .replace(/\{arch\}/g, opts.platform.arch);
}

// ─── download (file:// + https) ────────────────────────────────────────────

interface FetchResult {
  tarballPath: string;
  sha256: string;
}

async function fetchToTemp(url: string): Promise<FetchResult> {
  if (url.startsWith("file://")) return fetchFileUrl(url);
  if (url.startsWith("http://") || url.startsWith("https://")) return fetchHttpUrl(url);
  throw new TestableTerminalError(
    ErrorCode.VERSION_DOWNLOAD_FAILED,
    `unsupported URL scheme: ${url}`,
    { hint: "only file:// (M5a fixture) and https:// (M5b real) are supported", url },
  );
}

function fetchFileUrl(url: string): FetchResult {
  const sourcePath = decodeURIComponent(url.replace(/^file:\/\//, ""));
  if (!fs.existsSync(sourcePath)) {
    throw new TestableTerminalError(
      ErrorCode.VERSION_DOWNLOAD_FAILED,
      `file:// source does not exist: ${sourcePath}`,
      { url, source: sourcePath },
    );
  }
  // Copy to a temp path so the cache can rename/move freely.
  const ext = pickArchiveExt(sourcePath);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ttm-fetch-"));
  const dst = path.join(tmp, `download${ext}`);
  fs.copyFileSync(sourcePath, dst);
  return { tarballPath: dst, sha256: hashFile(dst) };
}

async function fetchHttpUrl(url: string): Promise<FetchResult> {
  // M5b real wiring — for M5a we throw if hit, since fixtures use file://.
  // Implementing now so the seam is in place.
  const res = await fetch(url);
  if (!res.ok) {
    throw new TestableTerminalError(
      ErrorCode.VERSION_DOWNLOAD_FAILED,
      `HTTP ${res.status} fetching ${url}`,
      { url, status: res.status },
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = pickArchiveExt(url) || ".bin";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ttm-fetch-"));
  const dst = path.join(tmp, `download${ext}`);
  fs.writeFileSync(dst, buf);
  return { tarballPath: dst, sha256: hashBuffer(buf) };
}

function hashFile(p: string): string {
  return hashBuffer(fs.readFileSync(p));
}
function hashBuffer(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// ─── extract ────────────────────────────────────────────────────────────────

function extractArchive(tarball: string, dstDir: string, plat: PlatformInfo): void {
  const ext = pickArchiveExt(tarball);
  const args = (() => {
    if (ext === ".tar.gz") return { cmd: "tar", args: ["-xzf", tarball, "-C", dstDir] };
    if (ext === ".tar.xz") return { cmd: "tar", args: ["-xJf", tarball, "-C", dstDir] };
    if (ext === ".zip") {
      if (plat.isWindows) {
        return { cmd: "powershell", args: ["-NoLogo", "-Command", `Expand-Archive -Path '${tarball}' -DestinationPath '${dstDir}' -Force`] };
      }
      return { cmd: "unzip", args: ["-o", tarball, "-d", dstDir] };
    }
    throw new TestableTerminalError(
      ErrorCode.VERSION_EXTRACT_FAILED,
      `unsupported archive type: ${ext} (${tarball})`,
      { tarball, ext },
    );
  })();

  const r = spawnSync(args.cmd, args.args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new TestableTerminalError(
      ErrorCode.VERSION_EXTRACT_FAILED,
      `extract failed: ${args.cmd} ${args.args.join(" ")} → status ${r.status}`,
      { tarball, dstDir, stderr: r.stderr, status: r.status },
    );
  }
}

// ─── probe ──────────────────────────────────────────────────────────────────

function probeBinary(binaryPath: string): void {
  try {
    execFileSync(binaryPath, ["--version"], { encoding: "utf8", timeout: 5_000 });
  } catch (err) {
    throw new TestableTerminalError(
      ErrorCode.VERSION_EXTRACT_FAILED,
      `binary --version probe failed: ${binaryPath}: ${(err as Error).message}`,
      { binaryPath, cause: (err as Error).message },
    );
  }
}
