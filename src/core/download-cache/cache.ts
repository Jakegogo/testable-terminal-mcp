/**
 * Download cache — content-addressed, LRU-evicting tarball store.
 *
 * Layout (POSIX):
 *   ~/.cache/ttm/downloads/
 *     index.json
 *     <tool>-<version>-<platform>-<arch>.tar.gz
 *     <tool>-<version>-<platform>-<arch>.tar.gz.sha256   (optional sidecar)
 *
 * Windows:
 *   %LOCALAPPDATA%\ttm\Cache\downloads\
 *
 * `index.json` shape:
 *   {
 *     "<tool>": {
 *       "<version>": {
 *         "tarball": "/abs/path",
 *         "sha256": "abc...",
 *         "size": 12345,
 *         "downloaded_at": "2026-...",
 *         "last_used_at":  "2026-..."
 *       }
 *     }
 *   }
 *
 * Eviction:
 *   On `put()`, total size > maxBytes triggers LRU eviction (sort by
 *   last_used_at asc, drop oldest until under cap). The newly-added entry is
 *   never evicted in the same put() call.
 *
 * Concurrency:
 *   This is a single-process cache. We don't need cross-process locks for
 *   M5a (tests + manual smoke). M5b/M6 may add file-locking if CI parallel
 *   runs collide.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ErrorCode, TestableTerminalError } from "../errors.js";
import { platform as hostPlatform, type PlatformInfo } from "../platform.js";

// ─── public types ────────────────────────────────────────────────────────────

export interface CacheEntry {
  tool: string;
  version: string;
  /** Absolute path of the cached tarball file. */
  tarball: string;
  /** Hex sha256 of the tarball bytes. */
  sha256: string;
  /** File size in bytes. */
  size: number;
  /** ISO timestamp when first downloaded. */
  downloadedAt: string;
  /** ISO timestamp of last get() — drives LRU eviction. */
  lastUsedAt: string;
}

export interface CacheConfig {
  /** Override cache root. Default: platform-appropriate user cache dir. */
  cacheDir?: string | null;
  /** Soft cap; LRU eviction kicks in on put() when exceeded. */
  maxBytes: number;
  /** Override clock for testing. */
  now?: () => Date;
  /** Override platform branch (test-only). */
  platform?: PlatformInfo;
}

// ─── public API ──────────────────────────────────────────────────────────────

export class DownloadCache {
  readonly dir: string;
  readonly maxBytes: number;
  private readonly now: () => Date;

