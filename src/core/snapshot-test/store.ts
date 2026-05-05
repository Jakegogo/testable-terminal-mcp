/**
 * .snap file store — read/write the insta-style snapshot format.
 *
 * Layout per spec §13.1:
 *
 *   ---
 *   name: claude_simple_question
 *   created_at: 2026-05-04T12:00:00Z
 *   updated_at: 2026-05-04T12:30:00Z
 *   session:
 *     command: claude
 *     rows: 40
 *     cols: 120
 *     sandbox: ephemeral
 *   masks:
 *     - { pattern: 'pid=\d+',                replace: 'pid=<MASKED>' }
 *   include_ansi: false
 *   ---
 *   == plain ==
 *   <screen plain text>
 *   == ansi ==                  (only when include_ansi=true)
 *   <screen ansi text with literal escape chars>
 *
 * Why a custom parser instead of `yaml` / `js-yaml`: the frontmatter shape
 * is fixed and small; pulling a YAML library for ~30 lines of structured
 * data adds bundle weight + cognitive overhead. The custom parser is
 * strictly conservative — anything it can't parse is rejected with a
 * structured error rather than silently mis-parsed.
 *
 * On-disk path convention:
 *   <rootDir>/<test-file-id>/<case-name>.snap
 * `.snap.new` is the sibling that gets written on first-run / mismatch.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ErrorCode, TestableTerminalError } from "../errors.js";

// ─── public types ────────────────────────────────────────────────────────────

export interface SnapMask {
  pattern: string;       // regex source (no surrounding `/.../`)
  replace: string;
  flags?: string;        // default "g"
}

export interface SnapMeta {
  name: string;
  createdAt: string;
  updatedAt: string;
  session?: Record<string, unknown>;
  masks: SnapMask[];
  includeAnsi: boolean;
}

export interface SnapFile {
  meta: SnapMeta;
  plain: string;
  ansi: string | null;
}

// ─── public API ──────────────────────────────────────────────────────────────

/** Resolve the on-disk path for a snapshot. */
export function snapshotPath(rootDir: string, testFileId: string, caseName: string): string {
  return path.join(rootDir, sanitize(testFileId), `${sanitize(caseName)}.snap`);
}

/** Resolve the sibling .snap.new path. */
export function pendingPath(snapPath: string): string {
  return `${snapPath}.new`;
}

export function readSnap(filePath: string): SnapFile {
  const raw = fs.readFileSync(filePath, "utf8");
  return parseSnap(raw, filePath);
}

export function writeSnap(filePath: string, snap: SnapFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, formatSnap(snap), "utf8");
}

export function snapExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

// ─── parser ─────────────────────────────────────────────────────────────────

/**
 * Conservative parser. Accepts only the documented frontmatter shape; any
 * unknown key is preserved into `meta.session` if it's nested under
 * `session:`, otherwise treated as a structural error.
 */
export function parseSnap(text: string, source = "<inline>"): SnapFile {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") {
    throw structural(`expected leading "---" frontmatter delimiter (file: ${source})`);
  }
  let i = 1;
  // Find closing "---".
  let endIdx = -1;
  for (; i < lines.length; i++) {
    if (lines[i] === "---") { endIdx = i; break; }
  }
  if (endIdx < 0) {
    throw structural(`unterminated frontmatter (file: ${source})`);
  }
  const meta = parseFrontmatter(lines.slice(1, endIdx), source);

  // Body: section markers `== plain ==` and (optional) `== ansi ==`.
  const body = lines.slice(endIdx + 1);
  const { plain, ansi } = parseBody(body, source);

  // Cross-check: include_ansi=true ⇒ ansi section present (and vice versa).
  if (meta.includeAnsi && ansi === null) {
    throw structural(`include_ansi=true but no "== ansi ==" section (file: ${source})`);
  }
  if (!meta.includeAnsi && ansi !== null) {
    throw structural(`"== ansi ==" section present but include_ansi=false (file: ${source})`);
  }
  return { meta, plain, ansi };
}

function parseFrontmatter(lines: string[], source: string): SnapMeta {
  const meta: SnapMeta = {
    name: "",
    createdAt: "",
    updatedAt: "",
    masks: [],
    includeAnsi: false,
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "" || line.startsWith("#")) { i++; continue; }

    const kv = matchKv(line);
    if (!kv) throw structural(`unrecognized frontmatter line: "${line}" (file: ${source})`);

    switch (kv.key) {
      case "name": meta.name = kv.value; break;
      case "created_at": meta.createdAt = kv.value; break;
      case "updated_at": meta.updatedAt = kv.value; break;
      case "include_ansi": meta.includeAnsi = parseBool(kv.value, "include_ansi", source); break;
      case "session": {
        // Block scalar follows.
        const block = takeIndentedBlock(lines, i + 1);
        meta.session = parseSessionBlock(block.lines, source);
        i = block.next;
        continue;
      }
      case "masks": {
        const block = takeIndentedBlock(lines, i + 1);
        meta.masks = parseMasksBlock(block.lines, source);
        i = block.next;
        continue;
      }
      default:
        throw structural(`unknown frontmatter key: "${kv.key}" (file: ${source})`);
    }
    i++;
  }
  if (!meta.name) throw structural(`frontmatter missing "name" (file: ${source})`);
  return meta;
}

function parseSessionBlock(lines: string[], source: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const kv = matchKv(trimmed);
    if (!kv) throw structural(`unrecognized session line: "${trimmed}" (file: ${source})`);
    out[kv.key] = parseScalar(kv.value);
  }
  return out;
}

