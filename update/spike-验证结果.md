# spike 预研验证结果

> 状态: 已经执行
> 执行时间: 2026-05-01
> 上下文: 正式投入工程之前,通过一次性 spike 验证 `node-pty` + `@xterm/headless` 能否驱动真实 TUI Agent
> 决策影响:[../技术方案.md](../技术方案.md)、[../分阶段实施方案.md](../分阶段实施方案.md)

## 1. 环境

| 维度 | 值 |
|------|-----|
| OS | macOS 25.4.0(Darwin) |
| 架构 | arm64 |
| Node | v25.8.2 |
| node-pty | 1.1.0(prebuilt arm64) |
| @xterm/headless | 5.5.x |

## 2. 验证结果

### 4 个核心维度

| # | 维度 | bash | Claude (v2.1.126) | Kimi (1.37.0) |
|---|------|------|-------------------|---------------|
| 1 | 起进程 | ✅ | ✅ | ✅ |
| 2 | 拿屏幕(headless 渲染) | ✅ | ✅ | ✅ |
| 3 | 能输入 | ✅ | ✅ | 🟡 受前置 modal 影响,未单独验证 |
| 4 | 识别响应(expect 命中真实回复) | ✅ | ✅ | ❌ Kimi 本地未登录,无回复 |

**结论**: 工具链(node-pty + @xterm/headless)在 macOS arm64 + Node 25 上可行。Claude TUI 端到端跑通,Kimi 渲染正常,失败原因是用户环境(未登录),不是工具链。

### Claude smoke 真实输出片段

prompt: `compute seven plus eight, reply with only the resulting number, no words`
expect: `15`(prompt 文字里完全不含 "15")

snapshot 命中时:

```
❯ compute seven plus eight, reply with only the resulting number, no words

⏺ 15

✻ Crunched for 2s
```

**真命中**,而非假阳性。

## 3. 实施中踩到的坑(必须回流到正式方案)

### 坑 1: node-pty 1.1.0 的 spawn-helper exec bit 被 npm 剥掉

- **现象**: `posix_spawnp failed.`,看似 node-pty 整体崩
- **根因**: `node_modules/node-pty/prebuilds/<plat-arch>/spawn-helper` 缺执行位(`-rw-r--r--`),`posix_spawn` 调不起来
- **修复**: `chmod +x` 即可
- **正式方案影响**: 必须加 postinstall hook
  ```json
  "postinstall": "chmod +x node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true"
  ```
  spike 的 `package.json` 已经加了,正式版要同步。
- **修复传播范围**: 任何依赖 node-pty 1.1.x 的 package.json 都得加这条 postinstall

### 坑 2: bracketed paste 让 Enter 失效(关键 API 设计教训)

- **现象**: `proc.write("text\r")` 一次性写入,Claude/Ink 把整段当 paste,`\r` 被当成 paste 内容(换行)而不是 Submit。短 prompt 偶尔幸运通过,长 prompt 必失败。
- **根因**: TUI(基于 Ink、Textual 等)做 paste 检测,看 stdin 数据的时间分布。瞬时收到大量字符 + 内嵌 `\r` 会触发 bracketed paste 模式。
- **修复**: text 和 `\r` 分两次写入,中间间隔 ≥100ms,让 Enter 当独立按键。spike 用 150ms。
- **正式方案影响**(直接改写 [技术方案.md](../技术方案.md) 第 6 节 MCP Tool 列表):
  - `terminal.write(text)` **绝对不要**默认拼接 `\r`/`\n`。文档明确说明:write 只送字符串,不送 Enter。
  - 提交输入必须走 `terminal.send_key("enter")` 单独的 tool 调用。
  - 文档加一段"为什么 write 和 send_key 必须分开",防止下一个使用者踩坑。
  - 可考虑加便利方法 `terminal.submit(text)` 内部自动处理 write→delay→Enter,但 default API 保持原子。

### 坑 3: dwell-then-write 是脆弱模式,Claude 启动 ≥6s

