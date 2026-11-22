# 设计文档：prompt-optimizer-magpie

状态：设计定案（2026-11-20 第三版，评审修订：首轮判定→新任务判定、决策失败语义反转、四协议流程统一、长文换挡不弃）。下文保留初版规划，运行路径按 v0.2 更新。

## 1. 背景与目标

需求起源：让「用户的新任务需求」在到达模型前被自动优化改写，而追问、确认、闲聊等后续轮次不优化。最初方案是 Claude Code 的 `UserPromptSubmit` hook + 远程调用 Docker 部署的 prompt-optimizer MCP，后演进为**自包含 Magpie 网关插件**。

目标：

1. 一次部署覆盖所有经过 Magpie 网关的客户端（Claude Code、Codex、Gemini CLI、opencode 等），无需逐客户端配置。
2. 只优化新任务需求；追问、短消息、适合保留原样的结构化输入放行。新任务可能出现在长会话中途（飞书线程），靠决策门禁区分，不再用「首轮」硬判定。
3. 可靠性优先：任何插件内部故障都不得阻断用户请求（fail-open）。
4. 模型选择外置到 Magpie 模型组，插件零模型配置。

里程碑：

- **v0.1**：`hooks.mjs` 完整链路 + options + `stats.ndjson` 统计 + dryRun 影子模式。
- **v0.2**：`serve.mjs` 本地统计服务 + GUI 插件页面（端口自动分配）。

## 2. 为什么是 gateway request hook 而不是 middleware

| | gateway middleware | gateway request hook |
|---|---|---|
| 执行环境 | moejs（Go/JS 嵌入），同步 | Bun，原生 async |
| 能否发起上游请求 | **不能**。社区插件 `empty-reply` 源码注释明确：middleware 在路由后执行，无法自行发起上游请求 | **能**。`export async function onRequest(body, ctx)` 可 `await fetch(...)` |
| 典型用途 | 低成本同步改写（历史裁剪、参数覆盖） | 需要外部 I/O 的改写（通知、本插件） |
| 官方文档 | — | https://usemagpie.ai/docs/plugins 、仓库 `docs/subsystems/gateway-request-hooks.md` |

auto 模式可调用决策和优化模型；merged 在一次 completion 内判定和改写。两种模式均通过 request hook 发起请求。

官方限制：hook 若修改 `model`、`stream`、`tools`、`tool_choice` 等受保护字段会被网关回滚，**只有 `messages` 是安全改写目标**——本插件只替换最后一条 user message，天然合规。

## 3. 上游（linshenkx/prompt-optimizer）核验结论

详见 `templates/` 头部注释。要点：

- 一次优化的本质 = `system: 模板文本` + `user: 原始提示词` → 一次 OpenAI 兼容 chat completion → 取返回文本。没有其他魔法。
- `@prompt-optimizer/core` 是 pnpm workspace 内部包，**未发布到 npm**，无法作为依赖安装；MCP server 只是它的薄壳（MCP SDK → CoreServicesManager → PromptService → LLMService + TemplateManager）。
- ModelManager、HistoryManager、存储 provider、Arena/Compare/Evaluation 等 Web UI 子系统对网关插件全部无用。
- 因此采用 **vendoring 模板** 而非复用 core：把 4 个模板文件逐字节拷进 `templates/`，头部注释来源路径 + commit hash（develop `62b49a1f`，2026-11-18）。运行文案在 `templates/overrides.mjs` 维护，由 `node tools/gen-templates.mjs` 生成并校验 `templates/index.mjs`。

## 4. 处理流程（onRequest）

