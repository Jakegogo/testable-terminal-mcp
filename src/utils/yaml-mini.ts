/**
 * yaml-mini — strict-subset YAML parser sized for ttm test cases.
 *
 * Why we don't pull `yaml`/`js-yaml`: M7's snapshot store taught us that the
 * subset we actually need is small (top-level mapping, sequences of
 * mappings, inline objects, scalars). Pulling a 150KB dependency for that
 * adds bundle weight and a security surface we don't otherwise touch.
 *
 * What we accept (and reject everything else with a structural error):
 *   - Top-level mapping with `key: value` lines
 *   - Indented child mappings (2 spaces per level)
 *   - Sequences: lines starting with `- ` containing scalars, inline
 *     objects `{ key: value, ... }`, or block mappings (subsequent indented
 *     keys)
 *   - Scalars: strings (single-quoted, double-quoted, or bare),
 *     numbers (signed integers / floats), booleans (true/false), null
 *   - Comments: `# ...` to end of line
 *
 * What we DON'T accept (would silently mis-parse if we tried):
 *   - Multi-document streams (`---` separators)
 *   - Anchors / aliases (`&foo`, `*foo`)
 *   - Tagged scalars (`!!int`)
 *   - Folded / literal block scalars (`>` / `|`)
 *   - Tabs as indentation (spaces only)
 *
 * Tests in tests/unit/yaml-mini.test.ts cover the accepted cases + reject
 * cases for the unsupported features (so we fail loud, not silent).
 */

// ─── public types ────────────────────────────────────────────────────────────

export type YamlValue = string | number | boolean | null | YamlMap | YamlList;
export interface YamlMap { [key: string]: YamlValue }
export type YamlList = YamlValue[];

export class YamlParseError extends Error {
  readonly line: number;
  readonly column: number;
  constructor(message: string, line: number, column = 0) {
    super(`yaml-mini: ${message} (at line ${line}${column ? `, col ${column}` : ""})`);
    this.line = line;
    this.column = column;
  }
}

// ─── public API ──────────────────────────────────────────────────────────────

export function parseYaml(text: string): YamlValue {
  const lines = text.split(/\r?\n/);
  // Strip comments + measure indents.
  const stripped = lines.map((raw, idx) => stripComment(raw, idx + 1));
  // Drop trailing blank lines for a tidy parse.
  let end = stripped.length;
  while (end > 0 && stripped[end - 1]!.text.trim() === "") end--;
  return parseBlock(stripped.slice(0, end), 0, 0).value;
}

// ─── parser core ────────────────────────────────────────────────────────────

interface Line {
  text: string;       // text with comment stripped, untrimmed
  rawNum: number;     // 1-based source line number
  indent: number;     // count of leading spaces (tabs are an error)
}

function stripComment(raw: string, rawNum: number): Line {
  // Remove unquoted `#` comments. Quoted hashes (inside '...' or "...") survive.
  let out = "";
  let inSingle = false, inDouble = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === "\"" && !inSingle) inDouble = !inDouble;
    if (ch === "#" && !inSingle && !inDouble) break;
    out += ch;
  }
  // Detect tabs.
  if (/^\s*\t/.test(out)) {
    throw new YamlParseError("tabs not supported as indentation; use spaces", rawNum);
  }
  return { text: out.replace(/\s+$/, ""), rawNum, indent: leadingSpaces(out) };
}

function leadingSpaces(s: string): number {
  let n = 0;
  while (n < s.length && s[n] === " ") n++;
  return n;
}

interface BlockResult { value: YamlValue; nextIdx: number }

/**
 * Parse a block starting at `lines[idx]` whose minimum indent is `minIndent`.
 *
 * The actual block indent is auto-detected from the first non-blank line's
 * indent (so callers can pass `parent + 2` as a floor without dictating the
 * exact value — real YAML allows deeper nesting). Returns the value + the
 * index of the first line not consumed.
 */
function parseBlock(lines: Line[], idx: number, minIndent: number): BlockResult {
  while (idx < lines.length && lines[idx]!.text.trim() === "") idx++;
  if (idx >= lines.length) return { value: null, nextIdx: idx };

  const first = lines[idx]!;
  if (first.indent < minIndent) return { value: null, nextIdx: idx };

  // Use the first line's actual indent as the block indent.
  const actualIndent = first.indent;
  if (isListItem(first, actualIndent)) return parseList(lines, idx, actualIndent);
  return parseMap(lines, idx, actualIndent);
}