function parseMasksBlock(lines: string[], source: string): SnapMask[] {
  const out: SnapMask[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith("- ")) {
      throw structural(`mask entry must start with "- ": "${trimmed}" (file: ${source})`);
    }
    out.push(parseMaskInline(trimmed.slice(2).trim(), source));
  }
  return out;
}

function parseMaskInline(s: string, source: string): SnapMask {
  // Accept only the inline-object form: { pattern: '...', replace: '...', flags?: '...' }
  if (!s.startsWith("{") || !s.endsWith("}")) {
    throw structural(`mask must be inline object form: "${s}" (file: ${source})`);
  }
  const inner = s.slice(1, -1).trim();
  const fields: Record<string, string> = {};
  // Split on commas not inside quotes.
  const parts: string[] = [];
  let buf = "";
  let inSingle = false, inDouble = false;
  for (const ch of inner) {
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === "\"" && !inSingle) inDouble = !inDouble;
    if (ch === "," && !inSingle && !inDouble) { parts.push(buf); buf = ""; continue; }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);

  for (const p of parts) {
    const idx = p.indexOf(":");
    if (idx < 0) throw structural(`mask key:value missing colon: "${p}" (file: ${source})`);
    const k = p.slice(0, idx).trim();
    const vRaw = p.slice(idx + 1).trim();
    fields[k] = unquoteScalar(vRaw);
  }
  if (typeof fields.pattern !== "string" || typeof fields.replace !== "string") {
    throw structural(`mask requires "pattern" and "replace": "${s}" (file: ${source})`);
  }
  const out: SnapMask = { pattern: fields.pattern, replace: fields.replace };
  if (fields.flags !== undefined) out.flags = fields.flags;
  return out;
}

function parseBody(lines: string[], source: string): { plain: string; ansi: string | null } {
  let plain = "";
  let ansi: string | null = null;
  let mode: "none" | "plain" | "ansi" = "none";
  const buf: { plain: string[]; ansi: string[] } = { plain: [], ansi: [] };

  for (const line of lines) {
    if (line === "== plain ==") { mode = "plain"; continue; }
    if (line === "== ansi ==")  { mode = "ansi";  ansi = ""; continue; }
    if (mode === "plain") buf.plain.push(line);
    else if (mode === "ansi") buf.ansi.push(line);
    else if (line.trim() !== "") {
      throw structural(`text before "== plain ==" section: "${line}" (file: ${source})`);
    }
  }
  if (mode === "none") {
    throw structural(`no "== plain ==" section found (file: ${source})`);
  }
  // Trim a single trailing blank line that comes from the file's terminator.
  plain = trimTrailingBlankLine(buf.plain).join("\n");
  if (ansi !== null) ansi = trimTrailingBlankLine(buf.ansi).join("\n");
  return { plain, ansi };
}

// ─── formatter ──────────────────────────────────────────────────────────────

export function formatSnap(snap: SnapFile): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`name: ${snap.meta.name}`);
  lines.push(`created_at: ${snap.meta.createdAt}`);
  lines.push(`updated_at: ${snap.meta.updatedAt}`);
  if (snap.meta.session && Object.keys(snap.meta.session).length > 0) {
    lines.push("session:");
    for (const [k, v] of Object.entries(snap.meta.session)) {
      lines.push(`  ${k}: ${formatScalar(v)}`);
    }
  }
  if (snap.meta.masks.length > 0) {
    lines.push("masks:");
    for (const m of snap.meta.masks) {
      const pieces = [`pattern: ${quote(m.pattern)}`, `replace: ${quote(m.replace)}`];
      if (m.flags) pieces.push(`flags: ${quote(m.flags)}`);
      lines.push(`  - { ${pieces.join(", ")} }`);
    }
  }
  lines.push(`include_ansi: ${snap.meta.includeAnsi ? "true" : "false"}`);
  lines.push("---");
  lines.push("== plain ==");
  lines.push(snap.plain);
  if (snap.meta.includeAnsi && snap.ansi !== null) {
    lines.push("== ansi ==");
    lines.push(snap.ansi);
  }
  // Final newline.
  return lines.join("\n") + "\n";
}

// ─── helpers ────────────────────────────────────────────────────────────────

function matchKv(line: string): { key: string; value: string } | null {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$/.exec(line);
  if (!m) return null;
  return { key: m[1]!, value: m[2]! };
}

function takeIndentedBlock(lines: string[], startIdx: number): { lines: string[]; next: number } {
  const out: string[] = [];
  let i = startIdx;
  while (i < lines.length) {
    const ln = lines[i]!;
    if (ln.startsWith(" ") || ln.startsWith("\t") || ln.trim() === "") {
      out.push(ln);
      i++;
    } else break;
  }
  return { lines: out, next: i };
}

function parseScalar(value: string): string | number | boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  const n = Number(value);
  if (Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(value)) return n;
  return unquoteScalar(value);
}

function unquoteScalar(value: string): string {
  if ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith("\"") && value.endsWith("\""))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseBool(value: string, key: string, source: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw structural(`${key} must be true or false (got "${value}", file: ${source})`);
}

function formatScalar(v: unknown): string {
  if (typeof v === "string") {
    return /^[\w.\-/]+$/.test(v) ? v : quote(v);
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return quote(JSON.stringify(v));
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function trimTrailingBlankLine(lines: string[]): string[] {
  // Drop ALL trailing empty lines. The format step writes section content
  // followed by `\n` between sections, which produces 1-2 trailing empty
  // lines after split. Stripping them all gives a clean round-trip.
  let i = lines.length;
  while (i > 0 && lines[i - 1] === "") i--;
  return lines.slice(0, i);
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

function structural(msg: string): TestableTerminalError {
  return new TestableTerminalError(ErrorCode.SNAPSHOT_STORE_CORRUPT, msg);
}
