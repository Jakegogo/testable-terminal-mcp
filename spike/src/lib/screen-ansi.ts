/**
 * screen-ansi — read the headless terminal's visible buffer back as either
 * plain text or fully-colored ANSI text.
 *
 * Why: `buffer.getLine(i).translateToString()` only gives plain text. To
 * print the screen as the user would actually see it (with Claude's blue
 * box borders, dim status bar, bold prompts, syntax-highlighted reply,
 * etc.) we have to walk each cell, read its fg/bg/attribute state, and
 * emit SGR sequences ourselves.
 *
 * We pair plain and ANSI line-by-line so callers can match against the
 * plain form (cheap, predictable) but display the ANSI form.
 */

import type { Terminal } from "@xterm/headless";

// Minimal cell shape we depend on. Avoids a hard dependency on a specific
// xterm types layout (the runtime values come from @xterm/headless).
interface BufferCell {
  getChars(): string;
  getFgColor(): number;
  getBgColor(): number;
  isBold(): number;
  isItalic(): number;
  isDim(): number;
  isInverse(): number;
  isUnderline(): number;
  isFgDefault(): boolean;
  isBgDefault(): boolean;
  isFgPalette(): boolean;
  isBgPalette(): boolean;
  isFgRGB(): boolean;
  isBgRGB(): boolean;
}

interface BufferLine {
  getCell(col: number): BufferCell | undefined;
}

type ColorMode = 0 | 1 | 2 | 3;
//   0 = default
//   1 = 16-color palette (low: 30-37 / high: 90-97)
//   2 = 256-color palette (38;5;N)
//   3 = direct RGB (38;2;r;g;b)

interface CellStyle {
  fgMode: ColorMode;
  fgColor: number;
  bgMode: ColorMode;
  bgColor: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  dim: boolean;
}

const DEFAULT_STYLE: CellStyle = {
  fgMode: 0, fgColor: 0, bgMode: 0, bgColor: 0,
  bold: false, italic: false, underline: false, inverse: false, dim: false,
};

function readStyle(cell: BufferCell): CellStyle {
  let fgMode: ColorMode = 0;
  if (cell.isFgDefault()) fgMode = 0;
  else if (cell.isFgPalette()) fgMode = cell.getFgColor() < 16 ? 1 : 2;
  else if (cell.isFgRGB()) fgMode = 3;

  let bgMode: ColorMode = 0;
  if (cell.isBgDefault()) bgMode = 0;
  else if (cell.isBgPalette()) bgMode = cell.getBgColor() < 16 ? 1 : 2;
  else if (cell.isBgRGB()) bgMode = 3;

  return {
    fgMode,
    fgColor: cell.getFgColor(),
    bgMode,
    bgColor: cell.getBgColor(),
    bold: cell.isBold() !== 0,
    italic: cell.isItalic() !== 0,
    underline: cell.isUnderline() !== 0,
    inverse: cell.isInverse() !== 0,
    dim: cell.isDim() !== 0,
  };
}

function styleEq(a: CellStyle, b: CellStyle): boolean {
  return a.fgMode === b.fgMode && a.fgColor === b.fgColor
      && a.bgMode === b.bgMode && a.bgColor === b.bgColor
      && a.bold === b.bold && a.italic === b.italic && a.underline === b.underline
      && a.inverse === b.inverse && a.dim === b.dim;
}

function emitSgr(s: CellStyle): string {
  // Always prepend reset so we don't accidentally inherit from previous SGR.
  const codes: string[] = ["0"];
  if (s.bold) codes.push("1");
  if (s.dim) codes.push("2");
  if (s.italic) codes.push("3");
  if (s.underline) codes.push("4");
  if (s.inverse) codes.push("7");

  if (s.fgMode === 1) {
    codes.push(String(s.fgColor < 8 ? 30 + s.fgColor : 90 + (s.fgColor - 8)));
  } else if (s.fgMode === 2) {
    codes.push(`38;5;${s.fgColor}`);
  } else if (s.fgMode === 3) {
    codes.push(`38;2;${(s.fgColor >> 16) & 0xff};${(s.fgColor >> 8) & 0xff};${s.fgColor & 0xff}`);
  }

  if (s.bgMode === 1) {
    codes.push(String(s.bgColor < 8 ? 40 + s.bgColor : 100 + (s.bgColor - 8)));
  } else if (s.bgMode === 2) {
    codes.push(`48;5;${s.bgColor}`);
  } else if (s.bgMode === 3) {
    codes.push(`48;2;${(s.bgColor >> 16) & 0xff};${(s.bgColor >> 8) & 0xff};${s.bgColor & 0xff}`);
  }

  return `\x1b[${codes.join(";")}m`;
}