function isListItem(line: Line, indent: number): boolean {
  return line.indent === indent && /^- (\s|$|.*)/.test(line.text.slice(indent));
}

// ─── mapping ────────────────────────────────────────────────────────────────

function parseMap(lines: Line[], idx: number, indent: number): BlockResult {
  const map: YamlMap = {};
  let i = idx;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.text.trim() === "") { i++; continue; }
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new YamlParseError(`unexpected indent (got ${line.indent}, expected ${indent})`, line.rawNum, line.indent);
    }
    if (isListItem(line, indent)) {
      throw new YamlParseError("unexpected list item where mapping expected", line.rawNum);
    }
    const colonAt = findUnquotedColon(line.text, indent);
    if (colonAt < 0) {
      throw new YamlParseError(`expected "key: value" mapping, got "${line.text.trim()}"`, line.rawNum);
    }
    const key = unquoteScalar(line.text.slice(indent, colonAt).trim());
    const valuePart = line.text.slice(colonAt + 1).trim();
    if (typeof key !== "string") {
      throw new YamlParseError(`mapping key must be a string, got ${JSON.stringify(key)}`, line.rawNum);
    }
    if (valuePart === "") {
      // Block-scalar value follows on next indented lines.
      const child = parseBlock(lines, i + 1, indent + 2);
      map[key] = child.value;
      i = child.nextIdx;
      continue;
    }
    map[key] = parseInlineScalarOrInline(valuePart, line.rawNum);
    i++;
  }
  return { value: map, nextIdx: i };
}

// ─── list ────────────────────────────────────────────────────────────────────

function parseList(lines: Line[], idx: number, indent: number): BlockResult {
  const list: YamlList = [];
  let i = idx;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.text.trim() === "") { i++; continue; }
    if (line.indent < indent) break;
    if (line.indent > indent || !isListItem(line, indent)) break;

    const after = line.text.slice(indent + 2); // strip "- "
    const trimmed = after.trim();
    if (trimmed === "") {
      // Multi-line item: child block at deeper indent.
      const child = parseBlock(lines, i + 1, indent + 2);
      list.push(child.value);
      i = child.nextIdx;
      continue;
    }
    // Inline scalar / inline object / inline list / inline mapping start.
    if (trimmed.startsWith("{") || trimmed.startsWith("[") ||
        trimmed.startsWith("'") || trimmed.startsWith("\"") ||
        !/^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(trimmed)) {
      // Pure inline scalar / object / list.
      list.push(parseInlineScalarOrInline(trimmed, line.rawNum));
      i++;
      continue;
    }
    // Inline-mapping item starting with "key: value" — first key sits on the
    // dash line, subsequent indented keys (at indent+2) belong to same item.
    const colonAt = findUnquotedColon(after, 0);
    if (colonAt < 0) {
      throw new YamlParseError(`unexpected list item content: "${trimmed}"`, line.rawNum);
    }
    const firstKey = unquoteScalar(after.slice(0, colonAt).trim());
    const firstValRaw = after.slice(colonAt + 1).trim();
    const item: YamlMap = {};
    if (typeof firstKey === "string") {
      if (firstValRaw === "") {
        const child = parseBlock(lines, i + 1, indent + 2);
        item[firstKey] = child.value;
        i = child.nextIdx;
      } else {
        item[firstKey] = parseInlineScalarOrInline(firstValRaw, line.rawNum);
        i++;
        // Subsequent same-item keys are indented +2.
        while (i < lines.length) {
          const nl = lines[i]!;
          if (nl.text.trim() === "") { i++; continue; }
          if (nl.indent !== indent + 2) break;
          if (isListItem(nl, indent + 2)) break;
          const cAt = findUnquotedColon(nl.text, indent + 2);
          if (cAt < 0) throw new YamlParseError(`expected key in list item: "${nl.text.trim()}"`, nl.rawNum);
          const k = unquoteScalar(nl.text.slice(indent + 2, cAt).trim());
          const v = nl.text.slice(cAt + 1).trim();
          if (typeof k !== "string") throw new YamlParseError("non-string key", nl.rawNum);
          if (v === "") {
            const child = parseBlock(lines, i + 1, indent + 4);
            item[k] = child.value;
            i = child.nextIdx;
          } else {
            item[k] = parseInlineScalarOrInline(v, nl.rawNum);
            i++;
          }
        }
      }
    }
    list.push(item);
  }
  return { value: list, nextIdx: i };
}

