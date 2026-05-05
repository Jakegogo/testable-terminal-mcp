/**
 * snapshot — read the headless terminal buffer back as plain + ANSI text,
 * with selectable range (viewport / all / lastLines).
 *
 * Ported verbatim from spike/src/lib/screen-ansi.ts (round 5/6 mature
 * version: SnapshotRange + buf.baseY/length wiring + paired plain/ansi).
 *
 * Why we walk cells instead of `line.translateToString()`:
 *   - `translateToString` only gives plain text. To preserve fg/bg/attrs
 *     (which is what `display=open-terminal` viewers and ANSI snapshots
 *     need), we must read each cell's color/style and emit SGR ourselves.
 */

import type { Terminal } from "@xterm/headless";
import type { ScreenRead, SnapshotRange, ResolvedRange } from "./types.js";

// Re-export to keep imports localized.
export type { ScreenRead, SnapshotRange, ResolvedRange };

// ─── cell shape (minimal duck-type to avoid coupling to xterm internals) ────

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

/** Default range when caller doesn't specify (round 5: lastLines:200 covers most cases). */
export const DEFAULT_RANGE: SnapshotRange = { lastLines: 200 };

/**
 * Read the headless terminal's active buffer.
 *
 * Round 5 fix: reads from `buf.baseY..baseY+rows` (viewport) or `buf.length-N`
 * (lastLines), instead of `0..rows` which lost newest content once scrollback
 * grew. Cursor is reported range-relative so callers can index into lines.
 */
export function readScreen(term: Terminal, range: SnapshotRange = DEFAULT_RANGE): ScreenRead {
  const buf = term.buffer.active;
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
  while (plainLines.length > 0 && plainLines[plainLines.length - 1]!.trim() === "") {
    plainLines.pop();
    ansiLines.pop();
  }

  // Cursor position is absolute within the buffer; expose it range-relative.
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

/**
 * Compute a stable hash of the plain text. Used as `content_hash` on
 * TerminalSnapshot for equality checks (e.g. waitForChange dedup).
 */
export function snapshotHash(plainText: string): string {
  // Lightweight non-crypto hash — content_hash only needs collision-resistance
  // for equality checks (12 hex chars = 48 bits = sufficient for snapshot dedup).
  // FNV-1a 64-bit, then truncate.
  let h = 0xcbf29ce484222325n;
  const PRIME = 0x100000001b3n;
  for (let i = 0; i < plainText.length; i++) {
    h ^= BigInt(plainText.charCodeAt(i));
    h = (h * PRIME) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0").slice(-12);
}