- **现象**: 3s dwell 不够 Claude 完成启动 → 切 alternate screen → 注册 stdin handler。prompt 写得太早会被原始 TTY echo 到 main buffer 上(snapshot 顶部出现裸 prompt 文字),Enter 也丢失。
- **修复**: dwell 8s 在我环境里足够,但每个 TUI 都不一样,这是脆弱兜底。
- **正式方案影响**:
  - **不要**鼓励"create 后固定 dwell 再 write"的模式。
  - 新增**最佳实践**写到文档:`create_session` 后必须先 `expect_regex` 等 ready 指示符出现(如 `❯|>|\$ `),再 write/send_key。
  - YAML runner 可以考虑加 `wait_ready: { pattern: "❯|>", timeout_ms: 15000 }` 作为 session 配置层的可选项,自动在 create 后注入这一步。
  - example YAML 必须演示这个模式。

### 坑 4: @xterm/headless 不响应终端能力查询(CPR / DA / OSC) — **已修复 2026-05-05**

- **现象(原始 — Kimi 时代)**: Kimi 启动时打印 `WARNING: your terminal doesn't support cursor position requests (CPR).` —— 不阻断,UI 仍渲染。
- **现象(新触发 — codex 0.128.0)**: codex 启动后 banner 渲染完就**卡住**,不出 `›` prompt。诊断发现 codex 发 `\x1b[6n`(DSR cursor position)、`\x1b]10;?`、`\x1b]11;?`(OSC 10/11 默认前/后景色查询)等终端能力查询并**严格阻塞等响应**;claude / kimi 是 Ink-based,容错友好不阻塞,所以之前没暴露。
- **真根因(2026-05-05 复盘)**: 错的不是 xterm.headless 的 parser —— 它**已经**实现了 DSR / Primary DA / Secondary DA 的响应合成,通过 `term.onData` event 发出。错的是 spike `session.ts attach()` 只 wire 了 `proc.onData`(PTY → xterm)单向,**没** wire `term.onData`(xterm → PTY),导致合成响应被丢弃。xterm.js 的 `onData` doc 原文说 "in a typical setup, this should be passed on to the backing pty" —— 之前这一条没接上。
- **修复(双管齐下)**:
  1. **正向: term.onData → proc.write 接通响应通路**。`spike/src/lib/session.ts` `attach()` 加 `this.term.onData(d => this.proc.write(d))`。xterm.headless parser 已经合成的 DSR / DA 响应不再被丢弃,直接送回 PTY,codex 拿到响应才能进入 prompt。
  2. **反向: mirror path 剥离查询字节**(round 12 增量,Apple Terminal v470 实测后追加)。`stripTerminalQueriesFromMirror()` 在写 `process.stdout` 前 strip `\x1b[6n` / `\x1b[c` / `\x1b]10;?` 等查询,**真终端根本看不到 → 不会回响应 → 不会污染输入字段**。否则 interactive + mirror 模式下,Apple Terminal v470 会自动响应被 mirror 出来的查询,响应字节通过 process.stdin(或 controlling-tty fallback)回流到 codex stdin,显示为可见乱码 `^[[15;1R^[[?1;2c^[]10;rgb:e6ce/...^G`。
  3. **回归测试**: `spike/src/test-pty-query-response.ts` 共 3 cases —— DSR loopback / Primary DA loopback(bash 真发查询验证响应循环) + stripper 纯函数单测(11 类查询全 strip + 11 类显示状态全保留 + 真实 codex 启动 burst 端到端断言)。
  4. **三个 CLI 都受益**: claude / kimi 的 CPR warning 自动消失,codex 卡住消失,Apple Terminal 下 mirror 输出干净,未来任何发 CSI 查询的 TUI 直接无缝跑通。