```
onRequest(body, ctx)
 │
 ├─ 0. 防自环与范围，命中即 return undefined：
 │     body.model ∈ {optimizerGroup, deciderGroup} ∪ bypassModels
 │     ctx.kind === "subagent"
 │     ctx.origin ∉ {local, magpie-key}
 │     ctx.agent ∈ bypassAgents（默认空）
 │     无 tools（skipToolless，默认开）
 │     压缩/进度/续传标记：正文命中 §4.6 已知标记
 │     ctx.query 为空且定位不到用户文本
 │     enabled=false
 │
 ├─ 1. 当前轮定位（§4.5 四协议矩阵，不只用 messages）：
 │     chat/anthropic → body.messages；responses(Codex) → body.input
 │     （剔除 <environment_context> 等宿主注入块）；gemini → body.contents
 │     定位不到"用户亲笔"文本 → 放行
 │
 ├─ 2. bypassPrefix、minChars、maxChars 命中时放行。
 │     Responses 含 previous_response_id 时视为续接，直接放行。
 │
 ├─ 3. auto 且有 deciderGroup 时，以用户原文、长度、是否已有助手回复向
 │     /v1/systemone 询问 noul/tpl；非 new_task 或置信度 <0.6 放行。
 │     判定服务故障且已有助手回复 → 放行；首轮按 deciderFallback 走规则或 merged。
 │     显式 merged 和纯规则仅处理首轮；merged 跳过 decider。
 │
 ├─ 4. 本地模板按 tpl 选档。skip 放行；缺失或置信度 <0.5 时用 professional。
 │     非中文路由固定 professional_en；merged 在 completion 内选择档位或放行。
 │
 ├─ 5. 查策略隔离的磁盘缓存；未命中时 POST /v1/chat/completions。
 │     merged 要求原始首行是合法控制标记，格式或网络失败则原样放行。
 │     同一网关与优化组连续失败 5 次后回落纯规则 10 分钟，到期重新计数。
 │
 ├─ 6. 去除外围围栏，长度限制为 [0.4×原长, min(max(3×原长,1500),max(6000,原长))]。
 │     逐个比对 [REDACTED]、双花括号占位符和反引号标识符的拼写与次数；
 │     缓存重放也走此检查。
 │
 └─ 7. 替换（span 匹配守卫）：提取文本必须在最后一条 user 消息的文本 part
       内找到匹配（先原样、再空白规范化，且唯一）；ctx.query 与消息正文
       可能不同源，禁止拿 ctx.query 整段覆盖消息。只替换该 span，
       多模态 part、图片、tool_result、宿主 wrapper 原样保留；找不到 → 放行。
       dryRun=true 时原请求放行，否则 return newBody；审计文本受 logRewrites 控制
```

※ 新任务 ≠ 首轮：飞书/Hermes 是长线程，新任务大量发生在已有 assistant 回复之后。「已有 assistant 回复」从硬放行条件降级为交给决策模型的信号（步骤 3.A）；纯规则模式退回保守跳过（步骤 3.B）。

全链路包一层 try/catch：任何异常记 stats(action=pass, reason=error) 后 `return undefined`。

### 4.5 用户真实输入提取（2026-11-20 探针实测验证）

**问题**：agent 发到网关的请求里，system 提示词 + 注入的上下文远大于用户原文，必须只把用户原文送进优化器。用临时 debug hook（`onRequest` 只读不改写）抓了本机真实流量验证，量化结果：

| 请求 | system 大小 | 注入的 user 角色消息 | 用户真实输入 |
|---|---|---|---|
| Hermes（chat 协议） | **65,967 字符** | 9 条（memory/skills/session 上下文，共约 5.5 万字符） | **324 字符**（最后一条 user 消息的核心部分） |
| prompt-optimizer 自身回调 | 977 | 0 | 263（已是干净模板调用） |

**结论：能抓到，但"最后一条 user 消息"≠"用户原文"，需要两层剥离。**

提取算法（v0.1 实现）：

1. **按协议定位当前轮 user 消息**（社区 gateway-notify 的 `turn.mjs` 已有全部四种协议的成熟辨认逻辑，直接借鉴）：
   - chat：`messages` 中最后一条 `role=user`
   - anthropic（Claude Code）：最后一条消息 `role=user` 且含非 `tool_result` 的 text part
   - responses（Codex）：`input` 末尾 `role=user` 且非 `<environment_context>` 等 Codex 自注入块
   - gemini：`contents` 末尾 `role=user` 的 text parts（排除 `functionResponse`）
2. **内容剥离**（顺序执行）：
   - 丢 `tool_result` / `functionResponse` part
   - 丢 `<system-reminder>…</system-reminder>` 块、`<task-notification>`、`<environment_context>` 等宿主自注入块
   - 剥宿主 wrapper：Hermes 的 `<acp tokens=…>mNNNNN</acp>` 首行 + `[Replying to: "…"]` 引用块
