/**
 * Unit tests for sandbox/seed.ts.
 *
 * applyProfile + applySeed + writeMeta — pure fs ops, no PTY needed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyProfile, applySeed, writeMeta, resolveHostHome } from "../../src/core/sandbox/seed.js";
import { inferPlatform } from "../../src/core/platform.js";

const POSIX = inferPlatform("darwin", "arm64");
const WIN = inferPlatform("win32", "x64");

let sandboxPath: string;
let hostHome: string;
beforeEach(() => {
  sandboxPath = fs.mkdtempSync(path.join(os.tmpdir(), "ttm-seed-test-"));
  hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "ttm-seed-host-"));
});
afterEach(() => {
  fs.rmSync(sandboxPath, { recursive: true, force: true });
  fs.rmSync(hostHome, { recursive: true, force: true });
});

describe("applyProfile — minimal", () => {
  it("creates standard tree on POSIX", () => {
    applyProfile({ sandboxPath, profile: "minimal", platform: POSIX, hostHome });
    expect(fs.existsSync(path.join(sandboxPath, "bin"))).toBe(true);
    expect(fs.existsSync(path.join(sandboxPath, ".local/bin"))).toBe(true);
    expect(fs.existsSync(path.join(sandboxPath, ".aikey/bin"))).toBe(true);
    expect(fs.existsSync(path.join(sandboxPath, "tmp"))).toBe(true);
  });

  it("creates Library placeholders on POSIX (round 2 R2-5)", () => {
    applyProfile({ sandboxPath, profile: "minimal", platform: POSIX, hostHome });
    expect(fs.existsSync(path.join(sandboxPath, "Library/Application Support"))).toBe(true);
    expect(fs.existsSync(path.join(sandboxPath, "Library/Caches"))).toBe(true);
    expect(fs.existsSync(path.join(sandboxPath, "Library/Preferences"))).toBe(true);
  });

  it("skips Library/ on Windows, creates Documents/PowerShell instead", () => {
    applyProfile({ sandboxPath, profile: "minimal", platform: WIN, hostHome });
    expect(fs.existsSync(path.join(sandboxPath, "Library"))).toBe(false);
    expect(fs.existsSync(path.join(sandboxPath, "Documents/PowerShell"))).toBe(true);
  });

  it("does not create .zshrc / .bashrc by default (minimal = empty)", () => {
    applyProfile({ sandboxPath, profile: "minimal", platform: POSIX, hostHome });
    expect(fs.existsSync(path.join(sandboxPath, ".zshrc"))).toBe(false);
    expect(fs.existsSync(path.join(sandboxPath, ".bashrc"))).toBe(false);
  });
});

describe("applyProfile — host-zshrc", () => {
  it("copies host's .zshrc / .zprofile / .zshenv when present", () => {
    fs.writeFileSync(path.join(hostHome, ".zshrc"), 'export FROM_HOST="zshrc"\n');
    fs.writeFileSync(path.join(hostHome, ".zprofile"), 'export FROM_HOST_PROFILE="x"\n');
    applyProfile({ sandboxPath, profile: "host-zshrc", platform: POSIX, hostHome });
    expect(fs.readFileSync(path.join(sandboxPath, ".zshrc"), "utf8")).toContain("FROM_HOST");
    expect(fs.readFileSync(path.join(sandboxPath, ".zprofile"), "utf8")).toContain("FROM_HOST_PROFILE");
  });

  it("missing host dotfiles are silently skipped (best-effort)", () => {
    // hostHome is empty; should not throw.
    expect(() => applyProfile({ sandboxPath, profile: "host-zshrc", platform: POSIX, hostHome })).not.toThrow();
  });
});

describe("applySeed", () => {
  beforeEach(() => {
    applyProfile({ sandboxPath, profile: "minimal", platform: POSIX, hostHome });
  });

  it("writes files with correct content + creates parent dirs", () => {
    applySeed({
      sandboxPath,
      hostHome,
      seed: { files: { ".zshrc": "export X=1\n", "subdir/note.txt": "hello" } },
    });
    expect(fs.readFileSync(path.join(sandboxPath, ".zshrc"), "utf8")).toBe("export X=1\n");
    expect(fs.readFileSync(path.join(sandboxPath, "subdir/note.txt"), "utf8")).toBe("hello");
  });

  it("overwrites existing seed files (idempotent)", () => {
    fs.writeFileSync(path.join(sandboxPath, ".zshrc"), "old");
    applySeed({ sandboxPath, hostHome, seed: { files: { ".zshrc": "new" } } });
    expect(fs.readFileSync(path.join(sandboxPath, ".zshrc"), "utf8")).toBe("new");
  });

  it("copyFromHost recursively copies a host directory (~ expansion)", () => {
    fs.mkdirSync(path.join(hostHome, ".aikey", "bin"), { recursive: true });
    fs.writeFileSync(path.join(hostHome, ".aikey", "config.json"), '{"v":1}');
    fs.writeFileSync(path.join(hostHome, ".aikey", "bin", "aikey"), "#!/bin/sh\nexit 0\n");

    applySeed({ sandboxPath, hostHome, seed: { copyFromHost: ["~/.aikey"] } });
    expect(fs.existsSync(path.join(sandboxPath, ".aikey/config.json"))).toBe(true);
    expect(fs.existsSync(path.join(sandboxPath, ".aikey/bin/aikey"))).toBe(true);
    expect(fs.readFileSync(path.join(sandboxPath, ".aikey/config.json"), "utf8")).toBe('{"v":1}');
  });

  it("copyFromHost silently skips missing source (best-effort)", () => {
    expect(() => applySeed({
      sandboxPath, hostHome, seed: { copyFromHost: ["~/.does-not-exist"] },
    })).not.toThrow();
  });
});

describe("writeMeta", () => {
  it("writes _meta.json with id/mode/profile/created_at", () => {
    const created = new Date("2026-05-04T10:00:00.000Z");
    writeMeta({ sandboxPath, id: "sbx_123", mode: "ephemeral", profile: "minimal", createdAt: created });
    const meta = JSON.parse(fs.readFileSync(path.join(sandboxPath, "_meta.json"), "utf8"));
    expect(meta).toEqual({
      id: "sbx_123",
      mode: "ephemeral",
      profile: "minimal",
      created_at: created.toISOString(),
    });
  });
});

describe("resolveHostHome", () => {
  it("returns os.homedir()", () => {
    expect(resolveHostHome()).toBe(os.homedir());
  });
});
