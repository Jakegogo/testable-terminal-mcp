
**用户需求 chat 记录:**

如何自动化测试 MAC Terminal 应用程序，包含了图形交互界面的，已知的可以用 MCP，但是还没找到合适的开源项目可以用，有没有更好的办法呢


就需要现在需要将我的 CLI 程序 和 claude、kimi 这类含有 GUI 的 Terminal 程序进行集成测试，


需要调用真实的 agent

主要想了解 如何实现测试 过程中，可以对 claude、kimi 等Terminal GUI 显示的内容进行截取（类似截屏），用于断言。 另外可以获取当前的环境变量，也可以自动操作输入等

creack/pty 是否可以测试出 Terminal 的兼容性呢





**You:**

基于这个方案，详细展开设计实现，

更推荐的方案
新建一个专用项目

建议叫：

testable-terminal-mcp

技术栈：

TypeScript
@modelcontextprotocol/sdk
node-pty
@xterm/headless 或 xterm-headless
zod
vitest

核心工具：

terminal.create_session
terminal.write
terminal.send_key
terminal.snapshot
terminal.expect_text
terminal.expect_regex
terminal.resize
terminal.get_env
terminal.dump_artifacts
terminal.close_session

架构：

MCP Tool Layer
  ↓
SessionManager
  ↓
PTY Session: node-pty
  ↓
Terminal Emulator: @xterm/headless
  ↓
Snapshot / Expect / Artifact

这比改 DesktopCommanderMCP 更聚焦、更适合让 Agent 实现。

* * *

**ChatGPT:**

我会把它展开成可以直接交给 Claude Code/Cursor Agent 开工的工程设计：目录结构、核心类、MCP tools schema、screen snapshot、expect 机制、artifact、安全配置、测试用例和分阶段任务。

* * *

**ChatGPT:**

下面给你一份可以直接交给 Agent 实现的详细设计。目标不是做一个“大而全的 Desktop Commander”，而是做一个专用的：

```
testable-terminal-mcp
```

它的定位是：

> **给 Claude / Kimi / 你的 CLI 这类真实 Terminal TUI 程序提供可测试、可断言、可截图语义的 MCP 控制层。**

底层核心是：

```
node-pty 启动真实 PTY 进程
@xterm/headless 维护当前 Terminal screen buffer
MCP tools 暴露 create/write/key/snapshot/expect/resize/artifact
```

