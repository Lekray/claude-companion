# Claude Code Companion

一个无依赖的 VS Code 扩展（`lekra.claude-companion`），为官方 **Claude Code** 扩展（`anthropic.claude-code`）补上它缺少的功能：

- **状态栏会话状态** —— `~` 正在工作，`?` 等待你，`V` 已完成，`!` 出错，并显示各状态的会话数量。点击状态栏项会打开当前窗口的会话菜单，选中即可聚焦对应的 Claude 标签页。
- **标签页标题中的状态** —— 在每个 Claude Code 标签页标题前显示 `[~]`、`[?]`、`[V]`、`[!]`（见下文“标签页状态标记”）。
- **完成 / 等待 / 出错的提示音** —— 回合结束时播放简短的两音上行提示音，Claude 等待你的许可或回答时播放柔和的双提示音，回合失败时播放下行音。完成提示音只对持续时间不少于 `doneSoundMinSeconds`（默认 20 秒）的回合播放，快速提问保持安静。
- **Claude 订阅额度** —— 5 小时和 7 天窗口（以及 API 返回的额外每周额度），带图形进度条、消耗速度（“正常” / “偏慢” / “偏快”）、耗尽预测、重置倒计时和阈值告警。每 5 分钟以及回合结束后不久刷新。
- **DeepSeek 余额与工作进程花费** —— 从 `api.deepseek.com` 读取余额，并从 `ds.py` 账本（`~/.claude/deepseek-ledger.jsonl`）读取今天 / 最近 7 天的 DeepSeek 工作进程花费。
- **上下文大小警告** —— 会话上下文达到 `contextWarnTokens`（默认 300 000）时提示一次。
- **DeepSeek 路由开关** —— 状态栏菜单和提示会显示新的 Claude 会话是否经由 `api.deepseek.com`，一次点击即可切换。开关运行 `claude-ds` 脚本，密钥、备份和 `.gitignore` 保护都归该脚本管理，Companion 本身不写入这些机密。
- **忽略嵌套会话** —— DeepSeek 工作进程和从 Bash 工具启动的 `claude -p` 会设置 `CLAUDECODE`；它们默认不会出现在状态栏中（可用 `trackNestedSessions` 打开）。

界面文本跟随 VS Code 的显示语言（英语、俄语、简体中文）。

<!-- TODO: 添加状态栏、带额度进度条的悬浮提示和会话菜单的截图。 -->

> **非官方项目。** 与 Anthropic 无关。“Claude”是 Anthropic, PBC 的商标。图标和提示音均为原创，由 `scripts/gen-assets.py` 生成（见 `NOTICE`）。MIT 许可。

## 工作原理

状态来自 Claude Code 自带的 HTTP 钩子；对 Claude 扩展的唯一改动是下文可选的标签页标题补丁：

1. 只要至少有一个 VS Code 窗口打开，扩展就会把 HTTP 钩子写入 `~/.claude/settings.json`（遵循 `CLAUDE_CONFIG_DIR`），覆盖 `UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PermissionRequest`、`Notification`、`Elicitation`、`Stop`、`StopFailure` 和 `SessionEnd`。其他设置、钩子和顶层键都原样保留；无法解析的设置文件只会报错，绝不会被覆盖。
2. 所有窗口都会尝试监听 `127.0.0.1:47823`（设置 `claudeCompanion.port`）。第一个成功的窗口成为**主窗口**，其余窗口每 3 秒重试。钩子 URL 始终指向主窗口。
3. 钩子请求在请求头中携带所属窗口 id 和 `CLAUDECODE`（嵌套）标志。主窗口在扩展的全局存储中维护共享的会话状态，所有窗口都从那里读取。
4. 会话标题和上下文大小来自 Claude Code 转录文件的尾部，因此不会读取 Claude 扩展本身。
5. 最后一个 VS Code 窗口关闭时，钩子会被移除——否则在没有 Companion 监听时，CLI 会为每个事件打印一行 “hook failed”。卸载扩展时也会移除钩子。

