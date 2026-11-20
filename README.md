# prompt-optimizer-magpie

[English](./README_EN.md) | 中文

一个自包含的 [Magpie](https://usemagpie.ai) 网关请求钩子（request hook）：在你的模糊提示词**到达模型之前**，先由一个便宜的模型把它改写成精准、具体、可执行的提示词。所有经过网关的客户端（Claude Code、Codex、Gemini CLI、opencode……）零配置受益——不用逐个客户端配 hook。

```
用户消息 ──▶ Magpie 网关 ──▶ [本插件 onRequest]
                          ├─ 1. 规则预过滤（同步，零成本）
                          ├─ 2. 决策门禁（可选，/v1/systemone，2s 超时）
                          ├─ 3. 优化改写（/v1/chat/completions → group/prompt-optimize）
                          └─ 4. 替换最后一条 user 消息，放行
                          ✗ 任何一步失败 → 原文放行（fail-open，绝不阻断请求）
```

> 核心模板 vendored 自 [linshenkx/prompt-optimizer](https://github.com/linshenkx/prompt-optimizer)（42k+ stars，AGPL-3.0-only），见 `templates/` 与 [docs/design.md](./docs/design.md)。

## 特性

- **零客户端配置**：装在 Magpie 网关，一次部署覆盖所有接入了网关的 agent CLI。
- **只改首轮任务需求**：追问、短消息、代码粘贴、超长结构化 prompt 一律放行——你不会在每次「继续」时浪费一次优化调用。
- **双层门禁**：同步规则先拦掉大多数请求；拿不准的才走一次决策模型（System One）二分判断，`deciderGroup` 留空则纯规则运行。
- **fail-open**：决策超时、优化超时、返回异常、JSON 解析失败……一律原文放行。插件坏了 = 没装插件，不会弄坏你的网关。
- **模型组外置**：优化模型、决策模型都在 Magpie 里配成 group（如 `group/prompt-optimize`），插件只写组名，换模型不动插件。
- **防自环**：优化器自己的请求再进网关时会被识别并跳过。

## 安装

前置：本机跑着 Magpie 网关（默认 `http://127.0.0.1:3425`），并配好两个模型组：

```bash
# 优化组：便宜、快、中英表达好的模型，按序 failover
magpie group add group/prompt-optimize \
  opencode-zen-free/deepseek-v4.1-flash-free \
  auto/gemini-3.8-flash \
  --routing order

# 决策组（可选，留空则纯规则模式）
magpie group add group/route-decider ...
```

然后：

```bash
git clone https://github.com/Luck9Star/prompt-optimizer-magpie.git
cd prompt-optimizer-magpie
magpie plugin add . --local
```

## 配置

```bash
magpie plugin options prompt-optimizer-magpie '{
  "enabled": true,
  "optimizerGroup": "group/prompt-optimize",
  "deciderGroup": "",
  "template": "professional",
  "minChars": 10,
  "maxChars": 2000,
  "optimizeTimeoutMs": 15000,
  "deciderTimeoutMs": 2000,
  "skipPrefix": "!!"
}'
```

| 选项 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `optimizerGroup` | `group/prompt-optimize` | 优化调用的模型组 |
| `deciderGroup` | `""` | 决策模型组；留空 = 纯规则模式 |
| `template` | `professional` | `professional` / `basic` / `planning`（见 `templates/`） |
| `minChars` / `maxChars` | `10` / `2000` | 首条 user 消息长度窗口，窗口外放行 |
| `optimizeTimeoutMs` | `15000` | 优化调用超时 |
| `deciderTimeoutMs` | `2000` | 决策调用超时 |
| `skipPrefix` | `"!!"` | 消息以此前缀开头则跳过优化 |

## 模板来源与同步

`templates/` 下的四个文件逐字节拷贝自上游 `packages/core/src/services/template/default-templates/user-optimize/`，每个文件头部注释了来源路径和 commit hash（当前：develop `62b49a1f`，2026-11-18）。上游更新后想跟进，重新拷贝并更新头部注释即可；不跟进则视为有意固定版本。

## 许可证

[AGPL-3.0-only](./LICENSE)。本仓库 vendored 了 AGPL 项目的模板文本，属于衍生作品，因此整体以 AGPL-3.0-only 发布——包括你 fork 或修改后的分发版本。