- **不在范围**:
  - OSC 10/11/12 颜色查询的合成响应:xterm-headless parser 没自带,codex 也不阻塞等(只查不强求)。但**查询字节我们已经 strip 不让真终端响应**了,所以也不会污染。如果后续某 TUI 既阻塞又要颜色,在 attach() 里挂 OSC handler 自合成 `rgb:0/0/0` 即可。
  - 焦点上报字节(`\x1b[?1004h` mode-setter)**没 strip**(它是显示状态不是查询)。如果用户在 Apple Terminal 切窗口,真终端会送 `\x1b[O` / `\x1b[I` 焦点事件到 stdin → 转 codex。这些是 codex 自己开启 focus 上报后预期的事件,不是 bug,但视觉上可能在屏上闪一下。如果有需要可后续把 mode-setter 也 strip。
- **运行验证**:
  - `npm run spike:test-pty-query-response` ✓ 3 cases pass(DSR + DA loopback + stripper 单测 22 子断言)
  - `npm run spike:codex:interactive` ✓ Apple Terminal v470 上 banner 后 Tip 行 + cursor 移到 `[17;3H`(prompt 位置)+ **mirror 输出无可见查询/响应字节**

### 坑 4b: 100% CPU 孤儿进程 — Session.close() / 全局 signal 清理(已修复 2026-05-05)

- **现象**: 用户多次跑 `(npm run ... & SPIKE_PID=$!; sleep N; kill $SPIKE_PID; wait)` 测试后,系统残留多个 codex 进程占 100% CPU。
- **根因**: codex 0.128.0(以及其他 ratatui 风格的 TUI)在 PTY master 关闭时,stdin read 反复返回 EIO,主循环没正确处理 → 忙循环。spike 之前的清理逻辑有三个漏:
  1. **`Session.close()` 只发 SIGTERM,不升级 SIGKILL** —— codex 不响应 SIGTERM 就一直留着(即使 `gracefulTimeoutMs` 到期也只是 force-resolve Promise,没真正 kill)。
  2. **全局只 hook `SIGINT` / `SIGTERM` / `beforeExit`**,**没 hook `SIGHUP`** —— 当 npm 父进程死掉、kernel 给孤儿 spike 发 SIGHUP 时,node 默认行为是直接终止,cleanup hook 不跑,codex 留下来继续 100% CPU。
  3. **SIGINT/SIGTERM 处理只发一次 SIGTERM 就 `process.exit()`** —— 没给 SIGKILL 升级的机会。
- **修复**(三处):
  1. `Session.close()` 升级阶梯: SIGTERM → 等 `gracefulTimeoutMs` (默认 1500ms) → SIGKILL → 等 500ms → force-resolve。SIGKILL 不可阻塞,保证子进程死。
  2. 全局 cleanup 加 `SIGHUP` handler;同样阶梯升级:SIGTERM 给所有 `liveSessions`,500ms 后 SIGKILL stragglers,然后 `process.exit()`。
  3. `beforeExit`(graceful node 退出,无信号触发)同步发 SIGTERM + SIGKILL(不能用 setTimeout 因为 sync 上下文)。
- **回归测试**: `npm run spike:test-pty-cleanup`,2 cases:
  - SIGHUP listener 注册检查
  - SIGKILL 升级实测: 跑一个 python `signal.SIG_IGN` 忽略 SIGTERM/HUP/INT 的"顽固子进程",验证 `close({ gracefulTimeoutMs: 500 })` 能在 500-1500ms 内完成 + 子进程被 reaper(`exited === true`)。
- **用户侧最佳实践**: 跑 spike 时仍然推荐用进程组 kill(`set -m`+ `kill -- -$SPIKE_PID`)而不是 `kill $SPIKE_PID`,这样信号直接发到整个 PTY 子树,即使 spike 本身的 cleanup 失效也兜底。但这不再是必需的 —— spike 自己的清理已经能兜住绝大多数场景。

### 坑 5: TUI 启动时常有"前置 modal"挡路