3. **替换策略**：只替换核心文本 span，**保留 wrapper 前缀原样**（ACP 标记、引用上下文是宿主/bili 代理的元数据，不能破坏）。span 定位：提取文本必须在消息文本内找到（先原样匹配、再空白规范化匹配，且唯一）；`ctx.query` 只用于优化输入，**与正文对不上时禁止整段覆盖**，一律 bypass 放行（fail-open 的一种）。
4. 剥离后进入 §4 的长度门禁与决策流程。

宿主 wrapper 是开放集合，放进独立配置表（`wrappers`），遇到新宿主加正则，不动主逻辑。

### 4.6 查漏（2026-11-20，官方文档 + 本机 gateway-notify 0.1.5）

来源：https://usemagpie.ai/docs/zh/plugins 「异步网关请求钩子」；本机 `~/.config/magpie/plugins/node_modules/@magpie-community/gateway-notify/turn.mjs`。

| 发现 | 落到设计 |
|---|---|
| `ctx.query` 已是「最后一条用户文本，不含工具结果和图片」 | 优化输入优先用它，再剥 wrapper。空则 bypass。不再自己扫整段 history 当输入 |
| 钩子在 **JS middleware 之前**跑 | 我们改写时 fovea 还没压缩历史；fovea 默认保留最近消息，改写后的用户句不会被它吃掉。output-strategy 在我们之后注入主请求，不影响输入；污染只发生在优化器自己的 loopback 回复上，净化仍要做 |
| `ctx.report` 只接受 `ready/empty/unbound/unauthorized/unavailable/invalid/skipped` | 不再自造结果码。optimized→`ready`，bypass→`skipped`，失败→`unavailable`。细分类只进 ndjson。report 不存正文，重载清零 |
| `fetch` 必须带 `ctx.signal` | 客户端取消或钩子超时会中止；优化/决策的 fetch 都传 signal，abort 即放行，不继续烧额度 |
| 「内部标题和分类请求跳过此钩子」 | Magpie 自己的标题/分类器进不了 hook。Hermes 的 `group/bili-summary` 不是这类，仍靠 `bypassModels` |
| 无 tools 的请求多半是机器旁路（gateway-notify：`hasTools` 为假则不开轮次） | 默认 `skipToolless=true`。代价：不带 tools 的纯聊天客户端不会被优化。天哥的 Claude/Codex/Hermes/Grok 都带 tools |
| 压缩与子代理进度不是用户提示词 | 正文含这些就 bypass：`Your task is to create a detailed summary of the conversation so far`、`This session is being continued from a previous conversation`、`You are performing a CONTEXT CHECKPOINT COMPACTION`、`Describe your most recent action in 3-5 words` |
| 替换必须保留非文本 part | 见步骤 4。图片、tool_result 不能被字符串覆盖 |
| 同一条提示词会被 agent 重试 | 插件目录 `.cache.json.d/` 的逐键磁盘缓存，键取 agent、原文、网关、优化组、配置/实际模式、有效档位和 dryRun 的哈希。TTL 默认 60s；≤0 跳过缓存读写；旧单文件缓存不参与重放 |
| 中英模板 | CJK 占比 ≥0.3 时允许中文三档，否则固定 `professional_en` |
| 优化结果护栏 | 空、短于原文 0.4 倍、长于 max(3×原文,1500)、或超过 max(6000,原文长度) 绝对上限 → 弃用，原文放行。output-strategy 风格污染用 TAIL_NOTE 在 system 预防；v0.1 未做尾标正则检测 |

`ctx` 官方列出的字段：`protocol, model, stream, path, agent, session, cwd, query, options, signal`。`origin` / `kind` 是探针里见过、文档这段没写的，继续用，但实现时缺字段就当「未知→放行」。

### 决策门禁：从"可选增强"升级为"长线程必需"

2026-11-20 评审修订：原设计把「会话已有 assistant 回复」当硬放行，这在 Claude Code 单任务会话成立，在飞书/Hermes 长线程里会把绝大多数新任务放掉——插件等于没装。因此该信号改为交给决策模型；置信度不足时原样放行。v0.2 的超时、报错和不可解析响应按 §4 走降级路径，仅首轮可继续改写。