// ─── inline scalars / inline objects ────────────────────────────────────────

function parseInlineScalarOrInline(value: string, rawNum: number): YamlValue {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("{")) return parseInlineMap(trimmed, rawNum);
  if (trimmed.startsWith("[")) return parseInlineList(trimmed, rawNum);
  return parseScalar(trimmed, rawNum);
}

function parseInlineMap(s: string, rawNum: number): YamlMap {
  if (!s.endsWith("}")) throw new YamlParseError(`unclosed inline map: "${s}"`, rawNum);
  const inner = s.slice(1, -1).trim();
  if (inner === "") return {};
  const parts = splitInline(inner, rawNum);
  const out: YamlMap = {};
  for (const p of parts) {
    const colonAt = findUnquotedColon(p, 0);
    if (colonAt < 0) throw new YamlParseError(`inline map entry missing ':' "${p}"`, rawNum);
    const k = unquoteScalar(p.slice(0, colonAt).trim());
    if (typeof k !== "string") throw new YamlParseError("non-string key in inline map", rawNum);
    out[k] = parseInlineScalarOrInline(p.slice(colonAt + 1).trim(), rawNum);
  }
  return out;
}

function parseInlineList(s: string, rawNum: number): YamlList {
  if (!s.endsWith("]")) throw new YamlParseError(`unclosed inline list: "${s}"`, rawNum);
  const inner = s.slice(1, -1).trim();
  if (inner === "") return [];
  return splitInline(inner, rawNum).map((p) => parseInlineScalarOrInline(p, rawNum));
}

/** Split on top-level commas, respecting quotes + nested {} and []. */
function splitInline(s: string, rawNum: number): string[] {
  const out: string[] = [];
  let depth = 0;
  let inSingle = false, inDouble = false;
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === "\"" && !inSingle) inDouble = !inDouble;
    if (!inSingle && !inDouble) {
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") depth--;
      else if (ch === "," && depth === 0) {
        if (buf.trim() !== "") out.push(buf.trim());
        buf = ""; continue;
      }
    }
    buf += ch;
  }
  if (buf.trim() !== "") out.push(buf.trim());
  if (depth !== 0 || inSingle || inDouble) {
    throw new YamlParseError(`unbalanced inline content: "${s}"`, rawNum);
  }
  return out;
}

function parseScalar(value: string, rawNum: number): YamlValue {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?\d+$/.test(value)) {
    const n = parseInt(value, 10);
    if (Number.isFinite(n)) return n;
  }
  if (/^-?\d+\.\d+$/.test(value)) {
    const n = parseFloat(value);
    if (Number.isFinite(n)) return n;
  }
  // Detect unterminated quoted scalars (opens with '/" but never closes).
  if ((value.startsWith("'") && !value.slice(1).includes("'")) ||
      (value.startsWith("\"") && !value.slice(1).match(/(?<!\\)"/))) {
    throw new YamlParseError(`unterminated quoted scalar: ${value}`, rawNum);
  }
  return unquoteScalar(value);
}

function unquoteScalar(value: string): string {
  if ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith("\"") && value.endsWith("\""))) {
    const body = value.slice(1, -1);
    // Double-quoted accepts escape sequences.
    if (value.startsWith("\"")) {
      return body.replace(/\\([nrt"\\])/g, (_, c) => ({ n: "\n", r: "\r", t: "\t", "\"": "\"", "\\": "\\" } as Record<string, string>)[c] ?? c);
    }
    // Single-quoted: '' escapes a literal '.
    return body.replace(/''/g, "'");
  }
  return value;
}

/** Find the first unquoted colon at-or-after `from`, or -1. */
function findUnquotedColon(s: string, from: number): number {
  let inSingle = false, inDouble = false;
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === "\"" && !inSingle) inDouble = !inDouble;
    if (inSingle || inDouble) continue;
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    if (depth === 0 && ch === ":") {
      // Must be followed by space, EOL, or be the last char.
      if (i + 1 >= s.length || s[i + 1] === " " || s[i + 1] === "\t") return i;
    }
  }
  return -1;
}