- **现象**: Kimi 一启动先弹 update 提示(Enter=升级 / q=跳过 / s=跳版本)。直接 send 业务 prompt 会被 modal 拦截或 Enter 被 modal 吞掉。
- **影响**: 正式版的真实 Agent smoke 测试如果不处理 modal,会随机 flaky。
- **正式方案影响**:
  - 测试模板要支持"先 send key 清 modal,再 send prompt":
    ```yaml
    steps:
      - expect_regex: "(?i)(welcome|❯|>)"   # 等到主界面
      - send_key: q                          # 清掉可能的 update modal
      - write: "real prompt"
      - send_key: enter
      - expect_text: "..."
    ```
  - 文档段:"Real Agent smoke 模板",列出常见 modal 对应的 dismiss 按键。

### 坑 6: expect 字符串与 prompt 重叠 = 假阳性

- **现象**: prompt 含"OK",expect 也是"OK",prompt 一被 TUI 回显,expect 立刻命中,但 Agent 根本没回复。
- **正式方案影响**:
  - `terminal.expect_text` / `expect_regex` 文档加一行**红字**:"Pattern must not appear in your own input — use a token your prompt cannot contain (a number, a unique sentinel)."
  - example YAML 演示 sentinel 模式。

### 坑 7: 不走 login-shell wrap,Claude 拿不到 zshrc 的 env / PATH 扩展(实测对比)

- **现象**: 直接 `pty.spawn("claude", [], { env: process.env })` 启动的 Claude,与在 Terminal.app 里手动启动的 Claude,**env 不一致**。zshrc / zprofile 里 `export` 的变量、PATH prepend、aliases 全部丢失。
- **实测**: 同一 prompt(让 Claude 用 Bash tool 跑 `echo $HOMEBREW_PREFIX $EDITOR $(echo $PATH | cut -d: -f1) $GOPATH`)在两种模式下输出:

  | 变量 | `--login-shell` | `--no-login-shell` |
  |------|-----------------|---------------------|
  | HOMEBREW_PREFIX | `/opt/homebrew` | `/opt/homebrew`(macOS 系统级) |
  | GOPATH | `/Users/jake/go` | `/Users/jake/go`(macOS 系统级) |
  | EDITOR | `vi` | **空字符串**(zshrc-only,丢失) |
  | PATH[0] | `/Users/jake/.aikey/bin` | `/opt/homebrew/.../python@3.14/...`(**完全不同**) |

- **机制**: `$SHELL -ilc 'exec <cmd>'`
  - `-i` 让 shell 当 interactive 启动,source `~/.zshrc`
  - `-l` 让 shell 当 login,source `~/.zprofile` / `~/.zlogin`
  - `exec` 用 execve 替换 shell 进程,新进程继承当前 env(包含刚 source 的所有 export)
  - PTY 前台进程仍是目标 cmd,kill 干净
- **对 aikey-cli 测试的关键影响**:
  - aikey 通过 `export PATH=~/.aikey/bin:$PATH` 在 zshrc 里把 wrapper 放 PATH 最前来拦截真 claude / kimi
  - **不带 login-shell**: PATH 顺序是 npm 进程链注入的(python 等其他路径在前),wrapper **拦截失效**,Claude 跑的是上游 Anthropic CLI,绕过 aikey 的代理 / 计费 / 拦截
  - **必须带 login-shell** 才能测到 aikey 的核心机制
- **正式方案影响**:
  - `terminal.create_session` 必须支持 `login_shell: boolean` 选项
  - **默认 true**: Real Agent 测试场景下,90%+ 用户希望模拟真实 macOS Terminal.app env
  - YAML runner 的 `session` 配置同样支持
  - 文档要明确"alias / shell function 不会传播"(POSIX 限制),需要把 wrapper 做成真正的可执行文件,不能仅靠 alias
  - 已知限制段:Windows 下 `-ilc` 不适用,需要单独的 PowerShell wrap 策略(V1 不做)
- **修改回流到 [../技术方案.md](../技术方案.md)**:
  - 第 5.2 节 `TerminalSnapshot` 与 `TerminalSessionConfig`: 加 `login_shell: boolean`(默认 true)
  - 第 6 节 `terminal.create_session` 输入参数: 加 `login_shell`
  - 第 9.3 节 env 安全模型: 说明 login-shell 模式下 env 来源是 caller-provided + zshrc-loaded(后者不可枚举,因此 redact 仍按 caller-provided + spawn 进程实际 env 双层处理)
  - 第 14 节 已知限制: alias/function 不跨进程

