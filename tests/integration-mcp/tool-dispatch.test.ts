/**
 * M9 acceptance — MCP tool dispatch.
 *
 * We bypass the SDK's stdio transport (which has its own integration test
 * surface) and call HANDLERS directly with a fresh ToolRegistry. This is
 * exactly what the SDK does internally when a tool fires — schema validate
 * the args + dispatch.
 */

import { describe, it, expect, afterAll, afterEach } from "vitest";
import { HANDLERS, ToolRegistry } from "../../src/adapters/mcp/tools.ts";
import { __resetForTests as resetCleanup } from "../../src/core/process-cleanup.js";
import { __resetForTests as resetMgr } from "../../src/core/sandbox/manager.js";

afterAll(() => { resetCleanup(); });
afterEach(() => { resetMgr(); });

const registry = (): ToolRegistry => new ToolRegistry();
const ctx = (r: ToolRegistry) => ({ registry: r });

const TIMEOUT = 15_000;

describe("MCP — input validation (pure)", () => {
  it("missing required field returns E_TT_INVALID_INPUT", async () => {
    const r = await HANDLERS["terminal.create_session"]({}, ctx(registry()));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error_code).toBe("E_TT_INVALID_INPUT");
      expect(r.message).toMatch(/command/);
    }
  });

  it("type-error on number-as-string returns E_TT_INVALID_INPUT", async () => {
    const r = await HANDLERS["terminal.resize"](
      { session_id: "x", rows: "twenty", cols: 80 },
      ctx(registry()),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe("E_TT_INVALID_INPUT");
  });

  it("session not found returns E_TT_SESSION_NOT_FOUND", async () => {
    const r = await HANDLERS["terminal.write"](
      { session_id: "term_no_such", text: "hi" },
      ctx(registry()),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe("E_TT_SESSION_NOT_FOUND");
  });

  it("sandbox not found returns E_TT_SANDBOX_NOT_FOUND", async () => {
    const r = await HANDLERS["terminal.create_session"](
      { command: "bash", sandbox_id: "sbx_no_such" },
      ctx(registry()),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe("E_TT_SANDBOX_NOT_FOUND");
  });

  it("invalid range type rejected at schema layer", async () => {
    const r = await HANDLERS["terminal.snapshot"](
      { session_id: "x", range: 42 },
      ctx(registry()),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe("E_TT_INVALID_INPUT");
  });
});

describe("MCP — full sequence (create → write → snapshot → close)", () => {
  it("bash sequence end-to-end via HANDLERS", async () => {
    const reg = registry();
    const c = ctx(reg);

    const create = await HANDLERS["terminal.create_session"](
      { command: "bash", rows: 24, cols: 80 },
      c,
    );
    expect(create.ok).toBe(true);
    if (!create.ok) throw new Error("create failed");
    const session_id = create.session_id as string;

    const expectPrompt = await HANDLERS["terminal.expect_regex"](
      { session_id, pattern: "\\$\\s", timeout_ms: 3000 },
      c,
    );
    expect(expectPrompt.ok).toBe(true);

    const write = await HANDLERS["terminal.write"](
      { session_id, text: "echo MCP_PROBE\n" },
      c,
    );
    expect(write.ok).toBe(true);

    const expectEcho = await HANDLERS["terminal.expect_text"](
      { session_id, text: "MCP_PROBE", timeout_ms: 3000 },
      c,
    );
    expect(expectEcho.ok).toBe(true);

    const snapshot = await HANDLERS["terminal.snapshot"](
      { session_id, range: "viewport" },
      c,
    );
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.text).toContain("MCP_PROBE");
      expect(snapshot.range).toBeDefined();
    }

    const history = await HANDLERS["terminal.get_history"](
      { session_id, format: "clean" },
      c,
    );
    expect(history.ok).toBe(true);
    if (history.ok) expect(history.content).toContain("MCP_PROBE");

    const close = await HANDLERS["terminal.close_session"](
      { session_id },
      c,
    );
    expect(close.ok).toBe(true);
    expect(reg.size()).toBe(0);
  }, TIMEOUT);
});

describe("MCP — sandbox + env_snapshot integration", () => {
  it("sandbox.create + create_session(sandbox_id) + env_snapshot + assert_env_no_path_duplicates", async () => {
    const reg = registry();
    const c = ctx(reg);

    const sb = await HANDLERS["sandbox.create"](
      { mode: "ephemeral", profile: "minimal" },
      c,
    );
    expect(sb.ok).toBe(true);
    if (!sb.ok) throw new Error("sandbox.create failed");
    const sandbox_id = sb.id as string;

    const create = await HANDLERS["terminal.create_session"](
      { command: "bash", sandbox_id },
      c,
    );
    expect(create.ok).toBe(true);
    if (!create.ok) throw new Error("create failed");
    const session_id = create.session_id as string;

    const expectPrompt = await HANDLERS["terminal.expect_regex"](
      { session_id, pattern: "\\$\\s", timeout_ms: 3000 },
      c,
    );
    expect(expectPrompt.ok).toBe(true);

    const snapshot = await HANDLERS["terminal.env_snapshot"](
      { session_id, name: "after-spawn", mode: "fresh-login" },
      c,
    );
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      const env = snapshot.env as Record<string, string>;
      expect(env.HOME).toBeDefined();
    }

    const noDup = await HANDLERS["assert.env_no_path_duplicates"](
      { session_id, snapshot_name: "after-spawn" },
      c,
    );
    expect(noDup.ok).toBe(true);

    await HANDLERS["terminal.close_session"]({ session_id }, c);
    await HANDLERS["sandbox.destroy"]({ sandbox_id }, c);
  }, TIMEOUT);
});

describe("MCP — error propagation", () => {
  it("expect_text timeout returns E_TT_EXPECT_TIMEOUT (not throw)", async () => {
    const reg = registry();
    const c = ctx(reg);

    const create = await HANDLERS["terminal.create_session"]({ command: "bash" }, c);
    if (!create.ok) throw new Error("create failed");
    const session_id = create.session_id as string;

    try {
      const r = await HANDLERS["terminal.expect_text"](
        { session_id, text: "ZZZ_NEVER_APPEARS", timeout_ms: 200 },
        c,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error_code).toBe("E_TT_EXPECT_TIMEOUT");
    } finally {
      await HANDLERS["terminal.close_session"]({ session_id }, c);
    }
  }, TIMEOUT);
});