Claude 额度通过 Claude Code 已保存的 OAuth 令牌从 `https://api.anthropic.com/api/oauth/usage` 获取。DeepSeek 数据直接发送到 `https://api.deepseek.com`（不走代理）。参见[隐私](#隐私)。

## 标签页状态标记

VS Code 不允许一个扩展修改另一个扩展的标签页标题，因此本扩展会在 Claude Code 扩展的 `extension.js` 中插入两个很小的钩子（首份原始文件保存为 `extension.js.bak-claude-companion`）。补丁要么完整应用，要么完全不应用，并能自动恢复：每次启动以及扩展列表变化时都会检查，因此 Claude Code 更新后会自动重新打补丁，VS Code 会请求**重新加载一次窗口**。如果将来的 Claude 版本大幅改动了这段代码，标签页标记会关闭并只提示一次，其余功能照常。没有本扩展时，被修改的代码只会显示普通标题。可通过 `claudeCompanion.tabStatusMarkers` 关闭。

## 设置项

| 设置 | 默认值 | 说明 |
|---|---|---|
| `claudeCompanion.statusBar` | `true` | 在状态栏显示 Companion 图标。 |
| `claudeCompanion.tabStatusMarkers` | `true` | 在 Claude Code 标签页标题前显示会话状态（会给 Claude 扩展打补丁，见下文）。 |
| `claudeCompanion.sessionStatus` | `true` | 显示各会话状态计数（`~` 正在工作，`?` 等待你，`V` 已完成，`!` 出错）。 |
| `claudeCompanion.usageInStatusBar` | `true` | 在状态栏显示 5 小时和 7 天额度的使用百分比。 |
| `claudeCompanion.soundDone` | `true` | 回合结束时播放上行提示音。 |
| `claudeCompanion.soundWaiting` | `true` | Claude 等待你时播放双提示音。 |
| `claudeCompanion.soundError` | `true` | 回合失败时播放下行音。 |
| `claudeCompanion.doneSoundMinSeconds` | `20` | 播放完成提示音所需的最短回合时长；更短的回合不发声（`0` = 总是播放）。 |
| `claudeCompanion.notifications` | `false` | 回合结束时显示带有会话标题的 VS Code 通知。 |
| `claudeCompanion.alerts` | `true` | 当 Claude 额度或 DeepSeek 余额越过阈值时通知（每个额度窗口一次）。 |
| `claudeCompanion.alertThreshold5h` | `0.8` | 5 小时额度的阈值（`0..1` 的小数）。 |
| `claudeCompanion.alertThreshold7d` | `0.9` | 7 天额度的阈值（`0..1` 的小数）。 |
| `claudeCompanion.alertDeepseekBelowUsd` | `1` | 当 DeepSeek 余额低于此金额（美元）时警告；余额回升到阈值的 1.5 倍后重新启用。 |
| `claudeCompanion.contextWarnTokens` | `300000` | 会话上下文达到此令牌数时警告一次（`0` = 关闭）。 |
| `claudeCompanion.manageHooks` | `true` | 在 VS Code 打开期间把钩子加入 `~/.claude/settings.json`，并在最后一个窗口关闭时移除。 |
| `claudeCompanion.port` | `47823` | `127.0.0.1` 上接收器的端口；所有窗口共用一个选出的监听者。 |
| `claudeCompanion.proxy` | `""` | 访问 `api.anthropic.com` 的代理。留空 = 使用环境变量或 `~/.claude/settings.json` 中 `env` 的 `HTTPS_PROXY` / `HTTP_PROXY`；`"none"` = 直接连接；也可以填写代理 URL，例如 `http://127.0.0.1:8080`。 |
| `claudeCompanion.trackNestedSessions` | `false` | 同时跟踪嵌套会话（DeepSeek 工作进程、从 Bash 工具启动的 `claude -p`）。 |
| `claudeCompanion.deepseekToggle` | `true` | 在菜单和提示中显示 DeepSeek 开关。 |
| `claudeCompanion.deepseekInStatusBar` | `true` | 当 DeepSeek 路由开启时，在状态栏追加余额和今天的工作进程花费，例如 `DS $3.42 (−$0.18)`。 |
| `claudeCompanion.deepseekScope` | `"project"` | 开关修改哪个设置文件：`"project"`（第一个文件夹的 `.claude/settings.local.json`）或 `"user"`（`~/.claude/settings.json`）。 |
| `claudeCompanion.deepseekScript` | `""` | `claude-ds` 脚本路径；留空 = `<Claude 目录>/deepseek/claude-ds.mjs`。脚本用扩展自带的 Node 启动，无需加入 PATH。 |

## 命令

| 命令 | 作用 |
|---|---|
| `Claude Companion: 菜单` | 与点击状态栏相同的菜单（先是会话，后是操作）。 |
| `Claude Companion: 额度` | 完整报告：每个额度的进度条、速度和预测，DeepSeek 余额与工作进程花费。 |
| `Claude Companion: 刷新额度` | 立即重新获取 Claude 和 DeepSeek 数据。 |
| `Claude Companion: 测试提示音` | 依次播放完成、等待和出错提示音。 |
| `Claude Companion: 安装钩子` | 把当前端口的 HTTP 钩子写入 `~/.claude/settings.json`。 |
| `Claude Companion: 移除钩子` | 只移除 Companion 自己的钩子条目，保留其余内容。 |
| `Claude Companion: 切换 DeepSeek` | 为新会话开启或关闭 DeepSeek 路由（运行 `claude-ds`）；也是菜单的第一项。 |
| `Claude Companion: 诊断` | 状态报告：版本、钩子状态、端口和主窗口角色、活动窗口、会话存储和使用缓存。 |

## 从 .vsix 安装

要求：VS Code 1.100 或更高版本、官方 **Claude Code** 扩展，以及已登录的 Claude Code CLI（订阅额度还需要登录 Claude 订阅）。

```bash
code --install-extension claude-companion-0.1.0.vsix
```

然后重新加载窗口。钩子会在激活时安装。为显示标签页状态，首次启动时会给 Claude 扩展打补丁，VS Code 会再请求重新加载一次。卸载扩展即可，它的 `vscode:uninstall` 脚本会删除钩子条目。

从源码构建：

```bash
python scripts/gen-assets.py                 # 字体、图标和提示音（确定性输出）
python scripts/build-vsix.py . 0.1.0 claude-companion-0.1.0.vsix
node --test "test/**/*.test.js"
```

`scripts/release.ps1`（Windows）会升级版本、校验、构建、本地安装、打标签并发布 GitHub Release。

## 隐私

- Claude OAuth 令牌在本地从 `~/.claude/.credentials.json`（或 `CLAUDE_CONFIG_DIR`）读取，只在 `Authorization` 请求头中发送到 `api.anthropic.com`，从不写入日志。Companion **从不刷新**令牌——刷新会轮换 Claude Code 自己的登录。
- DeepSeek 密钥从 `DEEPSEEK_API_KEY`、`~/.claude/secrets/deepseek.json` 或 `~/.kimi-code/config.toml` 读取，只发送到 `api.deepseek.com`。密钥从不写入日志。
- 钩子接收器只监听 `127.0.0.1`。没有遥测、没有账号，也没有其他网络流量；余额、花费和额度缓存在扩展的全局存储中，供下一个窗口使用。

## 故障排查

- **状态栏没有内容。** 运行 `Claude Companion: 诊断`：它会显示钩子是否安装、谁是主窗口、注册了哪些窗口以及会话存储的内容。
- **端口被占用。** 可能是其他进程占用了 `127.0.0.1:47823`；修改 `claudeCompanion.port` 并重新加载窗口。所有窗口都会使用新端口，钩子也会被重写。
- **通过代理无法请求额度。** 把代理 URL 填入 `claudeCompanion.proxy`，或留空以使用环境变量或 `~/.claude/settings.json` 中 `env` 的 `HTTPS_PROXY` / `HTTP_PROXY`。`"none"` 强制直连。DeepSeek 余额始终直接连接。
- **CLI 打印 “hook failed”。** 钩子只在 Companion 窗口运行时安装；崩溃后会在下次启动 VS Code 时被移除。如果 VS Code 将长时间关闭，请运行 `Claude Companion: 移除钩子`。
- **没有声音。** 检查声音设置并运行 `Claude Companion: 测试提示音`。Windows 上通过 PowerShell `SoundPlayer` 播放 WAV，macOS 上使用 `afplay`，Linux 上需要安装 `paplay`。
- **菜单里缺少某个会话。** 其他 VS Code 窗口的会话只作信息展示（在这里打开会在同一会话上启动第二个 CLI）。嵌套会话在未启用 `trackNestedSessions` 时隐藏。会话在最后一次事件 12 小时后消失。

运行日志：**查看 → 输出 → “Claude Code Companion”**。