## 4. 对正式方案的具体回流

> 状态: **已应用**(round 1-12 全部回流到 [整体方案.md](../整体方案.md) / [技术方案.md](../技术方案.md) / [分阶段实施方案.md](../分阶段实施方案.md))。
>
> 本节分两部分:
> - **§4.1 当前生效决策**: 实施 agent 直接看的"当前是什么"(短表,只列结论)
> - **§4.2 修订历史 audit**(折叠): round 1-12 的演进过程(查 history 用,日常无需读)

### 4.1 当前生效决策

#### 工程层决策(影响 API / 架构)

| 决策 | 当前形态 | 主要文档位置 |
|------|---------|-------------|
| Wait 机制 | 5 个 wait 函数 + 事件驱动 + race(exit / ready / settled) | 技术方案 §1 / 分阶段 M2-M3 |
| Snapshot | active buffer + ANSI opt-in + `range: viewport \| all \| { lastLines: 200 }` 默认 lastLines:200 | 技术方案 §4 / §13 |
| 进程清理 | `setsid` 进程组 + 全局 `liveSessions` Set + SIGINT/SIGTERM/beforeExit hook | 技术方案 §8.4 / §8.5 |
| Login-shell wrap | `$SHELL -ilc 'exec <cmd>'`(POSIX)/ `pwsh -NoLogo -Command`(Windows);默认 true | 技术方案 §9 |
| Display 模式 | `"headless" \| "open-terminal" \| "auto"`,默认 headless;MCP adapter 默认 auto | 整体方案 §3.5 / 技术方案 §9.4 |
| History API | 内存 ring buffer 20MB + 4 个 getter(`getRawHistory*` / `getCleanHistory` / `getHistoryStats`)+ 可选 `historyLogPath` 文件镜像 | 技术方案 §1 / §4 |
| Sandbox(虚拟 HOME)| 三模式 envInheritance(默认 `all_with_overlay`)+ denyKeys + `allowCallerSecretEnv` + `~/Library/...` 占位 | 整体方案 §5.2 / 技术方案 §11.2 / §11.2.1 |
| aikey 集成 | `cd <aikey>/workflow/CI && HOME=<sbx> make sandbox`,4 步 probe + warn-skip 兜底 | 整体方案 §5.4 / 技术方案 §11.4 |
| 多版本 install | 沙箱内独立 binary + ~/.cache/ttm/downloads/ tarball cache + LRU + sha256 校验 | 整体方案 §5.5 / 技术方案 §12 |
| Snapshot 测试 | Insta 风格(.snap 文件 + mask 库 + `ttm review` accept/reject)+ ANSI opt-in(Windows 降级 warn) | 技术方案 §13 / 分阶段 M7 |
| Install-test toolkit | 6 个 assert + `terminal.env_snapshot({mode: "current"\|"fresh-login"})` + fresh-login 默认 + Node JSON 采集器(host `process.execPath`)+ `assert.monitored_paths_unchanged`(deny-list 命名)| 技术方案 §11.6 / 分阶段 M6 |
| Tier 3 真终端 | macOS osascript + AppleScript;Windows WinAppDriver;Linux 不做;release 前手动 + workflow_dispatch | 整体方案 §6 / 技术方案 §14 / 分阶段 M11 |
| CI matrix | GH Actions macOS/Linux/Windows × Node 20/22;real-agent 走 label;Windows 走 nightly mock-llm-server | 整体方案 §7 / 技术方案 §15 / 分阶段 M9-M10 |

#### MCP / Lib API 层决策

