/**
 * Error codes and the unified error type for testable-terminal-mcp.
 *
 * Naming convention (round 12 self-review P2 #11 — codified here):
 *
 *   *_FAILED         — IO / system-level failure (spawn, write, exec, fs)
 *   *_TIMEOUT        — caller waited longer than budget; partial state may be available
 *   *_NOT_ALLOWED    — policy / security rejection
 *   *_NOT_FOUND      — referenced resource doesn't exist
 *   *_LIMIT          — resource cap hit (max sessions, max output, cache size)
 *   *_INVALID        — input shape valid but semantically wrong
 *   *_CRASHED        — supervised process died unexpectedly (distinct from clean exit)
 *
 * All codes have prefix `E_TT_` (Testable Terminal). Adding a new code is a
 * minor-version bump; renaming/removing one is a major-version bump and
 * requires a migration note in CHANGELOG.
 */

export enum ErrorCode {
  // ── Business / policy ──
  CMD_NOT_ALLOWED               = "E_TT_CMD_NOT_ALLOWED",
  CWD_NOT_ALLOWED               = "E_TT_CWD_NOT_ALLOWED",
  ENV_KEY_NOT_ALLOWED           = "E_TT_ENV_KEY_NOT_ALLOWED",
  SESSION_NOT_FOUND             = "E_TT_SESSION_NOT_FOUND",
  SESSION_LIMIT                 = "E_TT_SESSION_LIMIT",
  INVALID_INPUT                 = "E_TT_INVALID_INPUT",

  // ── Runtime ──
  EXPECT_TIMEOUT                = "E_TT_EXPECT_TIMEOUT",
  EXPECT_IDLE_TIMEOUT           = "E_TT_EXPECT_IDLE_TIMEOUT",
  EXPECT_CHANGE_TIMEOUT         = "E_TT_EXPECT_CHANGE_TIMEOUT",
  WAIT_EXIT_TIMEOUT             = "E_TT_WAIT_EXIT_TIMEOUT",
  OUTPUT_LIMIT                  = "E_TT_OUTPUT_LIMIT",
  SESSION_TIMEOUT               = "E_TT_SESSION_TIMEOUT",
  SESSION_IDLE_TIMEOUT          = "E_TT_SESSION_IDLE_TIMEOUT",
  SESSION_DEAD                  = "E_TT_SESSION_DEAD",

  // ── System / lower-level ──
  PTY_SPAWN_FAILED              = "E_TT_PTY_SPAWN_FAILED",
  PTY_CRASHED                   = "E_TT_PTY_CRASHED",
  ARTIFACT_WRITE_FAILED         = "E_TT_ARTIFACT_WRITE_FAILED",
  CONFIG_INVALID                = "E_TT_CONFIG_INVALID",
  COMMAND_NOT_FOUND             = "E_TT_COMMAND_NOT_FOUND",

  // ── Sandbox ──
  SANDBOX_NOT_FOUND             = "E_TT_SANDBOX_NOT_FOUND",
  SANDBOX_CREATE_FAILED         = "E_TT_SANDBOX_CREATE_FAILED",
  SANDBOX_AIKEY_MAKEFILE_DIR_MISSING = "E_TT_SANDBOX_AIKEY_MAKEFILE_DIR_MISSING",
  SANDBOX_AIKEY_INIT_FAILED     = "E_TT_SANDBOX_AIKEY_INIT_FAILED",
  SANDBOX_SEED_FAILED           = "E_TT_SANDBOX_SEED_FAILED",
  SANDBOX_LIMIT                 = "E_TT_SANDBOX_LIMIT",

  // ── Multi-version install ──
  VERSION_NOT_FOUND             = "E_TT_VERSION_NOT_FOUND",
  VERSION_DOWNLOAD_FAILED       = "E_TT_VERSION_DOWNLOAD_FAILED",
  VERSION_CHECKSUM_MISMATCH     = "E_TT_VERSION_CHECKSUM_MISMATCH",
  VERSION_EXTRACT_FAILED        = "E_TT_VERSION_EXTRACT_FAILED",

  // ── Snapshot test ──
  SNAPSHOT_PENDING              = "E_TT_SNAPSHOT_PENDING",
  SNAPSHOT_MISMATCH             = "E_TT_SNAPSHOT_MISMATCH",
  SNAPSHOT_STORE_CORRUPT        = "E_TT_SNAPSHOT_STORE_CORRUPT",

  // ── Install-test toolkit (round 2 + 7) ──
  ENV_SNAPSHOT_FAILED           = "E_TT_ENV_SNAPSHOT_FAILED",
  ENV_SNAPSHOT_NOT_FOUND        = "E_TT_ENV_SNAPSHOT_NOT_FOUND",
  FRESH_LOGIN_FAILED            = "E_TT_FRESH_LOGIN_FAILED",
  ASSERT_PATH_DUPLICATES        = "E_TT_ASSERT_PATH_DUPLICATES",
  ASSERT_ENV_DIFF               = "E_TT_ASSERT_ENV_DIFF",
  ASSERT_FILE_CHANGED           = "E_TT_ASSERT_FILE_CHANGED",
  ASSERT_NOT_IDEMPOTENT         = "E_TT_ASSERT_NOT_IDEMPOTENT",
  ASSERT_OUTSIDE_LEAK           = "E_TT_ASSERT_OUTSIDE_LEAK",
}

/**
 * Optional `details` payload attached to errors. Convention:
 *   - `snapshot`: when expect-class fails, the screen at timeout (debugging)
 *   - `hint`: actionable next step in user's own language
 *   - any other key is contextual to the error type
 */
export interface TestableTerminalErrorDetails {
  snapshot?: unknown;
  hint?: string;
  [key: string]: unknown;
}

export class TestableTerminalError extends Error {
  readonly code: ErrorCode;
  readonly details: TestableTerminalErrorDetails;

  constructor(code: ErrorCode, message: string, details: TestableTerminalErrorDetails = {}) {
    super(message);
    this.name = "TestableTerminalError";
    this.code = code;
    this.details = details;
    // Keep the V8 stack trace clean (drop this constructor frame).
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, TestableTerminalError);
    }
  }

  /** JSON-serializable shape for MCP/YAML/log envelopes. */
  toJSON(): { ok: false; error_code: ErrorCode; message: string; hint?: string; details: Record<string, unknown> } {
    const { hint, snapshot: _snapshot, ...rest } = this.details;
    // Strip snapshot from default JSON; callers that want it pass include_snapshot.
    return {
      ok: false,
      error_code: this.code,
      message: this.message,
      ...(hint !== undefined ? { hint } : {}),
      details: rest,
    };
  }

  /** When a caller wants to expose the partial snapshot too. */
  toJSONWithSnapshot(): ReturnType<typeof this.toJSON> & { snapshot?: unknown } {
    const base = this.toJSON();
    if (this.details.snapshot !== undefined) {
      return { ...base, snapshot: this.details.snapshot };
    }
    return base;
  }
}

/** Type guard: does an unknown thrown value carry our error shape? */
export function isTestableTerminalError(e: unknown): e is TestableTerminalError {
  return e instanceof TestableTerminalError;
}