function lineToBoth(line: BufferLine, cols: number): { plain: string; ansi: string } {
  let plain = "";
  let ansi = "";
  let lastStyle = DEFAULT_STYLE;
  let emittedAny = false;

  for (let col = 0; col < cols; col++) {
    const cell = line.getCell(col);
    if (!cell) continue;
    const chars = cell.getChars() || " ";
    plain += chars;

    const style = readStyle(cell);
    if (!emittedAny || !styleEq(lastStyle, style)) {
      ansi += emitSgr(style);
      lastStyle = style;
      emittedAny = true;
    }
    ansi += chars;
  }
  ansi += "\x1b[0m";
  return { plain, ansi };
}

export interface ScreenRead {
  plainLines: string[];
  ansiLines: string[];
  plainText: string;
  ansiText: string;
  cursor: { row: number; col: number };
  /** Range used to produce this read (helps callers diagnose). */
  range: ResolvedRange;
}

/**
 * SnapshotRange controls how many rows are returned.
 *
 *   "viewport"             — only the visible rows (rows × cols), reading from
 *                            buffer.baseY..baseY+rows. Best for TUIs.
 *   "all"                  — all buffer lines including scrollback.
 *   { lastLines: N }       — last N lines from the bottom of the buffer
 *                            (scrollback + viewport, capped to buffer.length).
 *
 * Default: { lastLines: 200 } — covers most single-shot command output and
 * still bounds size for Agent context.
 */
export type SnapshotRange = "viewport" | "all" | { lastLines: number };

export interface ResolvedRange {
  kind: "viewport" | "all" | "lastLines";
  startRow: number;
  endRow: number;     // exclusive
  totalBufferRows: number;
}

const DEFAULT_RANGE: SnapshotRange = { lastLines: 200 };

export function readScreen(term: Terminal, range: SnapshotRange = DEFAULT_RANGE): ScreenRead {
  const buf = term.buffer.active;
  // xterm.js IBuffer fields used:
  //   buf.length    — total rows including scrollback
  //   buf.baseY     — top of viewport (= scrollback line count)
  //   buf.cursorX/Y — cursor relative to viewport (0..rows-1)
  const totalRows = (buf as unknown as { length: number }).length;
  const baseY = (buf as unknown as { baseY: number }).baseY ?? 0;

  let startRow: number;
  let endRow: number;
  let kind: ResolvedRange["kind"];
  if (range === "viewport") {
    kind = "viewport";
    startRow = baseY;
    endRow = baseY + term.rows;
  } else if (range === "all") {
    kind = "all";
    startRow = 0;
    endRow = totalRows;
  } else {
    kind = "lastLines";
    const n = Math.max(0, range.lastLines);
    startRow = Math.max(0, totalRows - n);
    endRow = totalRows;
  }
  // Clamp to valid bounds.
  startRow = Math.max(0, startRow);
  endRow = Math.max(startRow, Math.min(endRow, totalRows));

  const plainLines: string[] = [];
  const ansiLines: string[] = [];
  for (let row = startRow; row < endRow; row++) {
    const line = buf.getLine(row) as BufferLine | undefined;
    if (!line) {
      plainLines.push("");
      ansiLines.push("");
      continue;
    }
    const { plain, ansi } = lineToBoth(line, term.cols);
    plainLines.push(plain);
    ansiLines.push(ansi);
  }

  // Trim trailing empty lines (keep both arrays paired).
  while (plainLines.length > 0 && plainLines[plainLines.length - 1].trim() === "") {
    plainLines.pop();
    ansiLines.pop();
  }

  // Cursor position is absolute within the buffer; expose it relative to the
  // returned range so consumers can index into plainLines/ansiLines safely.
  // xterm exposes cursorY relative to viewport; we add baseY to make it absolute,
  // then subtract startRow to make it range-relative.
  const absCursorY = baseY + (buf.cursorY ?? 0);
  const cursorRow = absCursorY - startRow;

  return {
    plainLines,
    ansiLines,
    plainText: plainLines.join("\n"),
    ansiText: ansiLines.join("\n"),
    cursor: { row: cursorRow, col: buf.cursorX ?? 0 },
    range: { kind, startRow, endRow, totalBufferRows: totalRows },
  };
}