实测：`group/route-decider` 组列表虽显示六成员 not served，但 `/v1/systemone` 实调成功（bailian-decision 活着，choice+confidence 正常，0.97 置信度）。结论「可用但可能波动」——所以 fail-safe 方向必须指向放行。决策组只能放真正的决策类模型（System One 协议 `{state, questions}`），禁止拿普通 chat 模型冒充。纯规则模式（deciderGroup 留空）保留，但只适合短会话客户端；长线程不开 decider = 全部放行。

### 已实测确认的环境事实（2026-11-20）

| 事实 | 结果 |
|---|---|
| loopback 调 `127.0.0.1:3425/v1/chat/completions` 鉴权 | **无需任何 key** |
| `/v1/systemone` 请求格式 | `questions.<name>.criteria` 必须是 `{选项: 描述}` dict；用数组或缺嵌套会报 `InvalidParameter` |
| `group/route-decider` 实调 | 成功，`noul=new_task(0.97)` / `opt=yes(0.97)` |
| output-strategy 中间件污染 | **确认存在**：优化组请求也被注入 ponytail/ADHD 输出风格 → 步骤 3.5 净化 + 模板尾注双重防御 |

## 5. 超时预算设计（第二版修正）

第一版曾按"hook 链总预算 10s 封顶"推导出 optimize ≤7s，**这是误读**。官方文档原文：

> Each hook defaults to one second; gatewayTimeoutMs accepts integers from **100 to 30000** milliseconds… The chain sums budgets, clamped to 2–10 seconds, **or takes the longest hook's own timeout when that is longer**.

正确语义：

- 单个 hook 的 `gatewayTimeoutMs` 最高 **30s**；
- 链总预算 = clamp(各 hook 之和, 2–10s)，**但任一单 hook 超时更长时直接采用该值**——即一个 25s 的 hook 自带 25s 链预算，不受 10s 钳制。

**结论：不需要拆成两个 hook。** 拆两个插件（decider 2s + optimizer 15s）的链预算 = max(10s 钳制值, 15s) = 15s，与单 hook 15s 完全相同——"最长单 hook 主导"规则决定了拆分不增加任何预算，反而多一个插件要维护。且每个插件只有一个 `onRequest`，同一插件内也无法注册两个。

最终取值：

| 参数 | 值 | 依据 |
|---|---|---|
| `gatewayTimeoutMs`（hook 声明） | **25000** | 给 15s 优化 + 2s 决策 + 余量；不取满 30s，留网关调度空间 |
| `deciderTimeoutMs` | 1500 | 决策就该快，慢了宁可直接走规则 |
| `optimizeTimeoutMs` | 15000 | flash 级 + 低思考档典型 3–8s，15s 是兜底不是常态 |

残留风险（接受）：hook 等待期间客户端请求整体停顿（流未开始），最坏 +15s 首字延迟。缓解：dryRun 先跑统计真实延迟分布；模板选 flash 模型；`!!` 前缀手动逃生；`enabled:false` 一键关。

**写码前置条件**：~~sleep 探针~~ 已完成（§12-2）：options 里设 `gatewayTimeoutMs=25000` 即拿到 25s 链预算，12s hook 实测不超时。**必须在 plugin options 里声明，不是 export 常量**（agentcompass 源码 `options.gatewayTimeoutMs || 8000` 同款读法；不设则默认 ~1s，hook 直接被放弃，请求照常放行）。

## 6. v0.2 服务端口与发现（自动分配设计）

背景：统计页沿用 page-usage-tree 已验证的「插件自带本地 HTTP 服务 + 页面导航过去」模式，但固定端口会与其他插件冲突（3494 已被 usage-tree 占用类）。

### 端口策略（三层）

1. **首选 ephemeral**：`options.port` 默认 `0` → OS 自动分配空闲端口（page-usage-tree 的 `startServer` 已含 `port===0` 直绑分支，模式可抄）。绑定后把 `{port, token, pid, buildId, startedAt}` 写入发现文件 `service.json`。
2. **发现通道优先级**（页面侧）：
   a. `hello` bridge 的 `service` 字段——page-usage-tree 的 BRIDGE_SHIM 明确从 hello 解析 `service` URL，说明 Magpie 有"告知页面服务地址"的机制；但其 `server()` 返回 `{}` 未启用。**本插件 `server()` 尝试返回绑定地址，若 Magpie 透传到 hello.service 则页面零配置直达**（契约待实测，v0.2 第一项）。
   b. hello.service 不可用时回退**固定候选端口 3497**（避开 3494/3495 常用位），EADDRINUSE 时按 page-usage-tree 模式重试 16×100ms，探测到同版本同 build 的活服务则复用。
   c. 仍失败（端口被异种服务占用且无 hello.service）→ 页面显示引导文案"请在插件 options 把 port 设为 0 或其他空闲端口"。
