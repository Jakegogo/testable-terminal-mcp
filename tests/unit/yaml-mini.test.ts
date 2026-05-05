/**
 * Unit tests for yaml-mini — covers the accepted subset and the rejection
 * paths for unsupported YAML features.
 */

import { describe, it, expect } from "vitest";
import { parseYaml, YamlParseError } from "../../src/utils/yaml-mini.js";

describe("yaml-mini — scalars", () => {
  it("parses int / float / bool / null / strings", () => {
    const r = parseYaml(`
a: 42
b: -3.14
c: true
d: false
e: null
f: hello
g: "with \\"quotes\\""
h: 'single ''quoted'''
`);
    expect(r).toEqual({
      a: 42, b: -3.14, c: true, d: false, e: null,
      f: "hello", g: 'with "quotes"', h: "single 'quoted'",
    });
  });

  it("strips comments at end of line + ignores comment-only lines", () => {
    const r = parseYaml(`
# top comment
key: value  # inline comment
other: 1
`);
    expect(r).toEqual({ key: "value", other: 1 });
  });

  it("respects # inside quoted strings", () => {
    const r = parseYaml(`s: "value # not comment"`);
    expect(r).toEqual({ s: "value # not comment" });
  });
});

describe("yaml-mini — mappings + lists", () => {
  it("parses nested mappings via 2-space indent", () => {
    const r = parseYaml(`
session:
  command: bash
  rows: 24
  cols: 80
`);
    expect(r).toEqual({ session: { command: "bash", rows: 24, cols: 80 } });
  });

  it("parses sequence of inline objects", () => {
    const r = parseYaml(`
masks:
  - { pattern: 'pid=\\d+', replace: 'pid=<MASKED>' }
  - { pattern: 'v\\d+', replace: 'v<X>' }
`);
    expect(r).toEqual({
      masks: [
        { pattern: "pid=\\d+", replace: "pid=<MASKED>" },
        { pattern: "v\\d+", replace: "v<X>" },
      ],
    });
  });

  it("parses sequence of block mappings (multi-line items)", () => {
    const r = parseYaml(`
steps:
  - write: "echo hi\\n"
  - expect_text:
      text: hi
      timeout_ms: 3000
  - snapshot:
      name: smoke
`);
    expect(r).toEqual({
      steps: [
        { write: "echo hi\n" },
        { expect_text: { text: "hi", timeout_ms: 3000 } },
        { snapshot: { name: "smoke" } },
      ],
    });
  });

  it("parses inline list scalars", () => {
    const r = parseYaml(`masks: ["claude-tui", "common-time"]`);
    expect(r).toEqual({ masks: ["claude-tui", "common-time"] });
  });

  it("empty inline object / list", () => {
    expect(parseYaml(`x: {}`)).toEqual({ x: {} });
    expect(parseYaml(`x: []`)).toEqual({ x: [] });
  });

  it("nested inline objects round-trip", () => {
    const r = parseYaml(`assert: { type: env_diff, opts: { allowed: ['PATH', 'EDITOR'] } }`);
    expect(r).toEqual({ assert: { type: "env_diff", opts: { allowed: ["PATH", "EDITOR"] } } });
  });
});

describe("yaml-mini — rejections", () => {
  it("tabs in indentation throws YamlParseError", () => {
    expect(() => parseYaml("session:\n\tcommand: bash")).toThrow(YamlParseError);
  });

  it("unclosed inline object throws", () => {
    expect(() => parseYaml(`x: { a: 1, b: 2`)).toThrow(YamlParseError);
  });

  it("missing colon in mapping throws", () => {
    expect(() => parseYaml("just a string")).toThrow(YamlParseError);
  });

  it("unbalanced quotes throws", () => {
    expect(() => parseYaml(`x: "unterminated`)).toThrow(YamlParseError);
  });
});

describe("yaml-mini — example test case shape", () => {
  it("parses a realistic ttm YAML test case", () => {
    const r = parseYaml(`
name: bash-smoke
session:
  command: bash
  rows: 24
  cols: 80
  sandbox: ephemeral
steps:
  - write: "echo hello\\n"
  - expect_text:
      text: hello
      timeout_ms: 3000
  - snapshot:
      name: bash_hello
      masks: ["common-time"]
`);
    expect(r).toMatchObject({
      name: "bash-smoke",
      session: { command: "bash", rows: 24, cols: 80, sandbox: "ephemeral" },
      steps: [
        { write: "echo hello\n" },
        { expect_text: { text: "hello", timeout_ms: 3000 } },
        { snapshot: { name: "bash_hello", masks: ["common-time"] } },
      ],
    });
  });
});
