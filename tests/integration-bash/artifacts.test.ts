/**
 * Live-session artifact-dump integration test.
 *
 * Spawns a real bash session, runs a few commands, calls dumpArtifacts(),
 * and verifies the directory contains:
 *   - the 6 mandatory files
 *   - meta.json reflects the actual session id, exit code, dims
 *   - events.jsonl includes session.created, output.data, input.write
 *   - env.json has the secret-shape value redacted
 *   - clean.log is grep-friendly text containing what was printed
 */

import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startSession } from "../../src/core/terminal-session.js";
import { __resetForTests as resetCleanup } from "../../src/core/process-cleanup.js";

afterAll(() => { resetCleanup(); });

let outDir: string;
beforeEach(() => { outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttm-art-int-")); });
afterEach(() => { fs.rmSync(outDir, { recursive: true, force: true }); });

describe("bash integration — dumpArtifacts (live session)", () => {
  it("dumps 6 files reflecting real session state + redacts secret env", async () => {
    const session = await startSession({
      command: "bash",
      rows: 24, cols: 80,
      env: {
        // This is caller-supplied env; it gets dumped to env.json (redacted).
        ANTHROPIC_API_KEY: "sk-ant-not-a-real-key",
        SOME_PUBLIC_VAR: "public-value",
      },
    });

    try {
      await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
      session.write("echo ARTIFACT_DUMP_PROBE\n");
      await session.waitForRegex(/ARTIFACT_DUMP_PROBE/, { timeoutMs: 3_000 });

      const dump = session.dumpArtifacts({ dir: outDir });
      expect(dump.dir).toBe(outDir);
      expect(dump.files.sort()).toEqual([
        "clean.log", "env.json", "events.jsonl", "meta.json", "raw.log", "screen.txt",
      ]);

      // clean.log must contain the echoed marker (grep-friendliness goal).
      const clean = fs.readFileSync(path.join(outDir, "clean.log"), "utf8");
      expect(clean).toContain("ARTIFACT_DUMP_PROBE");

      // env.json: caller-secret redacted, public var preserved verbatim.
      const env = JSON.parse(fs.readFileSync(path.join(outDir, "env.json"), "utf8"));
      expect(env.ANTHROPIC_API_KEY).toBe("***REDACTED***");
      expect(env.SOME_PUBLIC_VAR).toBe("public-value");

      // meta.json: command + dims reflect real spawn.
      const meta = JSON.parse(fs.readFileSync(path.join(outDir, "meta.json"), "utf8"));
      expect(meta.command).toBe("bash");
      expect(meta.rows).toBe(24);
      expect(meta.cols).toBe(80);
      expect(meta.session_id).toMatch(/^term_/);
      // Status while still running; we haven't closed yet.
      expect(["running", "exited", "killed"]).toContain(meta.status);

      // events.jsonl: at minimum session.created, session.started, output.data, input.write present.
      const lines = fs.readFileSync(path.join(outDir, "events.jsonl"), "utf8")
        .split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const types = new Set(lines.map((e) => e.type));
      expect(types.has("session.created")).toBe(true);
      expect(types.has("session.started")).toBe(true);
      expect(types.has("output.data")).toBe(true);
      expect(types.has("input.write")).toBe(true);
    } finally {
      await session.close();
    }
  }, 15_000);

  it("includes screen.ansi.txt only when includeAnsiSnapshot=true", async () => {
    const session = await startSession({ command: "bash" });
    try {
      await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
      session.write("printf '\\033[32mGREEN\\033[0m\\n'\n");
      await session.waitForRegex(/GREEN/, { timeoutMs: 3_000 });

      const subDir = path.join(outDir, "with-ansi");
      session.dumpArtifacts({ dir: subDir, includeAnsiSnapshot: true });
      expect(fs.existsSync(path.join(subDir, "screen.ansi.txt"))).toBe(true);
      const ansi = fs.readFileSync(path.join(subDir, "screen.ansi.txt"), "utf8");
      expect(ansi).toMatch(/\x1b\[/);
    } finally {
      await session.close();
    }
  }, 10_000);

  it("after close(), meta.status reflects exited/killed and exit_code is set", async () => {
    const session = await startSession({ command: "bash" });
    await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
    session.write("exit 0\n");
    await session.waitForExit({ timeoutMs: 3_000 });

    const dump = session.dumpArtifacts({ dir: outDir });
    expect(dump.files).toContain("meta.json");
    const meta = JSON.parse(fs.readFileSync(path.join(outDir, "meta.json"), "utf8"));
    expect(meta.status).toBe("exited");
    expect(meta.exit_code).toBe(0);

    // Events should include process.exit by now.
    const lines = fs.readFileSync(path.join(outDir, "events.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.some((e) => e.type === "process.exit")).toBe(true);
  }, 10_000);

  it("default outDir (no opts.dir) creates a unique timestamped dir under os.tmpdir()", async () => {
    const session = await startSession({ command: "bash" });
    let actualDir: string | null = null;
    try {
      await session.waitForRegex(/\$\s/, { timeoutMs: 3_000 });
      const dump = session.dumpArtifacts();
      actualDir = dump.dir;
      expect(dump.dir.startsWith(path.join(os.tmpdir(), "ttm-artifacts"))).toBe(true);
      expect(fs.existsSync(path.join(dump.dir, "raw.log"))).toBe(true);
    } finally {
      await session.close();
      if (actualDir) fs.rmSync(actualDir, { recursive: true, force: true });
    }
  }, 10_000);
});