`node-pty` 本身就是用于在 Node.js 中 fork 伪终端进程，并返回可读写的 terminal object，典型用途包括写 terminal emulator，以及让程序认为自己运行在真实 terminal 里。这个特性正好适合 Claude/Kimi 这类会检测 TTY 的 TUI 程序。[GitHub](https://github.com/microsoft/node-PTY?utm_source=chatgpt.com)  
`xterm-headless`/`@xterm/headless` 负责在 Node.js 中维护 headless terminal 状态，适合在后端跟踪 terminal screen。旧的 `xterm-headless` 包已经提示迁移到 `@xterm/headless`，所以新项目建议优先用 `@xterm/headless`。[Yarn+1](https://classic.yarnpkg.com/en/package/xterm-headless?utm_source=chatgpt.com)  
`@modelcontextprotocol/sdk` 是 MCP 的 TypeScript SDK，用于实现 MCP server/tools；官方说明它运行在 Node.js、Bun、Deno，并提供 MCP server/client 能力。[GitHub+1](https://github.com/modelcontextprotocol/typescript-sdk?utm_source=chatgpt.com)  
Vitest 可用于 TypeScript/Node 后端测试，支持 Jest-compatible API、snapshot、coverage 等能力。[Vitest+1](https://vitest.dev/?utm_source=chatgpt.com)

---

# 1. 项目目标

## 1.1 核心目标

这个项目要解决的是：

```
真实 Claude/Kimi/your-cli TUI 集成测试
  ↓
可以启动真实 Agent
可以自动输入
可以发送特殊按键
可以读取当前屏幕
可以做 expect_text / expect_regex
可以调整 rows/cols
可以 dump 失败现场
可以被 Claude/Cursor/测试 Runner 通过 MCP 调用
```

换句话说，它是：

```
Playwright for Terminal/TUI
```

但第一版不追求完整 Playwright 复杂度，只做最核心的测试闭环。

---

# 2. 总体架构

```
┌───────────────────────────────────────────────┐
│                MCP Client                      │
│ Claude Code / Cursor / 自研 Test Runner         │
└───────────────────────┬───────────────────────┘
                        │ MCP Tool Call
                        ▼
┌───────────────────────────────────────────────┐
│              MCP Tool Layer                    │
│ create_session / write / send_key / snapshot   │
│ expect_text / expect_regex / resize / dump      │
└───────────────────────┬───────────────────────┘
                        │
                        ▼
┌───────────────────────────────────────────────┐
│              SessionManager                    │
│ Map<session_id, TerminalSession>               │
│ lifecycle / timeout / cleanup / security        │
└───────────────────────┬───────────────────────┘
                        │
                        ▼
┌───────────────────────────────────────────────┐
│              TerminalSession                   │
│ ptyProcess + headlessTerminal + logs + events  │
└───────────────┬───────────────────┬───────────┘
                │                   │
                ▼                   ▼
┌──────────────────────┐   ┌────────────────────┐
│ node-pty              │   │ @xterm/headless     │
│ start/read/write      │──▶│ screen buffer       │
│ resize/kill           │   │ current snapshot    │
└──────────────────────┘   └────────────────────┘
                │
                ▼
┌───────────────────────────────────────────────┐
│           Real Process                         │
│ claude / kimi / your-cli / bash                 │
└───────────────────────────────────────────────┘
```

核心原则：

```
MCP 只是 adapter
TerminalSession 才是核心
node-pty 负责真实终端进程
@xterm/headless 负责当前屏幕状态
Artifact 层负责失败可追溯
```

---

# 3. 项目目录结构

建议这样组织：

```
testable-terminal-mcp/
  package.json
  tsconfig.json
  vitest.config.ts
  README.md
  .env.example

  src/
    index.ts

    config/
      config.ts
      security.ts

    mcp/
      server.ts
      tools.ts
      schemas.ts
      errors.ts

    terminal/
      session-manager.ts
      terminal-session.ts
      types.ts
      keys.ts
      snapshot.ts
      expect.ts
      artifacts.ts
      env.ts
      ansi.ts

    utils/
      id.ts
      time.ts
      logger.ts
      redact.ts
      fs.ts

  tests/
    unit/
      keys.test.ts
      snapshot.test.ts
      security.test.ts

    integration/
      bash-smoke.test.ts
      expect-timeout.test.ts
      resize.test.ts
      ctrl-c.test.ts

  examples/
    claude-smoke.yaml
    kimi-smoke.yaml
    your-cli-smoke.yaml

  artifacts/
    .gitkeep
```

---

# 4. 核心对象设计

## 4.1 TerminalSessionConfig

```TypeScript
export interface TerminalSessionConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  rows?: number;
  cols?: number;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  maxOutputBytes?: number;
  artifactDir?: string;
  name?: string;
}
```

默认值：

```TypeScript
const DEFAULT_ROWS = 40;
const DEFAULT_COLS = 120;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
```

---

## 4.2 TerminalSession

```TypeScript
export class TerminalSession {
  readonly id: string;
  readonly config: ResolvedTerminalSessionConfig;
  readonly createdAt: Date;

  private ptyProcess?: IPty;
  private terminal: Terminal;
  private rawChunks: Buffer[] = [];
  private events: TerminalEvent[] = [];
  private status: TerminalSessionStatus = "created";

  async start(): Promise<void>;
  write(text: string): void;
  sendKey(key: TerminalKey): void;
  resize(rows: number, cols: number): void;

  snapshot(): TerminalSnapshot;

  expectText(text: string, timeoutMs: number): Promise<TerminalSnapshot>;
  expectRegex(pattern: string, timeoutMs: number): Promise<TerminalSnapshot>;

  getEnv(): Record<string, string>;
  dumpArtifacts(dir?: string): Promise<ArtifactResult>;

  close(): Promise<void>;
  kill(signal?: string): Promise<void>;
}
```

状态：

```TypeScript
export type TerminalSessionStatus =
  | "created"
  | "starting"
  | "running"
  | "exited"
  | "killed"
  | "timeout"
  | "failed";
```

---

## 4.3 TerminalSnapshot

```TypeScript
export interface TerminalSnapshot {
  sessionId: string;
  rows: number;
  cols: number;
  status: TerminalSessionStatus;
  text: string;
  lines: string[];
  cursor?: {
    row: number;
    col: number;
  };
  timestamp: string;
  rawTail?: string;
}
```

`text` 是当前 screen buffer 的文本，不是历史 stdout。

这点非常重要：

```
raw.log  = 历史字节流
clean.log = 清洗后的历史输出
screen.txt = 当前 terminal 屏幕
snapshot.text = 当前 terminal 屏幕文本
```

---

## 4.4 TerminalEvent

```TypeScript
export interface TerminalEvent {
  type:
    | "session.created"
    | "session.started"
    | "input.write"
    | "input.key"
    | "output.data"
    | "screen.snapshot"
    | "expect.match"
    | "expect.timeout"
    | "resize"
    | "process.exit"
    | "session.closed"
    | "error";

  timestamp: string;
  sessionId: string;
  data?: unknown;
}
```

事件保存为 `events.jsonl`，方便失败后分析。

---

# 5. MCP Tools 设计

## 5.1 terminal.create_session

### 输入

```TypeScript
export const CreateSessionSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional().default([]),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional().default({}),
  rows: z.number().int().min(10).max(200).optional().default(40),
  cols: z.number().int().min(20).max(300).optional().default(120),
  timeout_ms: z.number().int().min(1000).max(60 * 60 * 1000).optional(),
  idle_timeout_ms: z.number().int().min(1000).max(10 * 60 * 1000).optional(),
  name: z.string().optional()
});
```

### 输出

```JSON
{
  "session_id": "term_01H...",
  "pid": 12345,
  "status": "running",
  "rows": 40,
  "cols": 120
}
```

### 行为

```
1. 校验 command 是否在 allowlist
2. 解析 cwd
3. 合并 env
4. 启动 node-pty
5. 创建 @xterm/headless Terminal
6. 绑定 onData，把 PTY 输出写入 headless terminal
7. 返回 session_id
```

---

## 5.2 terminal.write

### 输入

```TypeScript
export const WriteSchema = z.object({
  session_id: z.string(),
  text: z.string()
});
```

### 示例

```JSON
{
  "session_id": "term_01H...",
  "text": "只回复 OK\n"
}
```

### 行为

```
向 PTY 写入原始文本
记录 input.write event
```

---

## 5.3 terminal.send_key

### 输入

```TypeScript
export const SendKeySchema = z.object({
  session_id: z.string(),
  key: z.enum([
    "enter",
    "tab",
    "esc",
    "ctrl_c",
    "ctrl_d",
    "arrow_up",
    "arrow_down",
    "arrow_left",
    "arrow_right",
    "backspace"
  ])
});
```

### key 映射

```TypeScript
export const KEY_SEQUENCES: Record<TerminalKey, string> = {
  enter: "\r",
  tab: "\t",
  esc: "\x1b",
  ctrl_c: "\x03",
  ctrl_d: "\x04",
  arrow_up: "\x1b[A",
  arrow_down: "\x1b[B",
  arrow_right: "\x1b[C",
  arrow_left: "\x1b[D",
  backspace: "\x7f"
};
```

---

## 5.4 terminal.snapshot

### 输入

```TypeScript
export const SnapshotSchema = z.object({
  session_id: z.string(),
  include_raw_tail: z.boolean().optional().default(false),
  raw_tail_bytes: z.number().int().min(0).max(65536).optional().default(4096)
});
```

### 输出

```JSON
{
  "session_id": "term_01H...",
  "rows": 40,
  "cols": 120,
  "status": "running",
  "text": "Claude Code\n\n> 只回复 OK\n\nOK",
  "lines": ["Claude Code", "", "> 只回复 OK", "", "OK"],
  "timestamp": "2026-05-01T..."
}
```

### snapshot 提取逻辑

用 `@xterm/headless` 的 buffer 读取当前可见行，转换为字符串。

伪代码：

```TypeScript
function snapshotFromTerminal(term: Terminal, sessionId: string): TerminalSnapshot {
  const lines: string[] = [];
  const buffer = term.buffer.active;

  for (let i = 0; i < term.rows; i++) {
    const line = buffer.getLine(i);
    lines.push(line ? line.translateToString(true) : "");
  }

  return {
    sessionId,
    rows: term.rows,
    cols: term.cols,
    status: "running",
    lines,
    text: trimTrailingEmptyLines(lines).join("\n"),
    cursor: {
      row: buffer.cursorY,
      col: buffer.cursorX
    },
    timestamp: new Date().toISOString()
  };
}
```

注意：不同版本的 `@xterm/headless` API 细节可能略有差异，让 Agent 实现时需要实际跑 `npm test` 校验。

---

## 5.5 terminal.expect_text

### 输入

```TypeScript
export const ExpectTextSchema = z.object({
  session_id: z.string(),
  text: z.string().min(1),
  timeout_ms: z.number().int().min(100).max(10 * 60 * 1000).default(30000),
  interval_ms: z.number().int().min(50).max(5000).default(100)
});
```

### 行为

```
循环 snapshot
判断 snapshot.text.includes(text)
命中则返回 snapshot
超时则返回错误 + 当前 snapshot
```

### 输出成功

```JSON
{
  "matched": true,
  "snapshot": {
    "text": "..."
  }
}
```

### 输出失败

```JSON
{
  "matched": false,
  "error": "expect_text timeout after 30000ms",
  "snapshot": {
    "text": "当前屏幕内容..."
  }
}
```

---

## 5.6 terminal.expect_regex

### 输入

```TypeScript
export const ExpectRegexSchema = z.object({
  session_id: z.string(),
  pattern: z.string().min(1),
  flags: z.string().optional().default("i"),
  timeout_ms: z.number().int().min(100).max(10 * 60 * 1000).default(30000),
  interval_ms: z.number().int().min(50).max(5000).default(100)
});
```

### 用途

用于匹配：

```
(?i)(allow|permission|continue|\[y/N\])
(?i)(claude|welcome|>)
(?i)(error|authentication|rate limit)
```

---

## 5.7 terminal.resize

### 输入

```TypeScript
export const ResizeSchema = z.object({
  session_id: z.string(),
  rows: z.number().int().min(10).max(200),
  cols: z.number().int().min(20).max(300)
});
```

### 行为

```
1. pty.resize(cols, rows)
2. terminal.resize(cols, rows)
3. 记录 resize event
```

注意 node-pty 和 xterm 的参数顺序通常是 `cols, rows`，而业务 API 建议统一用 `rows, cols`，避免工具层混乱。

---

## 5.8 terminal.get_env

### 输入

```TypeScript
export const GetEnvSchema = z.object({
  session_id: z.string(),
  redact: z.boolean().optional().default(true)
});
```

### 输出

```JSON
{
  "TERM": "xterm-256color",
  "NO_COLOR": "1",
  "LANG": "en_US.UTF-8",
  "PWD": "/tmp/agent-test",
  "ANTHROPIC_API_KEY": "***REDACTED***"
}
```

注意：这里返回的是**启动 session 时传入的环境变量快照**，不是从子进程内部动态读取。测试上通常够用。

---

## 5.9 terminal.dump_artifacts

### 输入

```TypeScript
export const DumpArtifactsSchema = z.object({
  session_id: z.string(),
  dir: z.string().optional()
});
```

### 输出目录

```
artifacts/
  claude-smoke-term_01H/
    raw.log
    clean.log
    screen.txt
    events.jsonl
    env.json
    meta.json
```

### meta.json

```JSON
{
  "session_id": "term_01H...",
  "command": "claude",
  "args": [],
  "cwd": "/tmp/agent-test",
  "rows": 40,
  "cols": 120,
  "status": "running",
  "created_at": "...",
  "dumped_at": "..."
}
```

---

## 5.10 terminal.close_session

### 输入

```TypeScript
export const CloseSessionSchema = z.object({
  session_id: z.string(),
  kill: z.boolean().optional().default(true)
});
```

### 行为

```
1. 如果 kill=true，kill PTY 进程
2. 移除 session
3. 释放 buffer/log
4. 记录 session.closed
```

---

# 6. 安全设计

这个项目本质上能执行本机命令，所以安全要从第一版就做。

## 6.1 配置文件

```JSON
{
  "server": {
    "transport": "stdio"
  },
  "security": {
    "allowedCommands": ["bash", "zsh", "claude", "kimi", "your-cli"],
    "allowedWorkdirs": ["/tmp", "/Users/jake/Projects"],
    "defaultCwd": "/tmp",
    "maxSessionDurationMs": 600000,
    "maxOutputBytes": 20971520,
    "redactEnvPatterns": [
      "*KEY*",
      "*TOKEN*",
      "*SECRET*",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "KIMI_API_KEY"
    ]
  }
}
```

## 6.2 command allowlist

不要允许任意命令。

```TypeScript
function assertAllowedCommand(command: string, config: SecurityConfig) {
  const base = path.basename(command);
  if (!config.allowedCommands.includes(base)) {
    throw new Error(`Command not allowed: ${command}`);
  }
}
```

## 6.3 cwd 限制

```TypeScript
function assertAllowedCwd(cwd: string, allowedWorkdirs: string[]) {
  const resolved = path.resolve(cwd);
  const ok = allowedWorkdirs.some(root => {
    const resolvedRoot = path.resolve(root);
    return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
  });

  if (!ok) {
    throw new Error(`Working directory not allowed: ${cwd}`);
  }
}
```

## 6.4 env 脱敏

```TypeScript
function redactEnv(env: Record<string, string>, patterns: string[]) {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (shouldRedact(key, patterns)) {
      result[key] = "***REDACTED***";
    } else {
      result[key] = value;
    }
  }

  return result;
}
```

---

# 7. TerminalSession 实现细节

## 7.1 启动 PTY

```TypeScript
import pty from "node-pty";
import { Terminal } from "@xterm/headless";

class TerminalSession {
  async start() {
    this.status = "starting";

    this.terminal = new Terminal({
      cols: this.config.cols,
      rows: this.config.rows,
      allowProposedApi: true
    });

    this.ptyProcess = pty.spawn(
      this.config.command,
      this.config.args,
      {
        name: "xterm-256color",
        cols: this.config.cols,
        rows: this.config.rows,
        cwd: this.config.cwd,
        env: this.config.env
      }
    );

    this.ptyProcess.onData((data: string) => {
      this.appendRaw(data);
      this.terminal.write(data);
      this.recordEvent("output.data", {
        bytes: Buffer.byteLength(data)
      });
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      this.status = "exited";
      this.recordEvent("process.exit", { exitCode, signal });
    });

    this.status = "running";
    this.recordEvent("session.started", {
      pid: this.ptyProcess.pid
    });
  }
}
```

---

## 7.2 raw log 限制

防止 Claude/Kimi 输出过多导致内存爆。

```TypeScript
private appendRaw(data: string) {
  const buf = Buffer.from(data, "utf8");
  this.rawBytes += buf.length;

  this.rawChunks.push(buf);

  while (this.rawBytes > this.config.maxOutputBytes && this.rawChunks.length > 0) {
    const removed = this.rawChunks.shift()!;
    this.rawBytes -= removed.length;
    this.rawTruncated = true;
  }
}
```

更好的版本可以同时写文件流，不只存在内存。

---

## 7.3 clean log

clean log 用于人工读，不用于严格 snapshot。

可以简单清洗 ANSI：

```TypeScript
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, "");
}
```

注意：`stripAnsi` 不能替代 screen buffer。它只是历史输出清洗。

---

# 8. Snapshot 设计重点

## 8.1 为什么不能只读 stdout？

因为 TUI 会使用：

```
\r
\x1b[2J
\x1b[H
\x1b[A
\x1b[K
alternate screen
```

stdout 是历史流，不能代表当前画面。

## 8.2 正确链路

```
PTY raw output
  ↓
@xterm/headless.write(data)
  ↓
terminal.buffer.active
  ↓
snapshot.text
```

## 8.3 snapshot trimming

不建议保留大量空行。

```TypeScript
function trimTrailingEmptyLines(lines: string[]): string[] {
  const result = [...lines];
  while (result.length > 0 && result[result.length - 1].trim() === "") {
    result.pop();
  }
  return result;
}
```

---

# 9. Expect 机制

## 9.1 基本实现

```TypeScript
async function waitFor(
  matcher: (snapshot: TerminalSnapshot) => boolean,
  timeoutMs: number,
  intervalMs: number,
  getSnapshot: () => TerminalSnapshot
): Promise<TerminalSnapshot> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const snap = getSnapshot();
    if (matcher(snap)) return snap;
    await sleep(intervalMs);
  }

  throw new ExpectTimeoutError(getSnapshot());
}
```

## 9.2 expect_text

```TypeScript
async expectText(text: string, timeoutMs: number) {
  return waitFor(
    snap => snap.text.includes(text),
    timeoutMs,
    100,
    () => this.snapshot()
  );
}
```

## 9.3 expect_regex

```TypeScript
async expectRegex(pattern: string, flags = "i", timeoutMs: number) {
  const re = new RegExp(pattern, flags);

  return waitFor(
    snap => re.test(snap.text),
    timeoutMs,
    100,
    () => this.snapshot()
  );
}
```

## 9.4 超时返回快照

MCP tool 捕获 `ExpectTimeoutError`，返回：

```JSON
{
  "matched": false,
  "error": "timeout",
  "snapshot": {
    "text": "当前屏幕内容..."
  }
}
```

不要只返回字符串错误，否则失败时不好定位。

---

# 10. Artifact 设计

## 10.1 dump 时机

支持两种：

```
手动调用 terminal.dump_artifacts
expect 失败时自动 dump
close_session 时可选 dump
```

## 10.2 文件内容

```
raw.log
  原始 PTY 输出，保留 ANSI

clean.log
  strip ANSI 后的历史输出

screen.txt
  当前 screen snapshot

events.jsonl
  每个事件一行 JSON

env.json
  启动环境，默认脱敏

meta.json
  session 元信息
```

## 10.3 screen.txt 格式

```
================ TERMINAL SNAPSHOT ================
session_id: term_01H...
command: claude
rows: 40
cols: 120
status: running
time: 2026-05-01T...

Claude Code

> 只回复 OK

OK
===================================================
```

---

# 11. MCP Server 实现方式

## 11.1 server.ts

使用官方 TypeScript SDK 建 server。SDK 支持 MCP server/tools，适合直接暴露这些 terminal tools。[GitHub+1](https://github.com/modelcontextprotocol/typescript-sdk?utm_source=chatgpt.com)

伪代码：

```TypeScript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTerminalTools } from "./tools.js";

export async function startServer() {
  const server = new McpServer({
    name: "testable-terminal-mcp",
    version: "0.1.0"
  });

  registerTerminalTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

具体 API 命名可能随 SDK 版本变化，让 Agent 以当前安装版本为准调整。

---

## 11.2 tools.ts

```TypeScript
export function registerTerminalTools(server: McpServer) {
  server.tool(
    "terminal.create_session",
    "Create a PTY-backed terminal session",
    CreateSessionSchema.shape,
    async (input) => {
      const session = await sessionManager.create(input);
      return jsonResult({
        session_id: session.id,
        pid: session.pid,
        status: session.status
      });
    }
  );

  server.tool(
    "terminal.write",
    "Write text to a terminal session",
    WriteSchema.shape,
    async (input) => {
      const session = sessionManager.get(input.session_id);
      session.write(input.text);
      return jsonResult({ ok: true });
    }
  );

  // 其他 tools 同理
}
```

---

# 12. 测试设计

## 12.1 Unit Tests

### keys.test.ts

```TypeScript
expect(KEY_SEQUENCES.ctrl_c).toBe("\x03");
expect(KEY_SEQUENCES.arrow_down).toBe("\x1b[B");
```

### security.test.ts

```TypeScript
expect(() => assertAllowedCommand("rm", config)).toThrow();
expect(() => assertAllowedCommand("bash", config)).not.toThrow();
```

### snapshot.test.ts

用 headless terminal 直接写数据：

```TypeScript
term.write("hello");
expect(snapshot.text).toContain("hello");
```

---

## 12.2 Integration Tests

这些测试不用 Claude/Kimi，先用 bash，因为 CI 更稳定。

### bash-smoke.test.ts

```TypeScript
const session = await manager.create({
  command: "bash",
  args: [],
  rows: 40,
  cols: 120
});

session.write("echo OK\n");
const snap = await session.expectText("OK", 3000);
expect(snap.text).toContain("OK");
```

### ctrl-c.test.ts

```TypeScript
session.write("sleep 10\n");
await delay(500);
session.sendKey("ctrl_c");
await session.expectRegex("\\$|#", 3000);
```

### resize.test.ts

```TypeScript
session.resize(24, 80);
const snap = session.snapshot();
expect(snap.rows).toBe(24);
expect(snap.cols).toBe(80);
```

### expect-timeout.test.ts

```TypeScript
await expect(session.expectText("NOT_FOUND", 500)).rejects.toThrow();
```

---

## 12.3 Real Agent Tests

这些不要默认跑 CI，用环境变量控制。

```TypeScript
const runRealAgent = process.env.RUN_REAL_AGENT_TESTS === "1";
```

### Claude smoke

```TypeScript
it.skipIf(!runRealAgent)("claude tui smoke", async () => {
  const session = await manager.create({
    command: "claude",
    rows: 40,
    cols: 120,
    env: {
      TERM: "xterm-256color",
      NO_COLOR: "1"
    }
  });

  await session.expectRegex("(claude|welcome|>)", 20000);
  session.write("只回复 OK\n");
  await session.expectText("OK", 60000);
  await session.dumpArtifacts();
  await session.close();
});
```

### Kimi smoke

```TypeScript
it.skipIf(!runRealAgent)("kimi tui smoke", async () => {
  const session = await manager.create({
    command: "kimi",
    rows: 40,
    cols: 120,
    env: {
      TERM: "xterm-256color",
      NO_COLOR: "1"
    }
  });

  await session.expectRegex("(kimi|welcome|>)", 20000);
  session.write("只回复 OK\n");
  await session.expectText("OK", 60000);
});
```

---

# 13. Claude/Kimi 测试策略

真实 Agent 测试不要断言完整输出，只断言关键行为：

```
能启动
能输入
能看到响应
能中断
能退出
能 dump artifacts
```

推荐测试矩阵：

```
Agent:
  claude
  kimi

Mode:
  tui

Size:
  80x24
  120x40

Env:
  TERM=xterm-256color
  NO_COLOR=1

Cases:
  smoke: 输入“只回复 OK”
  interrupt: 输入长任务后 ctrl-c
  permission: 触发 pwd 或 ls
```

---

# 14. YAML 测试 Runner，可作为第二阶段

MCP 适合 AI 调用，但自动化测试不一定非要走 MCP。建议第二阶段加 YAML runner：

```YAML
name: claude_tui_smoke

session:
  command: claude
  rows: 40
  cols: 120
  env:
    TERM: xterm-256color
    NO_COLOR: "1"

steps:
  - expect_regex: "(?i)(claude|welcome|>)"
    timeout_ms: 20000

  - write: "只回复 OK\n"

  - expect_text: "OK"
    timeout_ms: 60000

  - send_key: ctrl_c

artifacts:
  dir: artifacts/claude_tui_smoke
```

Runner 架构：

```
YAML Test Case
  ↓
Test Runner
  ↓
SessionManager
  ↓
TerminalSession
```

这样可以绕过 MCP，直接跑回归测试。

---

# 15. package.json 建议

```JSON
{
  "name": "testable-terminal-mcp",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "testable-terminal-mcp": "./dist/index.js"
  },
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:real-agent": "RUN_REAL_AGENT_TESTS=1 vitest run tests/integration"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "latest",
    "@xterm/headless": "latest",
    "node-pty": "latest",
    "zod": "latest"
  },
  "devDependencies": {
    "@types/node": "latest",
    "tsx": "latest",
    "typescript": "latest",
    "vitest": "latest"
  }
}
```

注意：`node-pty` 是 native module，安装时可能需要 Xcode Command Line Tools。这个属于 Node PTY 生态常见问题。

---

# 16. Agent 实现任务拆分

这是最重要的部分。你可以把下面内容直接作为 Claude Code/Cursor 的任务清单。

## Milestone 1：项目骨架

```
创建 TypeScript ESM 项目。
安装 @modelcontextprotocol/sdk、node-pty、@xterm/headless、zod、vitest、tsx、typescript。
实现 src/index.ts 启动 MCP stdio server。
实现 terminal.create_session / terminal.close_session 空壳。
通过 npm run build 和 npm test。
```

验收：

```
npm run build 通过
MCP server 可以启动
```

---

## Milestone 2：PTY Session

```
实现 SessionManager 和 TerminalSession。
使用 node-pty 启动 bash。
支持 write。
保存 raw output。
实现 close/kill。
新增 bash-smoke.test.ts：启动 bash，write echo OK，raw output 包含 OK。
```

验收：

```
npm test 通过
bash echo OK 成功
```

---

## Milestone 3：Headless Screen Snapshot

```
接入 @xterm/headless。
PTY onData 时同时写入 headless terminal。
实现 terminal.snapshot。
snapshot 返回 rows/cols/text/lines/cursor/status。
新增 snapshot.test.ts 和 bash snapshot integration test。
```

验收：

```
write clear && echo OK 后 snapshot.text 能看到 OK
```

---

## Milestone 4：Expect

```
实现 terminal.expect_text 和 terminal.expect_regex。
超时返回当前 snapshot。
新增 expect timeout 测试。
```

验收：

```
expect_text("OK") 成功
expect_text("NOT_FOUND") 超时且返回 snapshot
```

---

## Milestone 5：Key / Resize

```
实现 terminal.send_key。
支持 enter/tab/esc/ctrl_c/ctrl_d/arrow keys/backspace。
实现 terminal.resize。
新增 ctrl-c 和 resize 测试。
```

验收：

```
sleep 10 后 ctrl_c 可以中断
resize 后 snapshot rows/cols 正确
```

---

## Milestone 6：Artifacts

```
实现 terminal.dump_artifacts。
保存 raw.log、clean.log、screen.txt、events.jsonl、env.json、meta.json。
expect 失败时自动记录 expect.timeout event。
```

验收：

```
dump 后文件存在
screen.txt 包含当前 snapshot
env.json 已脱敏
```

---

## Milestone 7：Security

```
实现配置文件。
实现 allowed_commands。
实现 allowed_workdirs。
实现 env redaction。
实现 max session duration。
实现 max output bytes。
```

验收：

```
禁止 rm 命令
禁止 cwd 超出 allowedWorkdirs
敏感 env 被脱敏
```

---

## Milestone 8：真实 Agent 测试

```
新增 RUN_REAL_AGENT_TESTS=1 控制的真实测试。
实现 claude tui smoke。
实现 kimi tui smoke。
失败时自动 dump artifacts。
```

验收：

```
本地登录 Claude/Kimi 后可以跑通 smoke
CI 默认不跑真实 Agent 测试
```

---

# 17. MCP Client 配置示例

Claude Desktop / Cursor 这类 MCP client 可以配置：

```JSON
{
  "mcpServers": {
    "testable-terminal": {
      "command": "node",
      "args": [
        "/path/to/testable-terminal-mcp/dist/index.js"
      ],
      "env": {
        "TESTABLE_TERMINAL_CONFIG": "/path/to/config.json"
      }
    }
  }
}
```

开发阶段：

```JSON
{
  "mcpServers": {
    "testable-terminal-dev": {
      "command": "npx",
      "args": [
        "tsx",
        "/path/to/testable-terminal-mcp/src/index.ts"
      ]
    }
  }
}
```

---

# 18. 关键风险和应对

## 风险 1：Claude/Kimi TUI 使用 alternate screen

应对：

```
@xterm/headless 维护 active buffer
snapshot 默认读 active buffer
必要时提供 include_scrollback
```

## 风险 2：输出频繁刷新导致 expect 不稳定

应对：

```
expect 每 100ms snapshot 一次
匹配当前 screen text
失败时返回 raw_tail + screen
```

## 风险 3：真实 Agent 无明确完成状态

应对：

```
不要做 wait_done 作为第一版核心
先做 expect_text / expect_regex / wait_idle
```

## 风险 4：进程残留

应对：

```
close_session 默认 kill
session timeout 自动 kill
测试结束 afterEach 清理所有 session
```

## 风险 5：权限太大

应对：

```
allowed_commands
allowed_workdirs
env redaction
max duration
max output
默认 stdio/local-only
```

---

# 19. V1 最小可用版本范围

V1 不做：

```
真实 PNG 截图
macOS Terminal.app 控制
鼠标事件
OCR
多用户远程服务
Web UI
文件编辑
通用 shell commander
```

V1 只做：

```
PTY session
write/send_key
snapshot
expect
resize
env
artifacts
security
MCP tools
```

这才是最小闭环。

---

# 20. 最终形态

最终你会得到两种使用方式。

## 20.1 AI 通过 MCP 调用

```
terminal.create_session(command="claude", rows=40, cols=120)
terminal.expect_regex("(?i)(claude|welcome|>)")
terminal.write("只回复 OK\n")
terminal.expect_text("OK")
terminal.snapshot()
terminal.dump_artifacts()
terminal.close_session()
```

## 20.2 自动化测试 Runner 调用

```Bash
npm run test:real-agent
```

或者：

```Bash
testable-terminal-mcp run examples/claude-smoke.yaml
```

---

# 21. 我的最终建议

你这个项目建议明确命名为：

```
testable-terminal-mcp
```

不要叫 DesktopCommander，不要做文件管理，不要做大而全。

核心价值就是：

```
真实 Terminal Agent 的可测试控制层
```

优先级：

```
第一优先级：
  node-pty + @xterm/headless + snapshot/expect

第二优先级：
  artifacts + security + resize

第三优先级：
  YAML runner + real agent smoke tests

第四优先级：
  macOS Terminal.app 真实窗口控制
```

一句话总结：

> **这个项目的核心不是“让 AI 执行命令”，而是“把真实 Terminal TUI 变成可观察、可输入、可断言的测试对象”。所以架构上一定要以 PTY Session + Headless Terminal Buffer 为核心，MCP 只是外层协议适配。**