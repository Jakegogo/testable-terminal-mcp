/**
 * Structured JSON logger.
 *
 * Why JSON to stderr (not pretty text):
 *   - MCP server's stdout is the protocol channel; ANY non-protocol byte on
 *     stdout breaks the client. Logger MUST go to stderr.
 *   - JSON lines are trivially grep / jq / log-aggregator friendly.
 *   - Each entry has a fixed shape: { ts, level, msg, ...fields }.
 *
 * Levels: debug / info / warn / error.
 * Default level: info. Override via `TT_LOG_LEVEL=debug` env.
 *
 * Pretty mode: `TT_LOG_PRETTY=1` → human-readable single-line output for
 * local dev. JSON mode is the default and only mode in CI / MCP.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

interface LoggerOptions {
  level?: LogLevel;
  pretty?: boolean;
  /** Where to write. Defaults to stderr. */
  out?: NodeJS.WritableStream;
  /** Static fields merged into every entry (e.g. session_id). */
  base?: Record<string, unknown>;
  /** Override clock for testing. */
  now?: () => Date;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(extraBase: Record<string, unknown>): Logger;
  setLevel(level: LogLevel): void;
}

/** Pure factory — call with overrides for tests. */
export function createLogger(opts: LoggerOptions = {}): Logger {
  let level: LogLevel = opts.level ?? (process.env.TT_LOG_LEVEL as LogLevel) ?? "info";
  const pretty = opts.pretty ?? process.env.TT_LOG_PRETTY === "1";
  const out = opts.out ?? process.stderr;
  const base = opts.base ?? {};
  const now = opts.now ?? (() => new Date());

  const shouldEmit = (l: LogLevel): boolean => LEVEL_ORDER[l] >= LEVEL_ORDER[level];

  const emit = (l: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (!shouldEmit(l)) return;
    const entry = {
      ts: now().toISOString(),
      level: l,
      msg,
      ...base,
      ...(fields ?? {}),
    };
    if (pretty) {
      const extra = Object.entries(entry)
        .filter(([k]) => k !== "ts" && k !== "level" && k !== "msg")
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
      out.write(`[${entry.ts}] ${l.toUpperCase()} ${msg}${extra ? " " + extra : ""}\n`);
    } else {
      out.write(JSON.stringify(entry) + "\n");
    }
  };

  return {
    debug: (m, f) => emit("debug", m, f),
    info:  (m, f) => emit("info",  m, f),
    warn:  (m, f) => emit("warn",  m, f),
    error: (m, f) => emit("error", m, f),
    child: (extra) => createLogger({ ...opts, level, base: { ...base, ...extra } }),
    setLevel: (l) => { level = l; },
  };
}

/** Module-level default. Most code should grab this; tests inject their own. */
export const logger: Logger = createLogger();