| 决策 | 形态 |
|------|------|
| MCP tool 总数 | **24 个**(14 `terminal.*` + 3 `sandbox.*` + 6 `assert.*` + 1 `terminal.env_snapshot`),M9 验收按"每 tool 至少 3 类边界"语义,不再硬编码 96 case |
| ErrorCode 总数 | 33 个(`E_TT_*`),命名约定:`*_FAILED`(IO/系统)/ `*_TIMEOUT`(等待)/ `*_NOT_ALLOWED`(策略)/ `*_NOT_FOUND`(引用)|
| `terminal.write` | 不拼接 `\r`,Enter 必须走 `terminal.send_key("enter")`;有 ~150-500ms paste-safe delay 控制 |
| `terminal.snapshot` | 默认 `range: { lastLines: 200 }`;`include_ansi` opt-in;`viewport` / `all` 可选 |
| 高亮检测 | lib 不内置 finder,caller 写 1 行 lambda(aikey 用 `> ` 文本 / Ink 用 ANSI inverse / readline 用 cursor)|
| `liveLogPath` / `liveLogTitle` 命名 | round 8 重命名为 `historyLogPath` / `viewerWindowTitle`(MCP snake_case 同步)|

#### Spike 实施踩坑(已修,M1-M11 实施时直接用修复版)

| 坑 | 修法 |
|----|------|
| node-pty 1.1.0 spawn-helper 缺 exec bit | M1 加 postinstall `chmod +x prebuilds/*/spawn-helper` |
| AppleScript 不识别 `\033` / `\007` | viewer 用 `set custom title of newTab` 原生 API + osascript stderr pipe 不再 silent fail |
| `term.write` 异步,scheduleChange 早触发 | 用 `term.write(data, callback)` 完成回调作为 screen-changed 触发点 |
| spike.ts false-pass(无 expect 时强返 0)| 末尾用 child exit code 兜底 + aikey-test 计 failures `process.exit(1)` |
| liveSessions 全局 Set 从未填充 | startSession 后 `liveSessions.add` + `once('exit', delete)` |
| codex 启动比 claude 慢 + prompt 字符 `›` 非 `❯` | spike.ts 加 `--settled-stability` / `--prompt-enter-delay` flag,settled 兜底 4s + paste delay 500ms |
| node-pty 缺 d.ts → tsc 失败 | 加 `src/types/node-pty.d.ts` ambient module 声明 |
| 沙箱 child 启动后立即退出 → spike `Session.write` 抛 → 全局 catch 吞 0 | runScripted 检 `session.stats().exited`,已退出跳过 write/expect + 用 child exit code |

#### Aikey 集成发现(归 aikey 项目修)

| 发现 | 位置 |
|------|------|
| `~/.aikey/active.env` 只在 precmd hook 触发时被 source,非 prompt shell(`zsh -ilc <cmd>`)看不到 env | aikeylabs/workflow/CI/bugfix/2026-05-05-hook-active-env-not-loaded-without-precmd.md(已修复)|

#### V2+ 留坑(显式排除本期)

| 项 | 原因 |
|----|------|
| `assert.no_orphan_processes` / `assert.command_resolves_to` | round 2 R2-4 决策,V1 不做 |
| Linux Tier 3(GUI Terminal 自动驱动)| 整体方案 §10 不做清单 |
| Real Agent 在 Windows CI 跑真模型 | round 2 P1-2 决策,V2 评估 |
| Windows ps5 / cmd.exe 支持 | round 7 决策,V2 评估 |
| B 类 emulator-vs-emulator 视觉差异 | round 1 评审决策 |

### 4.2 修订历史 audit(折叠)

> 仅供溯源 / 复盘 / 撤销决策时查证。日常实施不需要读这一段。

<details>
<summary>展开 12 轮 round 历史</summary>

