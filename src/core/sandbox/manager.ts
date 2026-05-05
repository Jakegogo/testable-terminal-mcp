/**
 * sandbox manager — lifecycle + registry.
 *
 * Responsibilities:
 *   create()                — mkdtemp (ephemeral) or use opts.path (persistent),
 *                             apply profile + seed, register, write _meta.json
 *   destroy(id)             — ephemeral: rm -rf; persistent: just unregister
 *   cleanupEphemeral()      — best-effort destroy of every ephemeral sandbox.
 *                             Used by signal hooks + tests + final-bail.
 *   list() / get(id)        — diagnostic
 *
 * Concurrency:
 *   Reaching `maxConcurrentSandboxes` throws E_TT_SANDBOX_LIMIT — caller must
 *   destroy something first. Persistent sandboxes count too (they hold an
 *   entry in the registry; destroying them just unregisters).
 *
 * Signal-cleanup integration: the manager registers a process-exit hook that
 * runs cleanupEphemeral() so a SIGINT / process crash doesn't leak temp dirs.
 * Tests can use __resetForTests() to clear the registry between runs.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ErrorCode, TestableTerminalError } from "../errors.js";
import { newShortId } from "../../utils/id.js";
import { logger } from "../../utils/logger.js";
import { platform as hostPlatform, type PlatformInfo } from "../platform.js";
import { applyProfile, applySeed, resolveHostHome, writeMeta } from "./seed.js";
import type { SandboxConfig, SandboxRef } from "../types.js";

// ─── module state ────────────────────────────────────────────────────────────

interface RegistryEntry {
  ref: SandboxRef;
}

const registry = new Map<string, RegistryEntry>();
let signalHooksInstalled = false;

// ─── config ──────────────────────────────────────────────────────────────────

export interface ManagerConfig {
  /** Cap on registered sandboxes (ephemeral + persistent). */
  maxConcurrentSandboxes: number;
  /** Where ephemeral sandboxes get mkdtemp'd. Default os.tmpdir(). */
  rootDir?: string | null;
  /** For tests: skip installing process exit hook. */
  skipSignalHooks?: boolean;
  /** For tests: override platform branch. */
  platform?: PlatformInfo;
}

const DEFAULT_MANAGER: Required<Pick<ManagerConfig, "maxConcurrentSandboxes">> = {
  maxConcurrentSandboxes: 16,
};

// ─── public API ──────────────────────────────────────────────────────────────

export interface CreateOptions {
  config: SandboxConfig;
  manager?: ManagerConfig;
}

/**
 * Create + register a sandbox. mkdtemp for ephemeral, mkdirSync for persistent.
 *
 * Throws:
 *   E_TT_INVALID_INPUT        — mode=persistent but no `path`
 *   E_TT_SANDBOX_LIMIT        — registry already at maxConcurrentSandboxes
 *   E_TT_SANDBOX_CREATE_FAILED — fs error during mkdtemp / mkdirSync / seed
 */
export function createSandbox(opts: CreateOptions): SandboxRef {
  const cfg = opts.config;
  const mgrCfg: ManagerConfig = opts.manager ?? { maxConcurrentSandboxes: DEFAULT_MANAGER.maxConcurrentSandboxes };
  const max = mgrCfg.maxConcurrentSandboxes ?? DEFAULT_MANAGER.maxConcurrentSandboxes;
  const plat = mgrCfg.platform ?? hostPlatform;

  if (registry.size >= max) {
    throw new TestableTerminalError(
      ErrorCode.SANDBOX_LIMIT,
      `sandbox registry full (${registry.size}/${max})`,
      { hint: "destroy unused sandboxes or raise sandbox.maxConcurrentSandboxes", current: registry.size, max },
    );
  }

  if (cfg.mode === "persistent" && !cfg.path) {
    throw new TestableTerminalError(
      ErrorCode.INVALID_INPUT,
      "persistent sandbox requires `path`",
      { hint: "set SandboxConfig.path to a writable directory" },
    );
  }

  const id = newShortId("sbx_");
  const profile = cfg.profile ?? "minimal";
  const hostHome = resolveHostHome();

  let sandboxPath: string;
  try {
    if (cfg.mode === "ephemeral") {
      const root = mgrCfg.rootDir ?? os.tmpdir();
      fs.mkdirSync(root, { recursive: true });
      sandboxPath = fs.mkdtempSync(path.join(root, "ttm-sbx-"));
    } else {
      sandboxPath = cfg.path!;
      fs.mkdirSync(sandboxPath, { recursive: true });
    }

    applyProfile({ sandboxPath, profile, platform: plat, hostHome });
    if (cfg.seed) {
      applySeed({ sandboxPath, seed: cfg.seed, hostHome });
    }
    writeMeta({ sandboxPath, id, mode: cfg.mode, profile, createdAt: new Date() });
  } catch (err) {
    if (err instanceof TestableTerminalError) throw err;
    throw new TestableTerminalError(
      ErrorCode.SANDBOX_CREATE_FAILED,
      `failed to create sandbox: ${(err as Error).message}`,
      { mode: cfg.mode, cause: (err as Error).message },
    );
  }

  const ref: SandboxRef = {
    id,
    path: sandboxPath,
    mode: cfg.mode,
    profile,
    createdAt: new Date(),
  };
  registry.set(id, { ref });

  if (!mgrCfg.skipSignalHooks) ensureSignalHooks();

  return ref;
}

/**
 * Destroy a sandbox.
 *   ephemeral  → rm -rf, then unregister
 *   persistent → unregister only (caller owns the dir)
 *
 * Idempotent: destroying an unknown id is a no-op (warn logged).
 */
export function destroySandbox(id: string): void {
  const entry = registry.get(id);
  if (!entry) {
    logger.warn("sandbox.destroy_unknown", { id });
    return;
  }
  const { ref } = entry;
  registry.delete(id);
  if (ref.mode === "ephemeral") {
    try {
      fs.rmSync(ref.path, { recursive: true, force: true });
    } catch (err) {
      logger.warn("sandbox.destroy_rm_failed", { id, path: ref.path, error: (err as Error).message });
    }
  }
}

/** Best-effort: destroy every ephemeral sandbox. Returns the count destroyed. */
export function cleanupEphemeral(): number {
  let n = 0;
  for (const [id, { ref }] of [...registry.entries()]) {
    if (ref.mode === "ephemeral") {
      destroySandbox(id);
      n++;
    }
  }
  return n;
}

export function getSandbox(id: string): SandboxRef | null {
  return registry.get(id)?.ref ?? null;
}

export function listSandboxes(): SandboxRef[] {
  return [...registry.values()].map((e) => e.ref);
}

export function sandboxCount(): number {
  return registry.size;
}

/** Reset state. **Tests only.** Does NOT remove process listeners. */
export function __resetForTests(): void {
  // Best-effort: unlink any ephemeral dirs left in registry (test isolation).
  for (const { ref } of registry.values()) {
    if (ref.mode === "ephemeral") {
      try { fs.rmSync(ref.path, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  registry.clear();
}

// ─── signal hook ────────────────────────────────────────────────────────────

function ensureSignalHooks(): void {
  if (signalHooksInstalled) return;
  signalHooksInstalled = true;

  const cleanup = (signal: string): void => {
    const n = cleanupEphemeral();
    if (n > 0) logger.info("sandbox.cleanup", { signal, destroyed: n });
  };

  // Note: SIGINT/SIGTERM also call process.exit in process-cleanup.ts.
  // beforeExit fires before normal exits; both paths converge through
  // cleanupEphemeral() which is idempotent.
  process.on("beforeExit", () => cleanup("beforeExit"));
  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));
}
