/**
 * sandbox/seed — populate a freshly-created sandbox path with files.
 *
 * Two layers:
 *   1. Built-in profile (minimal | host-zshrc): creates the standard tree:
 *        bin/, .local/bin/, .aikey/bin/, tmp/
 *      + macOS: Library/Application Support, Library/Caches, Library/Preferences
 *      + host-zshrc: copy host ~/.zshrc / ~/.zprofile / ~/.zshenv (best-effort)
 *      Windows: skip Library/, write Documents/PowerShell/ for profile.ps1.
 *   2. Caller-provided seed:
 *        files: { "<rel-path>": "<content>" }   — overwrite OK
 *        copyFromHost: ["~/.aikey", "~/.ssh"]   — recursive, opaque copy
 *
 * Pure-ish: takes (sandboxPath, profile, seed, platform, hostHome) and only
 * touches the sandbox dir. No registry, no spawning.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PlatformInfo } from "../platform.js";
import type { SandboxProfileName, SandboxSeedConfig } from "../types.js";

// ─── public API ──────────────────────────────────────────────────────────────

export interface ApplyProfileOpts {
  sandboxPath: string;
  profile: SandboxProfileName;
  platform: PlatformInfo;
  /** Resolved host HOME (used by host-zshrc to source dotfiles). */
  hostHome: string;
}

/**
 * Create the sandbox directory tree per the chosen profile.
 *
 * Profile semantics:
 *   minimal     — empty bin/ + .local/bin + .aikey/bin + tmp/, plus
 *                 platform-specific Library/ placeholders (macOS app habit).
 *                 Round 2 R2-5: macOS apps frequently die loudly when
 *                 ~/Library/Application Support/ doesn't exist; pre-creating
 *                 these as empty dirs avoids cargo-cult crashes during tests.
 *   host-zshrc  — minimal + best-effort copy of host's zsh dotfiles, so the
 *                 sandbox shell still has aliases / prompt / completions.
 */
export function applyProfile(opts: ApplyProfileOpts): void {
  const { sandboxPath, profile, platform, hostHome } = opts;
  ensureBaseTree(sandboxPath);
  if (!platform.isWindows) {
    ensureLibraryPlaceholders(sandboxPath);
  } else {
    // Windows: profile.ps1 lives at Documents/PowerShell/Profile.ps1 (pwsh 7+)
    fs.mkdirSync(path.join(sandboxPath, "Documents", "PowerShell"), { recursive: true });
  }
  if (profile === "host-zshrc") {
    copyHostZshDotfiles(hostHome, sandboxPath);
  }
}

export interface ApplySeedOpts {
  sandboxPath: string;
  seed: SandboxSeedConfig;
  /** Used to expand leading `~` in copyFromHost paths. */
  hostHome: string;
}

/** Apply the caller's `files` + `copyFromHost`. Idempotent (overwrites OK). */
export function applySeed(opts: ApplySeedOpts): void {
  const { sandboxPath, seed, hostHome } = opts;
  if (seed.files) {
    for (const [rel, content] of Object.entries(seed.files)) {
      const dst = path.join(sandboxPath, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, content, "utf8");
    }
  }
  if (seed.copyFromHost) {
    for (const src of seed.copyFromHost) {
      const expanded = expandTilde(src, hostHome);
      if (!fs.existsSync(expanded)) continue; // best-effort: missing source = skip
      const base = path.basename(expanded);
      const dst = path.join(sandboxPath, base);
      copyRecursive(expanded, dst);
    }
  }
}

/** Write `_meta.json` describing the sandbox (id/mode/profile/created_at). */
export function writeMeta(opts: {
  sandboxPath: string;
  id: string;
  mode: "ephemeral" | "persistent";
  profile: SandboxProfileName;
  createdAt: Date;
}): void {
  const meta = {
    id: opts.id,
    mode: opts.mode,
    profile: opts.profile,
    created_at: opts.createdAt.toISOString(),
  };
  fs.writeFileSync(path.join(opts.sandboxPath, "_meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");
}

// ─── helpers ────────────────────────────────────────────────────────────────

function ensureBaseTree(sandboxPath: string): void {
  for (const sub of ["bin", ".local/bin", ".aikey/bin", "tmp"]) {
    fs.mkdirSync(path.join(sandboxPath, sub), { recursive: true });
  }
}

function ensureLibraryPlaceholders(sandboxPath: string): void {
  // macOS + Linux: pre-create the three common Library subdirs so apps that
  // habitually expect them under $HOME don't crash when sandboxed.
  for (const sub of ["Library/Application Support", "Library/Caches", "Library/Preferences"]) {
    fs.mkdirSync(path.join(sandboxPath, sub), { recursive: true });
  }
}

function copyHostZshDotfiles(hostHome: string, sandboxPath: string): void {
  for (const name of [".zshrc", ".zprofile", ".zshenv", ".bashrc", ".bash_profile"]) {
    const src = path.join(hostHome, name);
    if (!fs.existsSync(src)) continue;
    try {
      fs.copyFileSync(src, path.join(sandboxPath, name));
    } catch {
      // Best-effort — perms / symlinks / weird states all swallowed.
    }
  }
}

function expandTilde(p: string, hostHome: string): string {
  if (p === "~") return hostHome;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(hostHome, p.slice(2));
  return p;
}

/**
 * Recursively copy src → dst. Symlinks are resolved (we copy contents, not the
 * link); special files (sockets/devices) are skipped.
 *
 * Note: Node 16.7+ has fs.cpSync, but we want the symlink-following + skip
 * special-file behavior controlled, so we walk it ourselves.
 */
function copyRecursive(src: string, dst: string): void {
  const stat = fs.statSync(src); // follows symlinks intentionally
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dst, entry));
    }
  } else if (stat.isFile()) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  // sockets / devices / fifos: skip silently
}

/** Compute the host HOME (POSIX HOME, Windows USERPROFILE). Used by callers. */
export function resolveHostHome(): string {
  return os.homedir();
}
