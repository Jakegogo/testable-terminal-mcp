/**
 * ask-claude — send one message to Claude TUI, print its reply.
 *
 * Thin CLI wrapper over `lib/session.ts`'s askClaude(). All event-driven
 * waiting + reply extraction lives in the lib so integration tests can
 * import askClaude() directly.
 *
 * stdout: reply text only.
 * stderr: progress (with -v) and errors.
 */

import { askClaude } from "./lib/session.js";

interface CliOptions {
  prompt: string;
  command: string;
  rows: number;
  cols: number;
  timeoutMs: number;
  replyStabilityMs: number;
  loginShell: boolean;
  color: boolean;
  verbose: boolean;
  display: "headless" | "open-terminal" | "auto";
}

const DEFAULTS = {
  command: "claude",
  rows: 40,
  cols: 120,
  timeoutMs: 180_000,
  replyStabilityMs: 1_500,
};

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  const opts: CliOptions = {
    prompt: "",
    command: DEFAULTS.command,
    rows: DEFAULTS.rows,
    cols: DEFAULTS.cols,
    timeoutMs: DEFAULTS.timeoutMs,
    replyStabilityMs: DEFAULTS.replyStabilityMs,
    loginShell: false,
    color: false,
    verbose: false,
    display: "headless",
  };

  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === "--command") { opts.command = args[++i]; i++; }
    else if (a === "--timeout" || a === "--reply-timeout") { opts.timeoutMs = parseInt(args[++i], 10); i++; }
    else if (a === "--stability") { opts.replyStabilityMs = parseInt(args[++i], 10); i++; }
    else if (a === "--rows") { opts.rows = parseInt(args[++i], 10); i++; }
    else if (a === "--cols") { opts.cols = parseInt(args[++i], 10); i++; }
    else if (a === "--login-shell") { opts.loginShell = true; i++; }
    else if (a === "--no-login-shell") { opts.loginShell = false; i++; }
    else if (a === "--color") { opts.color = true; i++; }
    else if (a === "--no-color") { opts.color = false; i++; }
    else if (a === "--verbose" || a === "-v") { opts.verbose = true; i++; }
    else if (a === "--display") {
      const v = args[++i];
      if (v !== "headless" && v !== "open-terminal" && v !== "auto") {
        process.stderr.write(`error: --display must be headless | open-terminal | auto, got ${v}\n`);
        process.exit(1);
      }
      opts.display = v; i++;
    }
    else if (a === "--open-terminal") { opts.display = "open-terminal"; i++; }
    else if (a === "--help" || a === "-h") { printUsage(); process.exit(0); }
    else if (a === "--") { positional.push(...args.slice(i + 1)); break; }
    else { positional.push(a); i++; }
  }

  opts.prompt = positional.join(" ").trim();
  if (!opts.prompt) {
    process.stderr.write("error: missing prompt text\n\n");
    printUsage();
    process.exit(1);
  }
  return opts;
}

function printUsage(): void {
  process.stderr.write(`ask-claude — send a message to Claude TUI, print its reply.

Usage:
  tsx src/ask-claude.ts [options] <message...>
  npm run spike:claude:ask -- <message...>

Options:
  --command CMD          TUI command (default: ${DEFAULTS.command})
  --timeout MS           Total budget for ready+reply (default: ${DEFAULTS.timeoutMs})
  --stability MS         Screen quiet for this long → reply complete (default: ${DEFAULTS.replyStabilityMs})
  --rows N / --cols N    Terminal size (default: ${DEFAULTS.rows}x${DEFAULTS.cols})
  --login-shell          Run via $SHELL -ilc 'exec ...', loading ~/.zshrc / ~/.zprofile
  --no-login-shell       Disable login-shell wrapping (default behavior)
  --color                Output reply with ANSI colors
  --no-color             Plain-text output (default; safe for piping)
  --verbose, -v          Print progress to stderr
  --display MODE         headless | open-terminal | auto (default: headless)
  --open-terminal        Shorthand for --display open-terminal
`);
}

const opts = parseArgs(process.argv);

askClaude({
  prompt: opts.prompt,
  command: opts.command,
  rows: opts.rows,
  cols: opts.cols,
  timeoutMs: opts.timeoutMs,
  replyStabilityMs: opts.replyStabilityMs,
  loginShell: opts.loginShell,
  includeAnsi: opts.color,
  verbose: opts.verbose,
  display: opts.display,
}).then((res) => {
  const out = (opts.color && res.ansiReply) ? res.ansiReply : res.reply;
  if (out) {
    process.stdout.write(out);
    if (opts.color) process.stdout.write("\x1b[0m");
    process.stdout.write("\n");
  }
  if (!res.ok && res.reason) process.stderr.write(`[ask] ${res.reason}\n`);
  process.exit(res.ok ? 0 : 1);
}).catch((err) => {
  process.stderr.write(`[ask] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(2);
});
