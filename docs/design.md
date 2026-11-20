# 设计文档：prompt-optimizer-magpie

状态：设计定案，插件实现进行中。本文记录 2026-11-20 调研得出的全部关键决策与依据。

## 1. 背景与目标

需求起源：让「用户首轮任务需求」在到达模型前被自动优化改写，而后续问答回复不优化。最初方案是 Claude Code 的 `UserPromptSubmit` hook + 远程调用 Docker 部署的 prompt-optimizer MCP，后演进为**自包含 Magpie 网关插件**。

目标：

1. 一次部署覆盖所有经过 Magpie 网关的客户端（Claude Code、Codex、Gemini CLI、opencode 等），无需逐客户端配置。
2. 只优化首轮任务需求；追问、短消息、代码粘贴放行。
3. 可靠性优先：任何插件内部故障都不得阻断用户请求（fail-open）。
4. 模型选择外置到 Magpie 模型组，插件零模型配置。

## 2. 为什么是 gateway request hook 而不是 middleware

Magpie 插件有两种请求改写机制，选型依据来自官方文档与社区插件源码：

| | gateway middleware | gateway request hook |
|---|---|---|
| 执行环境 | moejs（Go/JS 嵌入），同步 | Bun，原生 async |
| 能否发起上游请求 | **不能**。社区插件 `empty-reply` 源码注释明确：middleware 在路由后执行，无法自行发起上游请求 | **能**。`export async function onRequest(body, ctx)` 可 `await fetch(...)` |
| 典型用途 | 低成本同步改写（历史裁剪、参数覆盖） | 需要外部 I/O 的改写（通知、本插件） |
| 官方文档 | — | https://usemagpie.ai/docs/plugins 、仓库 `docs/subsystems/gateway-request-hooks.md` |

本插件必须在请求路径上发起「决策」和「优化」两次额外的模型调用，因此只能用 request hook。

官方限制：hook 若修改 `model`、`stream`、`tools`、`tool_choice` 等受保护字段会被网关回滚，**只有 `messages` 是安全改写目标**——本插件只替换最后一条 user message，天然合规。

## 3. 上游（linshenkx/prompt-optimizer）核验结论

详见 `templates/` 头部注释。要点：

- 一次优化的本质 = `system: 模板文本` + `user: 原始提示词` → 一次 OpenAI 兼容 chat completion → 取返回文本。没有其他魔法。
- `@prompt-optimizer/core` 是 pnpm workspace 内部包，**未发布到 npm**，无法作为依赖安装；MCP server 只是它的薄壳（MCP SDK → CoreServicesManager → PromptService → LLMService + TemplateManager）。
- ModelManager、HistoryManager、存储 provider、Arena/Compare/Evaluation 等 Web UI 子系统对网关插件全部无用。
- 因此采用 **vendoring 模板** 而非复用 core：把 4 个模板文件逐字节拷进 `templates/`，头部注释来源路径 + commit hash（develop `62b49a1f`，2026-11-18）。

## 4. 处理流程（onRequest）

```
onRequest(body, ctx)
 │
 ├─ 0. 防自环：body.model ∈ {optimizerGroup, deciderGroup} → return undefined
 ├─    总开关 enabled=false → return undefined
 │
 ├─ 1. 规则预过滤（同步，零成本），命中任一条 → 放行：
 │     a. body.messages 缺失 / 最后一条不是 user 角色
 │     b. 会话中已有 assistant 回复（非首轮）※
 │     c. 文本长度 < minChars（10）或 > maxChars（2000）
 │     d. 以 skipPrefix（!!）开头（显式跳过）
 │     e. 疑似代码/日志粘贴（高密度代码标记、超长行、围栏块占比）
 │     f. 已高度结构化（多个 markdown 标题 + 列表 + 明确动词指令）→ 优化空间小
 │
 ├─ 2. 决策门禁（可选）：deciderGroup 非空时
 │     POST {gateway}/v1/systemone
 │     { model: deciderGroup,
 │       state: {任务摘要, 消息长度, 是否首轮},
 │       questions: { optimize: { choice: { criteria: {
 │         optimize: "模糊、泛泛、可改写的任务需求",
 │         skip: "追问/确认/闲聊/已精准" } } } } }
 │     超时 deciderTimeoutMs（2s）或解析失败 → 视为"不确定"→ 走 3（宁可多优化）
 │     明确返回 skip → 放行
 │
 ├─ 3. 优化：POST {gateway}/v1/chat/completions
 │     { model: optimizerGroup,
 │       messages: [ ...template.messages, { role:'user', content: 原文本 } ],
 │       stream: false }
 │     超时 optimizeTimeoutMs（15s）/ 非 200 / 空内容 → 放行
 │
 └─ 4. 替换：newBody = structuredClone(body)
       newBody.messages[last] = { role:'user', content: 优化结果 }
       return newBody
```

