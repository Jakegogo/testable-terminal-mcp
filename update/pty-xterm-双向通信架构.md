# spike PTY ↔ xterm-headless 双向通信架构

> 状态: 已实施(2026-05-05)
> 触发: codex 0.128.0 在 spike 里启动后卡住,根因是终端能力 Q&A 通道单边没接通
> 关联: [spike-验证结果.md 坑 4](./spike-验证结果.md#坑-4-xtermheadless-不响应终端能力查询-cpr--da--osc--已修复-2026-05-05)
> 代码: [spike/src/lib/session.ts](../spike/src/lib/session.ts) `attach()` + 回归测试 [spike/src/test-pty-query-response.ts](../spike/src/test-pty-query-response.ts)

## 摘要

spike 里 PTY 和 @xterm/headless 之间有**三条数据流**,前两条一直 work,第三条(终端能力 Q&A)之前只接了一半,导致严格协议派 TUI(codex 0.128.0)启动时卡住。修法是在 `Session.attach()` 加一行 `term.onData → proc.write`,把 xterm 合成的查询响应送回 PTY。

## 完整架构

```
                    ┌──────────────────────────────────────────────────────────┐
                    │              spike  Node.js  process                     │
                    │                                                          │
   ┌──────────┐     │   ┌──────────────────────────────────────────────────┐   │
   │   你的    │     │   │   Session (spike/src/lib/session.ts attach())    │   │
   │  键盘     │     │   │                                                  │   │
   │   📺      │     │   │   proc.onData(data) {                            │   │
   │  你的     │     │   │       if(mirror) process.stdout.write(data) ─┐   │   │
   │  终端     │     │   │       historyLog.write(data)                 │   │   │
   │ (iTerm)  │     │   │       this.term.write(data) ─────────┐       │   │   │
   └────┬─────┘     │   │       emit('data', data)             │       │   │   │
        │  ▲        │   │   }                                  │       │   │   │
        │  │ ①      │   │                                      │       │   │   │
        │  └────────┼───┼──────────────────────────────────────┼───────┘   │   │
        │ ②        │   │                                      │           │   │
        ▼           │   │   process.stdin.on('data', chunk =>  │           │   │
   ┌──────────┐     │   │       session.write(chunk))          ▼           │   │
   │stdin TTY │     │   │                            ┌──────────────────┐  │   │
   │stdout TTY│     │   │                            │ @xterm/headless  │  │   │
   └────┬─────┘     │   │                            │     Terminal     │  │   │
        │           │   │                            │                  │  │   │
        └──────┬────┼───┼──► session.write(chunk)    │  parser knows:   │  │   │
               │    │   │       │                    │  • \x1b[6n  DSR  │  │   │
               │    │   │       ▼                    │  • \x1b[c   DA   │  │   │
               │    │   │   proc.write ◀──────★NEW★──│  • \x1b[>c  ...  │  │   │
               │    │   │       │                    │  emits response  │  │   │
               │    │   │       │                    │  via term.onData │  │   │
               │    │   │       │                    └─────────┬────────┘  │   │
               │    │   └───────┼──────────────────────────────┼───────────┘   │
               │    │           │                              │ ③c           │
               │    └───────────┼──────────────────────────────┘               │
               │                │ via node-pty IPty                            │
               │                ▼                                              │
               │     ┌─────────────────────┐                                   │
               │     │  kernel PTY pair    │                                   │
               │     │  ┌─────┐    ┌─────┐ │                                   │
               │     │  │ M   │◀──▶│ S   │ │  M=master(spike 这端)             │
               │     │  └──┬──┘    └──┬──┘ │  S=slave(TUI 那端)                │
               │     └─────┼──────────┼────┘                                   │
               │           │          │                                        │
               └───────────┼──────────┼─── ② 路径终点(TUI 的 stdin)             │
                           │          │                                        │
                           │          ▼                                        │
                           │  ┌──────────────────┐                             │
                           │  │  TUI 进程         │                             │
                           │  │  (codex/claude/  │                             │
                           │  │   kimi)          │                             │
                           │  │                  │                             │
                           │  │  stdin  = S      │                             │
                           │  │  stdout = S      │── ① 路径起点(渲染输出)       │
                           │  │  stderr = S      │── ③a 路径起点(发能力查询)    │
                           │  └──────────────────┘                             │
                           └─── ③c 路径终点(读到响应,进行下一步渲染)              │
```

## 三条数据流

### ① 显示流(单向: 进程 → 眼睛)

`TUI stdout` → `PTY master` → `proc.onData` → 三个 fan-out:
- `process.stdout.write` → 你的终端实时渲染
- `historyLog.write` → 持久化日志
- `term.write` → xterm-headless 解析(供 snapshot / waitForRegex)

claude 实时刷新、kimi 启动 banner 都是这条。**一直 work,不需要响应**。

### ② 输入流(单向: 键盘 → 进程)

交互模式下: 键盘 → `process.stdin` → spike stdin handler → `session.write(chunk)` → PTY master → PTY slave → TUI stdin。

用户输入 `nihao` 等都走这条。**一直 work,不需要响应**。

### ③ 能力 Q&A 流(双向: TUI ↔ 终端协议)

ANSI 标准里规定的查询协议: TUI 问"光标在哪"、"你是什么型号"、"颜色配置是啥",终端**必须回答**。常见查询:

| 查询 | 含义 | xterm-headless 是否合成响应 |
|---|---|---|
| `\x1b[6n` | DSR cursor position | ✓ 回 `\x1b[<row>;<col>R` |
| `\x1b[c` | Primary Device Attributes | ✓ 回 `\x1b[?1;2c` |
| `\x1b[>c` | Secondary Device Attributes | ✓ 回 `\x1b[>0;<ver>;0c` |
| `\x1b]10;?\x1b\` | OSC 10 默认前景色 | ✗ 不回(目前 codex 不阻塞这条) |
| `\x1b]11;?\x1b\` | OSC 11 默认背景色 | ✗ 不回 |

#### 之前(BROKEN)

```
TUI 写 "\x1b[6n"  (问: 光标在哪?)
    │
    ▼
