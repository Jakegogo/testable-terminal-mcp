# testable-terminal-mcp

跨平台 CLI/TUI 测试基础设施：PTY + headless terminal + 沙箱 + MCP/YAML
适配器。在虚拟 HOME 里跑任何终端 agent（Claude Code、Codex、Kimi、自家
CLI），确定性捕获输出，通过 snapshot / env-diff / file-baseline 断言。

> English: [README.md](README.md)

## 它做什么

三层都暴露给用户：

1. **Tier 1 — 协议级 headless 测试**：`node-pty` 进程接到
   `@xterm/headless` parser 上。测试通过 `write` / `sendKey` / `resize`
   驱动，用 `snapshot` / `expect_text` / `expect_regex` /
   `waitForIdle` 断言。无需真终端窗口；每个 PR 跑。

2. **Tier 2 — 沙箱 + 装机测试工具集**：在虚拟 HOME（`HOME=<tmpdir>`）
   里 spawn agent —— 改 `~/.zshrc` / `~/.aikey/` 的 installer 不会污染
   开发者真 HOME。提供两种 env 抓取模式（`current` 进程内，
   `fresh-login` 模拟新开终端），断言 PATH 重复、env diff、文件改动、
   幂等性、监控路径泄漏。

3. **Tier 3 — 驱动真 Terminal.app / Windows Terminal**（M11 后期）：
   release 前的视觉 smoke；不上 PR CI。

两个 adapter 包装核心 API：

- **MCP server**（`testable-terminal-mcp` binary）—— 24 个 stdio JSON-RPC
  tools。接进 Claude Desktop / Cursor / 任何 MCP client。
- **YAML runner**（`ttm-run`）—— 用 YAML 写测试用例，`ttm-run
  case.yaml` 跑。CI 不写 JS 也能用。

## 快速开始

### 安装

```bash
git clone https://github.com/Jakegogo/testable-terminal-mcp.git
cd testable-terminal-mcp
npm ci
npm run build
```

需要 Node 20+。

### 跑一个 YAML 用例

```yaml
# examples/bash-smoke.yaml
name: bash-smoke
session:
  command: bash
  rows: 24
  cols: 80
steps:
  - expect_regex: { pattern: '\$\s', timeout_ms: 3000 }
  - write: "echo HELLO\n"
  - expect_text: { text: HELLO, timeout_ms: 3000 }
```

```bash
npx tsx src/bin/yaml-runner.ts examples/bash-smoke.yaml
# ✓ pass  bash-smoke.yaml — 3 steps
```

### 当 MCP server 用

```json
// claude_desktop_config.json
{
  "mcpServers": {
    "testable-terminal-mcp": {
      "command": "node",
      "args": ["/abs/path/to/testable-terminal-mcp/dist/bin/mcp-server.js"]
    }
  }
}
```

重启 Claude Desktop 之后能看到 24 个 tools（`terminal.*` / `sandbox.*`
/ `assert.*`）。让 agent："用 testable-terminal-mcp 起一个 bash，
echo HELLO，snapshot，关闭。"

### 当 Node 库用

```ts
import { startSession } from "testable-terminal-mcp";

const session = await startSession({
  command: "bash",
  rows: 24,
  cols: 80,
});
session.write("echo HELLO\n");
await session.waitForText("HELLO", { timeoutMs: 3000 });
const snap = session.snapshot({ range: "viewport" });
console.log(snap.plainText);
await session.close();
```

## 架构

```
                ┌───────────────────────┐
                │  Adapters             │
   stdio ──────▶│  ├─ MCP server        │
                │  ├─ YAML runner       │
   ttm-run ────▶│  └─ ttm-review CLI    │
                └───────────┬───────────┘
                            │
                ┌───────────▼───────────┐
                │  核心 API             │
                │  ├─ Session (PTY)     │
                │  ├─ 沙箱 manager      │
                │  ├─ Snapshot test     │
                │  ├─ 装机测试工具      │
                │  └─ 下载缓存          │
                └───────────┬───────────┘
                            │
            ┌───────────────┴────────────────┐
            ▼                                ▼
      ┌──────────┐                     ┌──────────┐
      │ node-pty │                     │ @xterm/  │
      │ (进程)   │ ──── pty data ───▶  │ headless │
      └──────────┘                     │ (parser) │
                                       └──────────┘
```

热路径：

- `node-pty` 把 agent 作为真 OS 进程在 PTY 后启动
- 输出字节流入 `@xterm/headless`，得到的 screen snapshot 与真终端
  渲染等价（字体 / 颜色渲染那些是 Tier 3）
- 测试驱动 `Session.write` / `sendKey`，读取 `Session.snapshot`
- 配置了沙箱时，PTY spawn 包了一层虚拟 `HOME`，生命周期受管
- Snapshot test 把屏幕状态序列化到 `.snap` 文件（insta 风格），跑
  golden-file 回归

## 模块结构

