# prompt-optimizer-magpie

[English](./README_EN.md) | 中文

一个自包含的 [Magpie](https://usemagpie.ai) 网关请求钩子（request hook）：在你的模糊提示词**到达模型之前**，先由一个便宜的模型把它改写成精准、具体、可执行的提示词。所有经过网关的客户端（Claude Code、Codex、Gemini CLI、opencode……）零配置受益——不用逐个客户端配 hook。

```
用户消息 ──▶ Magpie 网关 ──▶ [本插件 onRequest]
                          ├─ 1. 规则预过滤（同步，零成本）
                          ├─ 2. 决策门禁（可选，/v1/systemone，1.5s 超时）
                          ├─ 3. 优化改写（/v1/chat/completions → group/prompt-optimize）
                          └─ 4. 替换最后一条 user 消息中的用户原文，放行
                          ✗ 任何一步失败 → 原文放行（fail-open，绝不阻断请求）
```

> 核心模板 vendored 自 [linshenkx/prompt-optimizer](https://github.com/linshenkx/prompt-optimizer)（AGPL-3.0-only），见 `templates/` 与 [docs/design.md](./docs/design.md)。

## 特性

- **零客户端配置**：装在 Magpie 网关，一次部署覆盖所有接入了网关的 agent CLI。
- **只改「新任务」需求**：追问、确认、短消息、代码粘贴、超长结构化 prompt 一律放行——你不会在每次「继续」时浪费一次优化调用。决策模型会看到用户原文 + 是否已有助手回复，据此区分新任务与追问。
- **双层门禁**：同步规则先拦掉大多数请求；拿不准的才走一次决策模型（System One）二分判断。`deciderGroup` 留空则纯规则运行——此时**长线程（已有助手回复）一律放行，只优化真正的首轮**。决策模型一次调用同时回答两问：新任务/追问（`noul`）+ 模板档位（`tpl`：skip/basic/professional/planning）——`skip` 即「新任务但已结构化」的放行态；档位置信度 <0.5 或非法时回退 `professional`（与上游 prompt-optimizer 默认一致：模板列表首位）。
- **机器调用排除**：`bypassModels` 可排除 Hermes 压缩 / 标题生成等机器任务模型（这些 origin 也是 local，单靠来源挡不住）；`ctx.kind==="subagent"` 子代理、自环模型（优化器/决策器自己的回源请求）自动跳过。
- **fail-open**：决策不可用时仅首轮可走配置的降级路径；优化超时、输出校验失败或无法定位替换位置时，网关继续发送原请求。
- **模型组外置**：优化模型、决策模型都在 Magpie 里配成 group，插件只写组名，换模型不动插件。

## 安装

前置：本机跑着 Magpie 网关（默认 `http://127.0.0.1:3425`），并配好两个模型组（命令以 `magpie group --help` 为准）：

```bash
# 优化组：便宜、快、中英表达好的模型，按序 failover
magpie group add group/prompt-optimize <modelA> <modelB> --routing order

# 决策组（可选，留空则纯规则模式）：一个支持 /v1/systemone 的决策模型
magpie group add group/route-decider <decision-model> --routing order
```

然后安装插件（本地目录）：

```bash
magpie plugin add npm:prompt-optimizer-magpie
```

或从源码安装（本地目录）：

```bash
git clone https://github.com/Luck9Star/prompt-optimizer-magpie.git
magpie plugin add /path/to/prompt-optimizer-magpie
```

## 配置

> ⚠️ **`gatewayTimeoutMs` 必须写进插件 options**，不能只靠代码默认值。实测：不显式设置时 Magpie 给单 hook 的预算约 1 秒，异步 hook 会被静默放弃；设为 `25000` 后决策+优化链路才有足够时间。安装后第一件事就是下发 options：

```bash
magpie plugin options prompt-optimizer-magpie '{
  "enabled": true,
  "dryRun": true,
  "deciderGroup": "group/route-decider",
  "optimizeGroup": "group/prompt-optimize",
  "minChars": 6,
  "maxChars": 12000,
  "bypassPrefix": ["!!", "##"],
  "logRewrites": true,
  "logRewriteChars": 600,
  "bypassModels": [],
  "allowedOrigins": [],
  "skipToolless": true,
  "deciderTimeoutMs": 1500,
  "optimizeTimeoutMs": 15000,
  "gatewayTimeoutMs": 25000,
  "gatewayUrl": "http://127.0.0.1:3425",
  "port": 27497,
  "bind": "127.0.0.1"
}'
```

| 选项 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `dryRun` | `true` | 干跑：走完整链路并记日志，但**不改写**请求。先 dry run 几天看 `stats/` 日志，确认无误判再关 |
| `deciderGroup` | `group/route-decider` | 决策模型组；留空 `""` = 纯规则模式（长线程全放行，只优化首轮） |
| `optimizeGroup` | `group/prompt-optimize` | 优化调用的模型组 |
| `minChars` / `maxChars` | `6` / `12000` | 用户原文长度窗口。`<minChars` 同步硬放行；`maxChars` 是防整本书粘贴的绝对上限，正常范围内的长文本交决策模型判断 |
| `guardRatioLimit` | `10` | 输出护栏上限倍率：改写词元数上限 `clamp(原文词元 × N, 60, 2000)`。默认 ×10（生产实测：52 词元原文的结构化改写 430 词元曾被 ×5 误杀）；配置页可改 |
| `bypassPrefix` | `["!!", "##"]` | 用户原文以任一前缀开头则原样发送。**推荐用 `##`**：omp/pi 等 TUI 会把 `!!` 当 shell 转义吃掉，根本到不了网关；claude 类 TUI 也把 `!!` 当 bash 输入。`##` 在所有实测 agent 上都能原样到达（claude/grok 已验证 bypass-prefix） |
| `bypassAnchors` | 13 项，见代码默认 | 机器叙述**开头**锚点：用户原文剥掉前导 ACP 行 / `[Replying to: …]` 后以任一项开头，即判为机器转述（工具结果、advisory、agent 复述），`bypass-anchor` 直接放行，零模型调用。只匹配开头；正文中间提到不算。真人输入若恰好以 `Tool result`、`// `、`<chat>` 等开头会被跳过（不优化，请求不改） |
| `bypassWrappers` | `["<system-notice>", "<title-request>", "<progress-check>", "<job>", "<recap>"]` | 机器注入包装的**开头开标签**：`<job>`、`<system-notice id="x">`（带属性也算）→ `bypass-wrapper` 放行。仅开头匹配；闭合标签、第二行及正文中间出现不命中 |
| `bypassModels` | `[]` | 命中这些 `body.model` 直接放行（排除机器任务模型，如 `group/bili-summary`） |
| `bypassAgents` | `[]` | 命中这些 `ctx.agent` 直接放行（不想被优化的 agent 白名单，任何网关调用前拦截） |
| `cacheTtlMs` | `60000` | 按 agent、原文、网关、优化组、配置及实际模式、档位和 dryRun 隔离，在插件目录 `.cache.json.d/` 按键原子发布改写。≤0 停止缓存读写。旧 `.cache.json` 留在原处，不再读取 |
| `debugDump` | `''` | 设为路径时将请求体的脱敏副本追加到该文件；`true` 写插件目录 `debug-dump.log`。敏感字段先替换为 `[REDACTED]`，再截断 |
| `allowedOrigins` | `[]` | 非空时仅放行白名单内的 `ctx.origin`；origin 缺字段时 fail-open（不拦截） |
| `skipToolless` | `true` | 无 tools 的请求直接放行（多为机器/闲聊调用） |
| `optimizerMode` | `auto` | `merged` = 单次 optimize 调用同时完成「新任务判定 + 模板档位 + 改写」（首行 `[tpl:…]` / `[passthrough]` 标记协议）；`auto`（默认）= 现两段式 decider→optimize 不变 |
| `rollout` | `null` | 首轮会话灰度，示例见下文 |
| `overrides` | `[]` | 按顺序匹配第一条有效规则。可精确匹配 `agent`、目标 `model` 或两者；可设非负整数 `budgetMs`、首轮 `optimizerMode`，或两者 |
| `deciderFallback` | `rule` | `auto` 模式下 decider 失败时的回落：`rule`（默认）纯规则路径；`merged` 转单次合并调用（熔断打开时退回 `rule`） |
| `deciderTimeoutMs` | `1500` | 决策调用超时 |
| `gatewayUrl` | `http://127.0.0.1:3425` | 网关自环地址（决策 + 优化都回调网关） |
| `logRewrites` | `true` | 审计日志是否记录改写原文（`orig`/`rewritten` 字段）；`false` 关闭，只记长度 |
| `logRewriteChars` | `600` | 审计原文每字段截断长度，超出记 `…(+N chars)` |
| `logSkips` | `true` | `false` 时不记录常规 `pass` 事件（not-turn / self-loop / no-tools 等噪音）；**失败类始终记录**（optimize-fail / decider-fail / optimize-empty / error），排障不瞎 |
| `logOptimizes` | `true` | `false` 时不记录成功路径的 `optimize` / `decide` 事件（optimized / cache-hit / dry-run / followup 等）；失败类不受此开关影响 |

| `port` / `bind` | `27497` / `127.0.0.1` | 统计服务监听：**浏览器一律走 magpie 同源代理** `/_magpie/plugin/<token>/_magpie/service/`（宿主对声明了 `magpie.page.service` 的插件自动反向代理，本机与远程一致），不直连该端口。`port` 必须为 1–65535 固定值（默认 27497，与 magpie 文档一致；冲突时自动顺延尝试 +1..+5）。`bind` 默认仅本机回环；**开 `0.0.0.0` 仅限脱离 magpie 单独跑 `serve.mjs` 时使用**——stats 日志里的提示词原文（`orig`/`rewritten` 截断文本）会对网络可见，只在可信内网开；serve.mjs 也可用环境变量 `POM_BIND` 覆盖 |

## 日志布局与保留（按天分文件，7 天清理）

事件写在**包外用户配置区** `~/.config/magpie/prompt-optimizer-magpie/stats/`（`homedir()` 解析；Windows 同样落到 `~/.config/...`），**每天一个文件**（`YYYY-MM-DD.ndjson`，**本地时区**日界；页面时间戳同按本地时区渲染）。数据目录在包外，`magpie plugin update` 重装包目录不再丢数据；环境变量 `POM_STATS_DIR` 可显式覆盖。首次启动时若检测到包内旧 `stats/` 目录，会自动**复制**到新目录（同名文件跳过、不覆盖）并写入 `MIGRATED.txt` 标记，只迁一次。历史存量文件为 UTC 日命名，不重命名不合并——升级当天本地日与 UTC 日可能各有一个文件，属一次性过渡，读端按文件名分组不受影响。为什么不是单文件：`record()` 在 magpie plugin-host 进程里 append，而 `prune()` 在服务进程里执行——两个进程对同一个文件做「重写+rename」和「append」存在竞态（rename 瞬间落地的 append 会写进旧 inode 丢一条）。按天分文件后，保留策略变成 **unlink 整个过期日文件**，写者永远只 append 今天的文件，两边操作的 inode 不相交，竞态从结构上消除；单文件也不再无限增长，prune 从全量重写降为删文件。

- `prune` 由共享的 `startStatsService` 在**两个入口**（index.mjs 宿主内服务 + serve.mjs daemon）启动时和每 24 小时执行：删除文件名日期早于 `POM_RETAIN_DAYS`（默认 `7`）的日文件；`0` 或负数 = 永久保留。只跑 in-app 页面、不部署 serve.mjs 的安装也会自动清理。
- systemd 部署示例：`Environment=POM_RETAIN_DAYS=7`。
- 旧版单文件 `stats.ndjson` 不再读取；如需保留历史请自行归档。

## 输出护栏

- 剥离外围代码围栏；新结果和缓存命中都比对 `[REDACTED]`、双花括号占位符和反引号标识符的**数量**；字面比对容错等价写法（`{{ name }}` ≡ `{{name}}`，反引号 token 比内容），数量增减仍拦截；
- 长度上下限按**词元数**而非字符数（中文 1 字 = 1 词元，连续英文单词/数字/标识符 = 1 词元，标点空白不计）：JS `.length` 按 UTF-16 code unit 计数，天然低估中文、高估英文，同一护栏对两种语言宽严不一；
- 下限 `0.4×` 原文词元（防止越改越短）；上限 `clamp(guardRatioLimit × 原文词元, 60, 2000)`，倍率默认 `10` 可配（配置页 `guardRatioLimit`）——短需求给足结构化扩写空间（60 词元保底，实测 17 字需求 → 552 字提示词是期望效果），长输入最多扩 N 倍且封顶 2000 词元。生产事故驱动：182 字中文原文 → 612 字优质改写曾被字符级 ×3 上限误杀；
- 护栏触发细分为三个 reason，统计页红色分组可观测：`output-guard-short`（低于下限）/ `output-guard-long`（超上限）/ `output-guard-tokens`（token 校验失败）。

替换只动最后一条 user 消息中**唯一匹配**的用户原文 span：先逐字匹配，失败后空白规范化匹配；零命中或多重命中一律放行，绝不用 `ctx.query` 整段覆盖。

## 统计与灰度

通过共同硬门的每个请求只写一条无正文的 `action=summary`。面板按实验、内容版本与组别统计样本量、实际回写率、放行原因、模型调用次数和 hook p95；旧日文件继续提供过程明细，不能补算请求分母。关闭过程日志仍保留摘要。盲评流程和离线样本见 [eval/README.md](eval/README.md)。

仅为已确认 `ctx.session` 跨重试稳定的 agent 启用实验。例如 `"rollout":{"experimentId":"first-v1","agents":["codex"],"autoPercent":40,"mergedPercent":10}` 将其首轮分为 auto 40%、merged 10%、原文直通 50%。两比例之和必须小于 100。设 mergedPercent 为 0 可撤回该组且保留 auto 桶；设 rollout 为 null 恢复全局行为。未提供有效会话标识的请求走既有基线，在面板单计缺失数；线程或未列出的 agent 仍走全局配置。两种实验组继承 dryRun；要测实际回写需设 false。内容 SHA 同时标识摘要和精确缓存，模板、判定或合并协议更新后旧条目自然过期。

例如 `"overrides":[{"agent":"cli","model":"group/interactive","budgetMs":350},{"agent":"batch","optimizerMode":"merged"}]`。350 毫秒从进入 hook 起算，判定和改写共用；耗尽时放行原文并记录 `budget-exhausted`，0 表示直接放行。目标模型匹配的是入站 `body.model`。实验组优先选择模式，预算仍生效；线程保留原有门禁。没有匹配项使用全局配置。

钩子将审计事件写入 `~/.config/magpie/prompt-optimizer-magpie/stats/YYYY-MM-DD.ndjson`（本地时区日文件，按事件追加，写失败静默；数据目录在包外，update 不丢）。默认在 `optimized` / `dry-run` / `output-guard*` / `no-span` / `decide` 事件上附带先脱敏、再截断的文本（`orig`/`rewritten`，默认 600 字），插件层可直接审计每次改写质量；`logRewrites: false` 可关闭。新增判定/失败归因字段（有值才写）：`decideVerdict` / `decideConfidence`（`decide` 事件记被拒判定，`summary` 记被接受判定）、`bypassPrefixHit`（命中的放行前缀）、`deciderError`（`deciderHttpStatus` 0.2.8 起已有）、`errorKind` / `errorMsg`、`budgets`（`budget-short` 的预算算式）。

**机器旁路**：`bypassAnchors` 开头命中 → `bypass-anchor`；`bypassWrappers` 开标签命中 → `bypass-wrapper`。二者都只看剥离前导噪声后的开头，正文中间出现不命中。**宿主取消**：宿主已取消本钩子时，若 `deciderTimeoutMs + optimizeTimeoutMs + 1000 > gatewayTimeoutMs`，记 `budget-short` 并附 `budgets`（如 `2500+25000>25000`），否则记 `host-abort`；未声明 `gatewayTimeoutMs` 按 1000 计。该标签只表示「宿主取消 + 所声明的预算装不下所声明的超时」，不证明取消由预算导致。
`action`/`reason` 覆盖：`pass`（disabled / subagent / self-loop / bypass-model / bypass-anchor / bypass-wrapper / origin / bypass-prefix / no-tools / not-turn / no-user-text / short-text / too-long / host-abort / budget-short / no-decider-followup / optimize-fail / optimize-empty / output-guard-short / output-guard-long / output-guard-tokens / merged-fail / merged-passthrough / merged-circuit-open / error）、`decide`（decider-fail / decider-fail-rule / decider-fail-merged / followup / low-confidence）、`optimize`（dry-run / optimized / merged-optimized / cache-hit / no-span）。

决策失败后，已有助手回复的线程直接放行；首轮按实际降级路径记录 `decider-fail-rule` 或 `decider-fail-merged`。Responses 携带 `previous_response_id` 时直接放行。每个请求只上报一次终态；实际回写报 `ready` 并附返回请求体的 UTF-8 字节数，干跑或普通放行报 `skipped, 0`，最终模型调用失败报 `unavailable, 0`。

**merged 模式 reason**：`merged-optimized`（标记解析成功 + 护栏通过，已替换）；`merged-passthrough`（模型判定追问/已结构化，原样放行，不写缓存）；`merged-fail`（响应不带合法首行标记，或网络/HTTP 失败——fail-open）；`merged-circuit-open`（同一网关和优化组连续 5 次 `merged-fail` 后熔断 10 分钟，到期从零重新计数，期间 merged/降级入口直接走纯规则，内存态，进程重启清零）。

建议先 `dryRun: true` 跑几天：若 `decider-fail` / `decider-fail-rule` 偏多说明决策服务不稳；若追问被误判为 `new_task` 偏多（看 `optimize/dry-run`），需调整决策 criteria。确认无误判后再 `dryRun: false`。

## 测试

```bash
node --test     # 或 npm test
```

测试覆盖四协议 turn 判定、门禁、span 唯一匹配、fail-open（决策 500 / 决策超时 / 优化超时 / 死网关 / 垃圾 JSON）、统计、模板档位与语言选择、多网卡 Host 校验、IPv6 规范化与指定 bind 地址复用、merged 模式（单次调用 / 首行标记协议 / [passthrough] 不缓存 / 成功改写入缓存重放 / 熔断 / 线程硬门 / decider 降级 / 缺省回归），以及上一轮评审修复的回归（决策失败回落纯规则、输出上限随原文长度、决策器收原文、纯规则长线程放行、output-guard 短输入展开）。

## 模板来源与同步

`templates/` 下的 `.ts` 文件逐字节拷贝自上游 `packages/core/src/services/template/default-templates/user-optimize/`，文件头注释了来源路径和 commit hash（develop `62b49a1f`，2026-11-18）。中文三档和英文 professional 的运行文案维护在 `templates/overrides.mjs`。修改后运行 `node tools/gen-templates.mjs` 生成并校验 `templates/index.mjs`；更新上游快照时应单独核对本地文案。

## 许可证

[AGPL-3.0-only](./LICENSE)。本仓库 vendored 了 AGPL 项目的模板文本，属于衍生作品，因此整体以 AGPL-3.0-only 发布——包括你 fork 或修改后的分发版本。