PTY master ─── proc.onData ───▶ term.write(data)
                                    │
                                    ▼
                              xterm.headless parser
                                    │ 识别出 DSR 查询
                                    │ 合成 "\x1b[1;1R"
                                    │ 通过 term.onData 事件抛出
                                    ▼
                              ❌ 没人监听 ─── 响应丢失

TUI 在 stdin 上死等响应 ──▶ 卡住
```

#### 现在(FIXED)

```
TUI 写 "\x1b[6n"
    │
    ▼
PTY master ─── proc.onData ───▶ term.write(data)
                                    │
                                    ▼
                              xterm.headless parser ─── 合成 "\x1b[1;1R" ──┐
                                                                          │
                          ★NEW★ this.term.onData(d => this.proc.write(d)) │
                                                                          │
                              proc.write(response) ◀─────────────────────┘
                                    │
                                    ▼
                              PTY master ──▶ PTY slave ──▶ TUI stdin

TUI 读到响应 ──▶ 继续渲染 ✓
```

## 为什么 claude/kimi 之前没卡

不同 TUI 框架对"问了没人答"的容错策略不一样:

| TUI | 框架 | 缺响应时行为 |
|---|---|---|
| claude | Ink (React for CLI) | 降级用默认值,继续渲染。能力探测精度受影响,但不阻塞。 |
| kimi | Ink-like | 打印 `WARNING: your terminal doesn't support cursor position requests (CPR).`,继续渲染。 |
| codex 0.128.0 | ratatui | **严格阻塞等响应才进下一步**。无响应 → banner 后无 prompt(看起来"卡死")。 |

修复后三方都受益:
- claude: 拿到精确的 cursor / DA 信息,色彩/键盘探测正确
- kimi: CPR warning 消失
- codex: 不再卡

## 修复实现

[`session.ts attach()`](../spike/src/lib/session.ts) 增加一行(带详细 why-comment):

```ts
this.term.onData((response: string) => {
  try {
    this.proc.write(response);
  } catch {
    // PTY closed mid-response — harmless, the TUI is gone anyway.
  }
});
```

`xterm-headless.d.ts` 对 `onData` 的 doc 原文:
> "Adds an event listener for when a data event fires. ... in a typical setup, **this should be passed on to the backing pty**."

—— 这次只是把 doc 里说的"typical setup"实际接上。

## 回归保护

[`test-pty-query-response.ts`](../spike/src/test-pty-query-response.ts) 用 bash loopback 实测两条 case:

```bash
stty -echo
printf '\x1b[6n'                              # bash 写 DSR 到 stdout
captured=""
while IFS= read -r -t 2 -n 1 ch; do            # bash 从 stdin 读响应
  captured="$captured$ch"
  case "$captured" in *R) break;; esac
done
printf '%s' "$captured" > /tmp/probe.bin       # 写到 tmp 验证
```