3. **安全**：只绑 `127.0.0.1`；API 路径带随机 token（page-usage-tree 同款）；CSP 按官方对 service 页的要求写完整源（`connect-src http://127.0.0.1:<port>`），不用 `'self'`（WebKit 沙箱下 `'self'` 可能匹配为空）。

### 页面沙箱约束（设计前提）

Magpie 插件页运行在 `sandbox="allow-scripts"` frame：**无 fetch/WebSocket**（`connect-src 'none'`）、无表单/frame、脚本必须外链文件；可用：`_magpie/bridge.js`、`magpie.options.get/set`、`magpie.read(usage:summary|providers:list)`（需 permissions 声明）、`location.replace` 导航到服务页。因此统计页主体跑在 serve.mjs 服务侧，插件页只做启动/跳转/兜底引导。

### 发现文件与统计数据路径

- hook 按 UTC 日追加 `stats/YYYY-MM-DD.ndjson`。独立服务从 `POM_DATA_DIR`（默认插件目录）读取该布局，在该目录发布 `service.json`。持有监听端口的服务负责清理过期日文件。

## 7. 监控与统计

分层，不重复造轮子：

| 层 | 机制 | 阶段 |
|---|---|---|
| 事件流水 | hook 写 `stats/YYYY-MM-DD.ndjson`（按 UTC 日分文件）：`{ts, agent, action, reason, durationMs, inputChars, outputChars, dryRun, fromCache?, orig?, rewritten?}`（orig/rewritten 为脱敏后截断的文本，logRewrites 可关）；action/reason ∈ pass（disabled / subagent / self-loop / bypass-model / origin / bypass-prefix / no-tools / not-turn / no-user-text / short-text / too-long / no-decider-followup / optimize-fail / optimize-empty / output-guard / merged-fail / merged-passthrough / merged-circuit-open / error）、decide（decider-fail / decider-fail-rule / decider-fail-merged / followup / low-confidence）、optimize（dry-run / optimized / merged-optimized / cache-hit / no-span） | v0.1→v0.2 |
| 结果码 | 每请求一次终态 `ctx.report(code, bytes)`：回写报 ready 与返回体 UTF-8 字节数，放行/干跑报 skipped，最终模型错误报 unavailable；未写回时 bytes 为 0 | v0.1 |
| 日志 | 失败细节进 `~/Library/Logs/magpie/app.log`（`plugin [error]` 通道） | v0.1 |
| token 成本 | 已有 page-usage-tree（优化调用按 `group/prompt-optimize` 入账）+ 内置 Usage 页 | 现成 |
| 失败通知 | 复用 gateway-notify（保持 `includeText=false`） | 现成 |
| 可视化 | v0.2 页面：命中率、放行原因 Top N、耗时分布（p50/p95）、最近 N 条 dry-run 前后对照 | v0.2 |

## 8. 配置项总表（options，经 `magpie plugin options` / GUI 插件页改）

