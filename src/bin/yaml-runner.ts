#!/usr/bin/env node
/**
 * ttm-run — execute a `.yaml` test case against the live Session core.
 *
 * Usage:
 *   ttm-run <case.yaml>                    one case, exit 0 / non-zero
 *   ttm-run cases/*.yaml                   multiple cases (glob expanded by shell)
 *   ttm-run --bail <case.yaml>             stop on first failure
 *   ttm-run --json <case.yaml>             machine-readable RunResult on stdout
 *
 * Exit code:
 *   0  all cases passed
 *   1  at least one case failed
 *   2  CLI usage / parse error
 */

import * as path from "node:path";
import { loadCase, runCase, type RunResult } from "../adapters/yaml/runner.js";
import { isTestableTerminalError } from "../core/errors.js";

interface CliOpts {
  files: string[];
  bail: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  const out: CliOpts = { files: [], bail: false, json: false };
  for (const a of argv) {
    if (a === "--bail") out.bail = true;
    else if (a === "--json") out.json = true;
    else if (a === "-h" || a === "--help") { printHelp(); process.exit(0); }
    else if (a.startsWith("-")) {
      console.error(`unknown flag: ${a}`); printHelp(); process.exit(2);
    } else {
      out.files.push(path.resolve(process.cwd(), a));
    }
  }
  if (out.files.length === 0) {
    console.error("ttm-run: at least one .yaml case required");
    printHelp(); process.exit(2);
  }
  return out;
}

function printHelp(): void {
  process.stdout.write(`ttm-run — execute YAML test cases against testable-terminal-mcp

Usage:
  ttm-run <case.yaml> [<case.yaml>...]
  ttm-run --bail <case.yaml>           stop on first failure
  ttm-run --json <case.yaml>           emit RunResult JSON to stdout
`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  let anyFailed = false;
  const results: Array<{ file: string; result: RunResult }> = [];

  for (const file of opts.files) {
    let result: RunResult;
    try {
      const c = loadCase(file);
      result = await runCase(c, { caseFile: file });
    } catch (err) {
      result = {
        ok: false,
        stepsRun: 0,
        errorCode: isTestableTerminalError(err) ? err.code : "UNKNOWN",
        message: (err as Error).message,
      };
    }
    results.push({ file, result });

    if (opts.json) {
      process.stdout.write(JSON.stringify({ file, ...result }) + "\n");
    } else {
      printHumanResult(file, result);
    }
    if (!result.ok) {
      anyFailed = true;
      if (opts.bail) break;
    }
  }
  process.exit(anyFailed ? 1 : 0);
}

function printHumanResult(file: string, r: RunResult): void {
  const tag = r.ok ? "✓ pass" : "✗ FAIL";
  const summary = r.ok
    ? `${r.stepsRun} steps`
    : `step ${r.failedAt} (${r.errorCode}): ${r.message}`;
  process.stdout.write(`${tag}  ${path.basename(file)}  — ${summary}\n`);
  if (!r.ok && r.artifactsDir) {
    process.stdout.write(`       artifacts: ${r.artifactsDir}\n`);
  }
}

const isDirectInvoke = (() => {
  try {
    const url = new URL(import.meta.url);
    return process.argv[1] !== undefined && url.pathname === path.resolve(process.argv[1]);
  } catch { return false; }
})();

if (isDirectInvoke) {
  main().catch((err) => {
    console.error("ttm-run failed:", err);
    process.exit(1);
  });
}