※ 首轮判定用「会话中是否存在 assistant 消息」，不依赖消息绝对条数：Claude Code 等客户端会把 system-reminder、文件引用注入 user 消息，多轮对话里首条 user 往往很长，但只要已有 assistant 回复就说明不是新任务。

### 决策门禁为什么是增强项而不是必选项

调研时（2026-11-20）`group/route-decider` 六个决策类成员全部 `not served`。门禁纪律要求：规则路径为主，decision 是可配置增强（`deciderGroup` 留空即纯规则）。决策组只能放真正的决策类模型（System One 协议 `{state, questions}`），禁止拿普通 chat 模型冒充。

## 5. 模板选择建议

模板在 options 里按名字选：`professional`（中文，精准化改写，默认）、`professional_en`（英文版）、`basic`（轻量）、`planning`（步骤化规划，适合复杂多步任务）。语言与模型无关，选与用户输入语言匹配的即可。

优化模型选型结论（基于 Magpie 实际在服务模型，2026-11-20）：

| 优先级 | 模型 | 档位 | 理由 |
|---|---|---|---|
| 1 | `opencode-zen-free/deepseek-v4.1-flash-free` | none | 免费、最快，DeepSeek 适配器默认关思考 |
| 2 | `auto/gemini-3.8-flash` | low | 质量与延迟平衡 |
| 3 | `minimax-code/MiniMax-M3.1-Flash:low` | low | 备选；上游 PR #366 曾把默认优化器切到 M3.1 Flash |

思考档位通过 Magpie 的模型名后缀语法（`model:low`）在组内配置，插件不做任何参数改写。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 重写破坏 provider prompt cache 前缀 | 只在首轮请求改写，首轮本来就没有可复用的 assistant 前缀；后续轮次不动 |
| 决策/优化调用增加首字延迟 | 决策 2s 超时；优化模型选 flash 级 + 低思考档；不满意可用 `!!` 前缀跳过或 `enabled:false` |
| 插件异常阻断请求 | 全链路 try/catch，任何异常 `return undefined`（fail-open） |
| 网关自环 | 步骤 0 按 `body.model` 跳过优化组/决策组自身的请求 |
| 模板漂移 | vendored 文件头注释 commit hash，人工同步；不跟进即视为固定版本 |
| AGPL 传染 | 上游 AGPL-3.0-only，模板是作品实质部分；本仓库整体 AGPL-3.0-only，fork 分发同样义务 |

## 7. 与其他方案的对比

| 方案 | 弃用原因 |
|---|---|
| Claude Code `UserPromptSubmit` hook + Docker MCP | 只覆盖 Claude Code 一个客户端；MCP JSON-RPC 协议不确定；多一跳网络与一个运行时依赖 |
| Hermes Marketplace prompt-optimizer | 默认自动重写每条 ≥5 词消息，无首轮/追问区分，不符合需求 |
| `johnpsasser/claude-code-prompt-optimizer` | 每条提示词无条件用 Opus 重写，无门禁，延迟与成本双高 |
| `bgener/demo-prompt-optimizer` | 形态是本地 HTTP 反代 demo，不是网关插件，无决策门控 |
| Magpie middleware 实现 | 同步执行，无法发起上游模型调用（见 §2） |

## 8. 待实测项（实现后验证）

- hook `ctx` 暴露的字段与 headers（当前防自环仅依据 `body.model`）。
- hook 内 loopback 调 `/v1/chat/completions` 是否需要网关 key 鉴权。
- `/v1/systemone` 从 hook 内调用自身网关时是否触发其他 hook。
- gateway request hook 的整体超时预算是否容纳 15s 优化调用。