| Round | 来源 | 主要内容 |
|-------|------|---------|
| 1(spike 7 坑)| spike 实测 | poll→事件驱动 / snapshot active+hash / setsid / env passthrough allowlist / allowedCommands 默认空 / expect 重叠假阳 / login-shell 必须 |
| 1(决策)| 用户拍板 | `make sandbox` 集成 / 沙箱内独立 binary / Windows ConPTY+pwsh / Insta snapshot / 三 OS CI matrix / Tier 3 半自动 / `aikey_makefile_dir` 路径 |
| 2 | 用户 + R2-1..6 | envInheritance 三模式 + denyKeys / Install-test toolkit(6 assert)/ P2 工具留 V2 / `~/Library` 占位 / `/etc/zshrc` 默认监控 / install-test fixture(zsh+bash)|
| 3 | 用户(MCP live preview)| display 三模式 + viewer.ts(macOS/Linux/Windows)+ live log 文件 |
| 3(spike 实施)| spike 踩坑 | viewer AppleScript `\033` 报错 → 改用 `set custom title` API + stderr pipe |
| 4 | 用户(aikey use 测试)| `waitForChange` / `waitForExit` 两 lib API + `terminal.expect_change` / `wait_exit` MCP tool + 高亮检测策略不强加规范 |
| 5 | 用户 + spike 排查 | SnapshotRange 类型(默认 lastLines:200)+ 修 viewport 读 buffer 顶端 bug + race(exit\|ready\|idle) + waitForIdle.requireFirstEvent |
| 6 | 用户(history API)| 内存 ring buffer + 4 getter + `historyLogPath` 重命名 + ANSI strip 容忍 |
| 7 | 第三方评审 | env_snapshot 双模(install-test 默认 fresh-login)+ M9 schema 数纠正 + M0.5 Windows mini-spike + M2 viewer 拆 test:viewer + denyKeys 与 caller env 两层语义 + 改名 monitored_paths_unchanged |
| 8 | 第三方评审 | tool 数 21→24 + 96 case + fresh-login 改 Node JSON + M0.5 完整章节 + 版本边界对齐 + 整体方案 §5.2/§5.6/§12 收口 + history_log_* 重命名 + bash/zsh 加载链对照表 |
| 9 | 第三方评审 | M6 残留 fresh-login 旧命令 + M6 旧 API 名(`no_files_outside_sandbox`)全清 + M0.5 验收分两类阻塞性 + 整体方案 §3.5 live-pty.log → history-log + 平台覆盖矩阵 M0.5 行 |
| 10 | 第三方代码评审 | liveSessions cleanup 失效 / spike.ts false-pass / xterm.write 异步 / tsc 不过(4 个真代码 bug 全修) |
| 11 | 用户实测 codex | spike 配置参数化(`--settled-stability` / `--prompt-enter-delay`)+ aikey hook bootstrap source bugfix(影响所有 wrapper 在非 prompt shell 中跑)|
| 12 | self-review | docs 可读性塌陷(本节即重写产物)+ M0.5 失败 → README 免责矩阵 + M5 拆 M5a/M5b 解外部依赖 + M2 加 session.ts 拆分计划 + M9 schema case 改语义 + Linux open-terminal 顺手验证 |

后续每轮 review 在本 audit 表追加 1 行,不再展开复述细节(详细位置统一指向 §4.1)。

</details>

## 5. 未验证的部分

spike 没碰、留给正式工程验证:

- 真实 ctrl_c 中断 Agent 思考的中段行为(Claude/Kimi 中段是否能干净 cancel)
- 长时间会话(>10min)下 PTY buffer 的稳定性
- 多 session 并发下的资源消耗
- 安全约束(allowlist / cwd / env redact)的实际拦截
- alternate screen 与 scrollback 的边界(目前我们只读 active buffer)
- artifact 体系(spike 完全没做)
- MCP / YAML adapter 端到端

这些都不是"通路验证"问题,而是工程问题,留给 M1-M6。

## 6. 预研结论

**通路验证通过,可以推进正式工程方案。**

修正 6 个坑之后,工具链可以稳定驱动 Claude / 大概率 Kimi(待登录后复测) / aikey-cli。

下一步: 按 [分阶段实施方案.md](../分阶段实施方案.md) 启动 M1。M1 启动前先把第 4 节"对正式方案的具体回流"应用到方案文档。