| option | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 总开关 |
| `optimizerGroup` | group/prompt-optimize | 优化模型组（order 路由） |
| `deciderGroup` | group/route-decider | 长线程新任务判定必需；留空 = 纯规则模式（长会话将全部放行，只适合短会话客户端） |
| `optimizerMode` / `deciderFallback` | auto / rule | merged 在首轮合并判断和改写；deciderFallback 可指定 merged，熔断期间回落规则 |
| `rollout` | null | 指定参与首轮实验的 agent、实验号及 auto/merged 百分比；缺省使用原有策略 |
| `minChars` | 6 | 短回复硬放行，不进决策。中文 6 字（约 2 词）以下基本无优化空间："改一下""好""继续看"。CJK 单字信息密度高，阈值比英文词数口径小；dryRun 统计 6–10 字段命中率后微调 |
| `maxChars` | 12000 | 兜底上限（防粘贴整本书），正常范围内超长文本交决策模型判，不硬放行 |
| `skipPrefix` | !! | 手动绕过前缀 |
| `dryRun` | true | 影子模式：只记录不替换。**首个版本建议先开 dryRun 跑几天**，统计 decider 误判率和优化收益再放行 |
| `logRewrites` | true | 将识别出的敏感字段替换为 [REDACTED]，再截断写入审计；false 时省略原文与改写字段 |
| `skipToolless` | true | 无 tools 的请求直接放行 |
| `cacheTtlMs` | 60000 | 重放相同原文和策略的改写。≤0 停止缓存读写 |
| `deciderTimeoutMs` | 1500 | |
| `optimizeTimeoutMs` | 15000 | |
| `port` | 0 | 0 = OS 自动分配；回退候选 3497 |
| `bypassAgents` | [] | 出现新的机器客户端时按 ctx.agent 加白。OpenAI SDK 回调（agent="OpenAI"）实际请求 group/prompt-optimize，已被步骤 0 模型自环守卫覆盖，不需要默认值 |
| `bypassModels` | [] | `body.model` 命中即放行——把已知的机器任务模型（如 Hermes 会话压缩 `group/bili-summary`）排除，无需为此建专门组 |

启用首轮实验前，先确认所选 agent 的 `ctx.session` 为跨请求稳定的字符串。在 options 中设置 `"rollout": {"experimentId":"first-turn-v1","agents":["cli"],"autoPercent":15.5,"mergedPercent":5}`。两个比例都要显式填写，可为零或小数，总和必须小于 100，以保留同期原文直通对照。上例合格首轮的目标分配比例依次为 15.5%、5% 和 79.5%。同一实验、agent 和会话固定分桶。把 `mergedPercent` 调零即可将 merged 组撤回到直通组，保留原 auto 组的会话分配；将 `rollout` 设为 null 恢复全局策略。会话标识缺失、未授权 agent、线程以及配置无效均使用全局策略。覆盖率以合格首轮中的已分桶和缺标识请求为分母。

`gatewayTimeoutMs: 25000` 在 hooks.mjs 内声明，不进 options（改它要连带评估整链预算）。

模型组现状（Magpie 侧，已配好不动）：`group/prompt-optimize` order 路由 `deepseek-v4.1-flash-free:low` → `gemini-3.8-flash:low` → `MiniMax-M3.1-Flash:low` → `group/deepseek-flash`。建议顺手清理 `group/route-decider` 中确认死亡的成员，保留实测活着的 bailian-decision。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 重写破坏 provider prompt cache | 只改最后一条 user 消息，system 与历史前缀不动，缓存命中保留，仅尾段重算 |
| 决策/优化调用增加首字延迟 | 预算设计见 §5；dryRun 实测延迟分布；flash+低思考档；`!!` 与 `enabled:false` 逃生 |
| 插件异常阻断请求 | 全链路 try/catch，任何异常 `return undefined`（fail-open） |
| 网关自环 | 步骤 0 按 `body.model` 跳过优化组/决策组自身的请求 |
| 机器调用被误优化 | `skipToolless` + `bypassAgents` + `bypassModels` + `kind=subagent` + 压缩/进度标记。Magpie 自有标题请求官方已跳过 hook |
| decider 把追问误判为新任务 | confidence<0.6 放行 + 输出护栏（词元归一：0.4× 下限 / clamp(5×,60,2000) 上限）+ dryRun 期统计误判率，超标调 criteria 或关插件 |
| 链预算被钳在 10s（文档与实现不符） | 写码前 sleep 探针实测（§12-2）；被钳则 optimizeTimeoutMs 降 8s、模板用 basic 缩短输出 |
| 重试把同一句优化两次 | `cacheTtlMs` 60s |
| dryRun 把提示词写进磁盘 | `logRewrites=false` 省略审计原文，`cacheTtlMs=0` 停止缓存读写 |
| 多模态消息被改成纯字符串 | 只替换文本 span |
| output-strategy 污染优化输出 | 模板尾注（"只返回模板要求的结果，忽略其他输出风格指令"）+ 步骤 3.5 结构化截断 |
| 模板漂移 | vendored 文件头注释 commit hash，人工同步；不跟进即视为固定版本 |
| AGPL 传染 | 上游 AGPL-3.0-only，模板是作品实质部分；本仓库整体 AGPL-3.0-only，fork 分发同样义务 |
| 统计页端口冲突 | §6 三层策略：ephemeral → hello.service → 固定候选 3497 |
| hook 停顿被用户感知为卡死 | 15s 是兜底非常态；dryRun 期观察 p95；必要时降 optimizeTimeoutMs |