跑 `npm run spike:test-pty-query-response`:
- 正向: 2 cases pass(captured = `\x1b[1;1R` / `\x1b[?1;2c`)
- 负向(注释掉 wiring): 2 cases fail with "captured 0 bytes" — 确认能抓回归

## 第二个修复维度: mirror 路径剥离查询字节

> 触发: Apple Terminal v470 实测发现仅靠 `term.onData → proc.write` 不够,屏幕仍有可见乱码 `^[[15;1R^[[?1;2c^[]10;rgb:e6ce/...^G`

### 现象

加完 `term.onData` wiring 后,codex 在 Apple Terminal 真终端跑 spike,**功能 OK(prompt 出现、能回复)**,但屏上有可见的转义码字节,且 codex 输入框被污染。

### 根因

interactive 模式下 mirror 把 PTY 数据(包括 codex 发的 `\x1b[6n` 等查询)透传到 `process.stdout` → 用户的真终端。**Apple Terminal 也会响应这些查询**,响应字节通过 process.stdin(或 controlling-tty fallback,在 `< /dev/null` 重定向时仍然可达)回流到 spike → 转给 codex → PTY 行规则在 codex 进入 raw mode 之前回显 → mirror 又把它写到屏上。形成"双响应循环"。

### 修法

`stripTerminalQueriesFromMirror()` 在写 `process.stdout` 前 strip 查询字节:

```ts
if (this.config.mirror) {
  const safe = stripTerminalQueriesFromMirror(data);
  if (safe.length > 0) process.stdout.write(safe);
}
```

剥离规则只针对**只查不画**的字节:

| 剥离 | 保留 |
|---|---|
| `\x1b[6n` / `\x1b[5n` (DSR) | `\x1b[?1049h/l` (alt-screen) |
| `\x1b[c` / `\x1b[>c` / `\x1b[=c` (DA) | `\x1b[?2004h` (bracketed paste) |
| `\x1b[?u` (kitty kb query) | `\x1b[?1004h` (focus reporting) |
| `\x1b]<n>(;<param>)*;?<ST>` (OSC color/palette) | `\x1b[?2026h` (synchronized output) |
| | `\x1b]0;<title>\x07` (set title) |
| | SGR / cursor / 文字 / 等 |

**关键不变量**: `term.write(data)` 收到的是**未剥离**的完整字节。xterm-headless parser 仍然识别查询、合成响应、通过 `term.onData` 抛出。剥离只发生在 mirror 一条路径上 —— 真终端看不到查询而已。

### 完整数据流(双修复后)

```
codex 发 "\x1b[6n"
    │
    ▼
PTY master ──proc.onData──┬─► stripTerminalQueriesFromMirror(data)
                          │       │
                          │       └─► process.stdout (真终端) ── 查询已删,无响应循环 ✓
                          │
                          ├─► historyLog.write(data)         ── 完整字节,日志保真
                          ├─► appendRawHistory(data)         ── 完整字节
                          │
                          └─► term.write(data)               ── 完整字节
                                  │
                                  ▼
                              xterm.headless parser
                                  │
                                  │ 合成响应 "\x1b[1;1R"
                                  ▼
                              term.onData ──► proc.write ──► PTY ──► codex stdin ✓
```

### 单测

`stripTerminalQueriesFromMirror` 在 `test-pty-query-response.ts` 里有专门的纯函数单测(`caseStripperUnit`):
- 11 类查询字节断言被剥离(DSR、5 类 DA、kitty、4 类 OSC color/palette)
- 11 类显示状态字节断言保留(alt-screen、SGR、bracketed paste、focus reporting、sync output、title、DSR/DA 响应等)
- 真实 codex 启动 burst 端到端断言: 查询消失,模式设置和标题保留

## 已知不修

- **`\x1b[?1004h` 焦点上报**: 不是查询是模式开关,**没 strip**。如果用户在 Apple Terminal 切窗口/聚焦,真终端会送 `\x1b[O` `\x1b[I` 焦点事件到 stdin → 转 codex。这些是 codex 自己开启 focus 上报后预期的事件,不是 bug。如果未来某 TUI 不开启 focus 还要清屏,可加上 strip 这条。
- **OSC 10/11/12 颜色合成响应**: xterm-headless parser 没内置合成。codex 不阻塞等这条,我们也已 strip 不让真终端响应,所以**根本不需要响应**。如果未来某 TUI 既阻塞又必须颜色,可在 `attach()` 里挂 `parser.registerOscHandler(10, () => term.input("\x1b]10;rgb:0/0/0\x1b\\"))`。
