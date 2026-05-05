# spike: 验证 node-pty + @xterm/headless 能驱动真实 TUI

> 一次性方案预研代码,不是产品代码。
> 唯一目的:在投入完整工程之前,验证 `node-pty + @xterm/headless` 这条通路能不能真的驱动 Claude / Kimi。

## 验证目标

只验证 4 件事:

1. **能起进程**: `node-pty` 把 `claude` / `kimi` 拉起来,并且它们以为自己在真终端里(不会因为检测不到 TTY 退出)
2. **能拿屏幕**: 把 PTY 字节流喂给 `@xterm/headless`,从 buffer 读出可读文本(不是乱码、不是 ANSI 残渣)
3. **能输入**: `proc.write("...")` 真的被 TUI 当作用户输入接收
4. **能识别响应**: 让 Agent 回 "OK",从 headless buffer 里 `includes("OK")` 命中

如果 4 件都成立,正式工程方案可以推进。如果有任何一项不成立,需要先调整方案再继续。

## 前置条件

- Node ≥ 20
- macOS / Linux(Windows 不在 spike 范围)
- macOS 装 Xcode Command Line Tools(`xcode-select --install`),否则 `node-pty` 编译不过
- 终端里 `claude` 和 `kimi` 命令本来就能跑(已登录、PATH 里能找到)

## 安装

```bash
cd tools/testable-terminal-mcp/spike
npm install
```

如果 `npm install` 失败,八成是 `node-pty` 编译报错 —— 那就是这个 spike 要回答的"环境问题",记下报错继续 debug。

## 运行

### 1. 先用 bash 验证工具链(必跑,作为基线)

```bash
npm run spike:bash
```

期望: stderr 有 `MATCH: found "SPIKE_OK"`,退出码 0,snapshot 里能看到 `SPIKE_OK`。

如果这步过不了,问题在 spike 自己 / 环境,跟 Claude/Kimi 无关。

### 2. Claude TUI smoke

```bash
npm run spike:claude
```

发送 prompt `reply with the single word OK and nothing else`,然后等 60s 内屏幕上出现 `OK`。

观察点:
- `[spike] after-startup` 的 snapshot 应该能看到 Claude 的欢迎界面或输入框
- 写入 prompt 后,snapshot 里能看到你输入的文字回显
- Claude 响应后,snapshot 里能看到 `OK`(可能旁边有其他文字也无所谓)

### 3. Kimi TUI smoke

```bash
npm run spike:kimi
```

同上,Kimi 版本。

### 4. 验证 zshrc / zprofile 是否真的加载(login-shell wrapper)

```bash
npm run spike:env
```

打印当前 `$SHELL -ilc` 下的: SHELL/ZSH 版本、PATH 全部条目、claude / kimi / brew / aikey 等命令解析、aliases、rc-only env vars(EDITOR/GOPATH/HOMEBREW_PREFIX 等)。

判断标准:

- `PATH` 里有用户在 zshrc 加进去的目录(`~/.local/bin`、`/opt/homebrew/bin`、go SDK 等)
- `claude` / `kimi` 解析到合理位置(可能是 alias 名,而不是 NONE)
- `EDITOR` / `HOMEBREW_PREFIX` 等 rc-only 变量有值

如果这些都对,说明 `--login-shell` 包装是有效的,后续 `spike:claude` / `spike:kimi` / `spike:claude:ask` 跑出来的 TUI 是在真实用户 env 下运行的。

`spike:env` 用的是独立的 `src/diagnose-env.ts`,直接 `spawn $SHELL -ilc <probe>` 收 stdout(不走 PTY headless),最可靠。

### 5. 交互模式(肉眼验证)

```bash
npm run spike:claude:interactive
# 或
npm run spike:kimi:interactive
```

你的键盘输入会被原样转给 TUI,体验上和直接跑 `claude` 没区别,但底层走的就是 spike 这条路。

热键:
- `Ctrl+]`  → 打印当前 headless buffer 的 snapshot 到 stderr(肉眼比对屏幕和 snapshot 是否一致)
- `Ctrl+\`  → 杀子进程并退出 spike

这是判断 headless 渲染保真度最直接的方式。

### 6. login-shell 模式细节

所有 `spike:claude*` / `spike:kimi*` 命令默认带 `--login-shell`,意思是把目标命令包装成:

```
$SHELL -ilc 'exec <command> <args...>'
```

- `-i` interactive → 加载 `~/.zshrc`
- `-l` login → 加载 `~/.zprofile`
- `exec` 让 child 替换 shell 进程,PTY 前台进程仍是 claude/kimi 自己,kill PTY 直接 kill agent,不留中间 shell

如果目标命令本身就是 shell(例如 `tsx src/spike.ts zsh --login-shell`),wrap 改为给 shell 加 `-il` flag,避免 shell 嵌 shell。逻辑见 [src/lib/shell-wrap.ts](src/lib/shell-wrap.ts)。

显式禁用(直接 spawn,只继承 npm 进程的 env):

```bash
tsx src/ask-claude.ts --no-login-shell "your message"
tsx src/spike.ts claude --no-login-shell --prompt '...' --expect '...'
```

## 怎么算通过

| 维度 | 通过标志 |
|------|----------|
| 起进程 | `[spike] pid=...`,而不是 `FAILED to spawn` 或 Claude 自己退出 |
| 拿屏幕 | snapshot 里能看到与肉眼几乎一致的 TUI 内容(列宽对、没有大量 ANSI 残渣) |
| 能输入 | 写入 prompt 后,snapshot 里能看到 prompt 本身被回显 |
| 识别响应 | scripted 模式 `MATCH: found ...`,退出码 0 |

## 怎么算不通过 / 怎么继续

| 现象 | 含义 | 下一步 |
|------|------|--------|
| `npm install` 失败 | node-pty 编译环境问题 | 装 Xcode CLT;若仍不行,考虑用 prebuilt binary |
| Claude / Kimi 启动后立即退出 | TUI 没认 PTY,或环境变量不对 | 调整 `env`,加 `--mirror` 看 raw 输出再判断 |
| snapshot 里全是 ANSI 控制码字符 | xterm/headless 没接管 buffer | 检查 `term.write(data)` 调用 |
| snapshot 里只有早期内容,看不到最新输出 | 用了 alternate screen 但读了错的 buffer | 先确认 `term.buffer.active` 是否切到 alt 了,可能要读 `buffer.normal` |
| Claude TUI 正常,但 expect "OK" 一直 timeout | 屏幕有 `OK` 但被 ANSI 颜色 / 多列布局拆开 | 看 `on-timeout` snapshot,必要时改 expect 用 regex |

## spike 完成后

- 把 4 个验证维度的实际结果记到 [../update/spike-验证结果.md](../update/spike-验证结果.md)(走 update 目录变更流程)
- spike 代码可以保留作为回归参考,但**不进**正式 `src/`
- 拿到验证结果后,再回到 [../技术方案.md](../技术方案.md) 第 16 节"待决策项"和 [../分阶段实施方案.md](../分阶段实施方案.md) M1 启动检查清单,正式开工

## 已知不验证的事

- 安全(allowlist、redact)— spike 完全不管
- artifact / event / 错误码 — spike 不管
- MCP / YAML adapter — spike 完全不存在这一层
- 资源限制 — spike 不管
- 这些都是正式工程方案的内容,跟 spike 的"通路验证"目标无关