## 10. 与其他方案的对比

| 方案 | 弃用原因 |
|---|---|
| Claude Code `UserPromptSubmit` hook + Docker MCP | 只覆盖 Claude Code 一个客户端；MCP JSON-RPC 协议不确定；多一跳网络与一个运行时依赖 |
| Hermes Marketplace prompt-optimizer | 默认自动重写每条 ≥5 词消息，无首轮/追问区分，不符合需求 |
| `johnpsasser/claude-code-prompt-optimizer` | 每条提示词无条件用 Opus 重写，无门禁，延迟与成本双高 |
| `bgener/demo-prompt-optimizer` | 形态是本地 HTTP 反代 demo，不是网关插件，无决策门控 |
| Magpie middleware 实现 | 同步执行，无法发起上游模型调用（见 §2） |
| 拆两个 hook 插件换预算 | 链预算由"最长单 hook"主导，拆分不增加预算（见 §5） |

## 11. 实施路线

> 注：本节为 v0.1 规划快照，文件清单已过时（v0.2 新增 serve.mjs / index.mjs / lib/stats-service.mjs / lib/turn.mjs / templates/ / page/ 等）；当前结构以 README「项目结构」为准。

**v0.1（核心闭环，单提交）**

```
hooks.mjs          # §4 全链路 + stats 记录 + dryRun + 输出净化
lib/templates.mjs  # 从 vendored .ts 提取模板文本（构建期或运行时正则提取，二选一定死）
lib/stats.mjs      # ndjson append + 可写目录探测
package.json       # magpie.hooks 指向 hooks.mjs
```

验收：`magpie plugin add ./` 安装；dryRun 跑真实会话；stats/YYYY-MM-DD.ndjson 事件齐全；`!!` 前缀与 enabled=false 生效；杀掉网关后 hook 自动放行。

**v0.2（可视化，独立提交）**

```
serve.mjs          # 本地统计服务：读 stats/YYYY-MM-DD.ndjson，渲染统计页（§6 端口策略）
page/index.html    # bridge 启动页：hello.service → 3497 → 引导文案
page/boot.js
```

验收：两个端口场景（自动分配/固定回退）都能打开页面；与 page-usage-tree 共存无端口冲突。

## 12. 待实测项

| # | 事项 | 阶段 |
|---|---|---|
| 1 | hook/serve 可写数据目录的确切路径 | v0.1 |
|| 2 | ~~sleep(12s) 探针实测链预算~~ **已实测（2026-11-20）**：`options.gatewayTimeoutMs=25000` 后 12s 睡眠 hook 未超时（请求 14.4s 返回，含网关调度）。链预算确认真取单 hook 自身超时，不受 10s 钳制。注意：`gatewayTimeoutMs` 必须写在 plugin options（agentcompass 同款读法），export 常量无效——默认仅 ~1s，首版探针 12s 睡眠即被放弃（请求 2.1s 返回） | v0.1 写码前 ✅ |
| 2b | 顺带关闭：`ctx.query` 确实带 ACP wrapper（须剥）；`ctx.origin`/`ctx.kind` 存在（hermes 请求 origin=local, kind 空串） | ✅ |
| 3 | `server()` 返回值 → hello.service 透传契约 | v0.2 |
| 4 | 输出净化规则对真实 ponytail 尾巴的截断命中率 | v0.1 dryRun |
| 5 | 优化调用 p50/p95 真实延迟（决定是否下调 optimizeTimeoutMs） | v0.1 dryRun |
| 6 | `ctx.query` 是否仍带 Hermes ACP / `[Replying to]` wrapper | v0.1 |
| 7 | `ctx.origin` / `ctx.kind` 在 0.1.4598 上是否稳定存在 | v0.1 |
| 8 | `skipToolless` 会不会误伤某条真实用户客户端（无 tools 的纯聊天） | v0.1 dryRun |
| 9 | decider 误判率：追问被当 new_task 的比例（dryRun 统计，>5% 调 criteria） | v0.1 dryRun |