  constructor(cfg: CacheConfig) {
    const plat = cfg.platform ?? hostPlatform;
    this.dir = cfg.cacheDir ?? defaultCacheDir(plat);
    this.maxBytes = cfg.maxBytes;
    this.now = cfg.now ?? (() => new Date());
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** Look up (and touch lastUsedAt) a cached entry. Returns null if absent. */
  get(tool: string, version: string): CacheEntry | null {
    const idx = this.readIndex();
    const e = idx[tool]?.[version];
    if (!e) return null;
    if (!fs.existsSync(e.tarball)) {
      // Entry in index but file gone — heal silently.
      delete idx[tool]![version];
      this.writeIndex(idx);
      return null;
    }
    e.lastUsedAt = this.now().toISOString();
    this.writeIndex(idx);
    return e;
  }

  /**
   * Insert a tarball. Source must already exist on disk; we move it into the
   * cache (or copy if cross-device). Returns the canonical entry.
   * Triggers LRU eviction when total size exceeds maxBytes.
   */
  put(opts: {
    tool: string;
    version: string;
    tarballSource: string;
    sha256: string;
  }): CacheEntry {
    if (!fs.existsSync(opts.tarballSource)) {
      throw new TestableTerminalError(
        ErrorCode.VERSION_DOWNLOAD_FAILED,
        `tarball source not found: ${opts.tarballSource}`,
        { source: opts.tarballSource },
      );
    }
    const filename = canonicalFilename(opts.tool, opts.version, opts.tarballSource);
    const dst = path.join(this.dir, filename);

    if (path.resolve(opts.tarballSource) !== path.resolve(dst)) {
      try {
        fs.renameSync(opts.tarballSource, dst);
      } catch {
        // EXDEV: cross-device — fall back to copy + unlink.
        fs.copyFileSync(opts.tarballSource, dst);
        try { fs.unlinkSync(opts.tarballSource); } catch { /* ignore */ }
      }
    }

    const stat = fs.statSync(dst);
    const ts = this.now().toISOString();
    const entry: CacheEntry = {
      tool: opts.tool,
      version: opts.version,
      tarball: dst,
      sha256: opts.sha256,
      size: stat.size,
      downloadedAt: ts,
      lastUsedAt: ts,
    };

    const idx = this.readIndex();
    if (!idx[opts.tool]) idx[opts.tool] = {};
    idx[opts.tool]![opts.version] = entry;
    this.writeIndex(idx);

    this.evictIfOverCap(opts.tool, opts.version);
    return entry;
  }

  /** Best-effort delete of one entry. Does not throw on missing. */
  delete(tool: string, version: string): void {
    const idx = this.readIndex();
    const e = idx[tool]?.[version];
    if (!e) return;
    try { fs.unlinkSync(e.tarball); } catch { /* missing is fine */ }
    delete idx[tool]![version];
    if (Object.keys(idx[tool]!).length === 0) delete idx[tool];
    this.writeIndex(idx);
  }

  /** Diagnostic — flat list of all entries newest-first by lastUsedAt. */
  list(): CacheEntry[] {
    const idx = this.readIndex();
    const out: CacheEntry[] = [];
    for (const tool of Object.keys(idx)) {
      for (const version of Object.keys(idx[tool]!)) out.push(idx[tool]![version]!);
    }
    out.sort((a, b) => (a.lastUsedAt < b.lastUsedAt ? 1 : -1));
    return out;
  }

  /** Total bytes occupied across all entries. */
  totalBytes(): number {
    return this.list().reduce((sum, e) => sum + e.size, 0);
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private indexPath(): string { return path.join(this.dir, "index.json"); }

  private readIndex(): Record<string, Record<string, CacheEntry>> {
    const p = this.indexPath();
    if (!fs.existsSync(p)) return {};
    try {
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return {};
      return parsed as Record<string, Record<string, CacheEntry>>;
    } catch {
      // Corrupt index — start fresh. Cache rebuilds itself; safer than
      // throwing, since failure here would block unrelated operations.
      return {};
    }
  }

  private writeIndex(idx: Record<string, Record<string, CacheEntry>>): void {
    fs.writeFileSync(this.indexPath(), JSON.stringify(idx, null, 2) + "\n", "utf8");
  }

  private evictIfOverCap(protectTool: string, protectVersion: string): void {
    let entries = this.list(); // newest-first
    let total = entries.reduce((s, e) => s + e.size, 0);
    if (total <= this.maxBytes) return;

    // Walk from oldest (end of array) to newest, dropping until under cap.
    for (let i = entries.length - 1; i >= 0 && total > this.maxBytes; i--) {
      const e = entries[i]!;
      if (e.tool === protectTool && e.version === protectVersion) continue;
      this.delete(e.tool, e.version);
      total -= e.size;
    }
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

export function defaultCacheDir(plat: PlatformInfo = hostPlatform): string {
  if (plat.isWindows) {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) return path.join(localAppData, "ttm", "Cache", "downloads");
    return path.join(os.homedir(), "AppData", "Local", "ttm", "Cache", "downloads");
  }
  // POSIX: respect XDG_CACHE_HOME, fall back to ~/.cache.
  const xdg = process.env.XDG_CACHE_HOME;
  const cacheRoot = xdg ?? path.join(os.homedir(), ".cache");
  return path.join(cacheRoot, "ttm", "downloads");
}

/** Pick the canonical cache filename keeping the source's archive extension. */
function canonicalFilename(tool: string, version: string, source: string): string {
  const ext = pickArchiveExt(source);
  return `${tool}-${version}${ext}`;
}

/** Return ".tar.gz" / ".zip" / ".tar.xz" / "" inferred from source path. */
export function pickArchiveExt(source: string): string {
  const lower = source.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return ".tar.gz";
  if (lower.endsWith(".tar.xz") || lower.endsWith(".txz")) return ".tar.xz";
  if (lower.endsWith(".zip")) return ".zip";
  // Fall back to whatever single extension is on the source.
  const m = /\.[A-Za-z0-9]+$/.exec(source);
  return m ? m[0]!.toLowerCase() : "";
}