```
src/
├── bin/                  # CLI 入口
│   ├── mcp-server.ts     # testable-terminal-mcp (stdio MCP)
│   ├── yaml-runner.ts    # ttm-run
│   └── review.ts         # ttm-review
├── core/
│   ├── terminal-session.ts          # Session 类 — Tier 1 入口
│   ├── snapshot.ts                  # 屏幕捕获
│   ├── shell-wrap.ts                # login-shell wrap (POSIX + pwsh)
│   ├── sandbox/
│   │   ├── manager.ts               # mkdtemp + 生命周期 + 注册表
│   │   ├── env-injector.ts          # 三种继承模式 + PATH overlay
│   │   ├── seed.ts                  # profile (minimal/host-zshrc)
│   │   └── aikey-init.ts            # aikey `make sandbox` 集成
│   ├── install-test/
│   │   ├── env-snapshot.ts          # current / fresh-login 模式
│   │   ├── file-baseline.ts         # sha256 baseline
│   │   └── asserts/                 # 5 个 assert 工具
│   ├── snapshot-test/               # insta 风格 .snap 引擎
│   ├── download-cache/              # 多版本 binary cache
│   └── session/                     # waiters / history / viewer-bridge
└── adapters/
    ├── mcp/                         # MCP stdio adapter
    └── yaml/                        # YAML 用例 adapter
```

## 测试金字塔

420 测试 / 47 文件。默认 `npm test` 全跑；CI matrix 分 tier1 / tier2 /
windows-only。

| Tier   | 内容             | 位置                                          | 触发        |
|--------|------------------|----------------------------------------------|-------------|
| Unit   | 纯函数           | `tests/unit/`                                | 每次改动    |
| Tier 1 | PTY + bash       | `tests/integration-bash/`                    | 每个 PR (POSIX) |
| Tier 2 | 沙箱 / snapshot / 装机测试 / yaml / mcp / mock-llm | `tests/integration-{sandbox,snapshot,install-test,yaml,mcp,mock-llm}/` | 每个 PR     |
| Windows| ConPTY + pwsh    | `tests/integration-windows{,-mock-agent}/`   | windows-latest |
| Real   | 真 agent         | `tests/integration-agent/`                   | label 触发  |

子集跑法：

```bash
npm test                        # 全部，不需要真 agent
npm run test:unit               # ~分钟级，250+ 单元测试
npm run test:integration-bash   # POSIX PTY + bash (~14s)

# 真 agent（实际 API call）：本地需要 aikey 已配
RUN_REAL_AGENT_TESTS=1 npx vitest run tests/integration-agent
```

## 技术选型

- **node-pty 1.1** —— PTY 抽象（POSIX + Windows ConPTY）
- **@xterm/headless 5.5** —— terminal parser（无 DOM）
- **zod** —— 运行时 schema 校验
- **vitest** —— 测试 runner
- **TypeScript 5.4 strict + noUncheckedIndexedAccess**

无 bundler。无 ESM/CJS 体操 —— 两个 CJS dep 用 `createRequire`，其余
ESM。无 YAML lib 传递依赖 —— 自写 `yaml-mini.ts`（~250 行）只 parse
测试用例子集。

## 错误码

核心抛出的所有错误都是 `TestableTerminalError`，code 是
`src/core/errors.ts` 里的 enum。命名规范：

| 后缀         | 含义                                                  |
|--------------|-------------------------------------------------------|
| `_FAILED`    | IO / 系统级失败                                       |
| `_TIMEOUT`   | 调用方超时；可能有部分状态                            |
| `_NOT_ALLOWED` | 政策 / 安全拒绝                                     |
| `_NOT_FOUND` | 引用的资源不存在                                      |
| `_LIMIT`     | 资源上限                                              |
| `_INVALID`   | 输入 shape 合法但语义错误                             |
| `_CRASHED`   | 受管进程意外死亡                                      |

常见 code：`E_TT_EXPECT_TIMEOUT` / `E_TT_SESSION_NOT_FOUND` /
`E_TT_SANDBOX_AIKEY_INIT_FAILED` / `E_TT_ASSERT_*`。完整列表在
[src/core/errors.ts](src/core/errors.ts)。

## 编写测试用例

参见 [docs/test-patterns.md](docs/test-patterns.md) 里的模板与坑，特别是：

- TUI 启动 modal dismiss（kimi update 提示等）
- expect pattern 不能与自己的输入重叠（sentinel 模式）
- aikey 集成：`loginShell: true` + `simulatePrecmdHooks: true` 透明触发
  `precmd` hook 链

## CI

`.github/workflows/ci.yml` 定义 5 个 job：

- `tier1` —— matrix（3 OS × 2 Node）—— unit + bash integration
- `tier2` —— matrix（3 OS × Node 22）—— sandbox / snapshot / 装机测试 /
  yaml / mcp / mock-llm
- `windows-only` —— pwsh ConPTY smoke + Windows mock-agent
- `real-agent` —— PR 加 `run-real-agent` label 触发（真 API call）
- `windows-mock-agent` —— 仅 nightly cron

## 开发

```bash
# watch 模式跑测试
npm run test:watch

# 只 typecheck
npm run typecheck

# build
npm run build

# 单跑某个测试文件
npx vitest run tests/integration-bash/smoke.test.ts
```

## 贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md) 了解分支 / PR / label 约定。

## 许可证

MIT。
