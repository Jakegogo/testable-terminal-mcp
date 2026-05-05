#!/usr/bin/env node
/**
 * ttm-review — interactive accept/reject CLI for pending snapshots.
 *
 * Usage:
 *   ttm-review                       interactive (per-entry y/n/d/q)
 *   ttm-review --accept-all          batch accept (CI / known-good rebuilds)
 *   ttm-review --reject-all          batch reject (clean working tree)
 *   ttm-review --root <path>         override snapshot root (default: tests/__snapshots__)
 *
 * Interactive prompt per entry:
 *   y  accept this candidate (overwrites .snap)
 *   n  reject (deletes .snap.new, leaves .snap)
 *   d  show full diff (already shown by default; this re-displays)
 *   q  quit immediately
 *
 * Round-12 design: tiny readline-based TUI (~100 lines), no `ink` /
 * `inquirer` dependency. Snapshots are usually <30 per review session.
 */

import * as readline from "node:readline";
import * as path from "node:path";
import {
  scanPending, acceptPending, rejectPending, acceptAll, batch,
  type PendingEntry,
} from "../core/snapshot-test/reviewer.js";

interface CliOpts {
  rootDir: string;
  acceptAll: boolean;
  rejectAll: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  const out: CliOpts = {
    rootDir: path.resolve(process.cwd(), "tests/__snapshots__"),
    acceptAll: false,
    rejectAll: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--accept-all") out.acceptAll = true;
    else if (a === "--reject-all") out.rejectAll = true;
    else if (a === "--root") {
      const v = argv[++i];
      if (!v) { console.error("--root requires a path"); process.exit(2); }
      out.rootDir = path.resolve(process.cwd(), v);
    } else if (a === "-h" || a === "--help") {
      printHelp(); process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`); printHelp(); process.exit(2);
    }
  }
  return out;
}

function printHelp(): void {
  process.stdout.write(`ttm-review — accept or reject pending snapshots

Usage:
  ttm-review                  interactive mode (per-entry y/n/d/q)
  ttm-review --accept-all     batch accept everything pending
  ttm-review --reject-all     batch reject everything pending
  ttm-review --root <path>    snapshot root (default: tests/__snapshots__)
`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const pending = scanPending(opts.rootDir);

  if (pending.length === 0) {
    console.log("no pending snapshots in", opts.rootDir);
    return;
  }
  console.log(`found ${pending.length} pending snapshot(s) under ${opts.rootDir}\n`);

  if (opts.acceptAll) {
    const r = acceptAll(pending);
    console.log(`accepted ${r.accepted}, rejected ${r.rejected}`);
    return;
  }
  if (opts.rejectAll) {
    const r = batch({ pending, decide: () => "reject" });
    console.log(`accepted ${r.accepted}, rejected ${r.rejected}`);
    return;
  }

  await interactive(pending);
}

// ─── interactive ────────────────────────────────────────────────────────────

async function interactive(pending: ReadonlyArray<PendingEntry>): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let accepted = 0;
  let rejected = 0;
  try {
    for (let i = 0; i < pending.length; i++) {
      const entry = pending[i]!;
      printEntry(entry, i, pending.length);

      const choice = await prompt(rl, "[y]es / [n]o / [d]iff again / [q]uit > ");
      if (choice === "q") break;
      if (choice === "d") {
        printEntry(entry, i, pending.length, /*verbose*/ true);
        i--; // re-prompt the same entry
        continue;
      }
      if (choice === "y") { acceptPending(entry); accepted++; console.log("→ accepted\n"); }
      else { rejectPending(entry); rejected++; console.log("→ rejected\n"); }
    }
  } finally {
    rl.close();
  }
  console.log(`done: ${accepted} accepted, ${rejected} rejected, ${pending.length - accepted - rejected} skipped`);
}

function printEntry(entry: PendingEntry, idx: number, total: number, _verbose = false): void {
  const header = `── ${idx + 1}/${total}  ${entry.caseName}  (${entry.kind === "new" ? "new" : "diff"}) ──`;
  console.log(header);
  console.log(`   path: ${entry.snapPath}`);
  if (entry.kind === "diff" && entry.diff) {
    console.log("");
    console.log(entry.diff);
    console.log("");
  } else if (entry.kind === "new") {
    console.log("   (new snapshot — no prior to diff against)");
  }
}

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim().toLowerCase())));
}

// Run main only when invoked directly (not when imported).
const isDirectInvoke = (() => {
  try {
    const url = new URL(import.meta.url);
    return process.argv[1] !== undefined && url.pathname === path.resolve(process.argv[1]);
  } catch { return false; }
})();

if (isDirectInvoke) {
  main().catch((err) => {
    console.error("ttm-review failed:", err);
    process.exit(1);
  });
}
