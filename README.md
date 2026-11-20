# prompt-optimizer-magpie

[English](./README_EN.md) | 中文

一个自包含的 [Magpie](https://usemagpie.ai) 网关请求钩子（request hook）：在你的模糊提示词**到达模型之前**，先由一个便宜的模型把它改写成精准、具体、可执行的提示词。所有经过网关的客户端（Claude Code、Codex、Gemini CLI、opencode……）零配置受益——不用逐个客户端配 hook。

```
用户消息 ──▶ Magpie 网关 ──▶ [本插件 onRequest]
                          ├─ 1. 规则预过滤（同步，零成本）
                          ├─ 2. 决策门禁（可选，/v1/systemone，2s 超时）
                          ├─ 3. 优化改写（/v1/chat/completions → group/prompt-optimize）
                          └─ 4. 替换最后一条 user 消息中的用户原文，放行
                          ✗ 任何一步失败 → 原文放行（fail-open，绝不阻断请求）
```

> 核心模板 vendored 自 [linshenkx/prompt-optimizer](https://github.com/linshenkx/prompt-optimizer)（AGPL-3.0-only），见 `templates/` 与 [docs/design.md](./docs/design.md)。

## 特性

- **零客户端配置**：装在 Magpie 网关，一次部署覆盖所有接入了网关的 agent CLI。
- **只改「新任务」需求**：追问、确认、短消息、代码粘贴、超长结构化 prompt 一律放行——你不会在每次「继续」时浪费一次优化调用。决策模型会看到用户原文 + 是否已有助手回复，据此区分新任务与追问。
- **双层门禁**：同步规则先拦掉大多数请求；拿不准的才走一次决策模型（System One）二分判断。`deciderGroup` 留空则纯规则运行——此时**长线程（已有助手回复）一律放行，只优化真正的首轮**。
- **机器调用排除**：`bypassModels` 可排除 Hermes 压缩 / 标题生成等机器任务模型（这些 origin 也是 local，单靠来源挡不住）；`ctx.kind==="subagent"` 子代理、自环模型（优化器/决策器自己的回源请求）自动跳过。
- **fail-open**：决策超时、优化超时、返回异常、JSON 解析失败、span 匹配失败……一律原文放行。插件坏了 = 没装插件，不会弄坏你的网关。
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
  "bypassPrefix": "!!",
  "bypassModels": [],
  "allowedOrigins": [],
  "skipToolless": true,
  "deciderTimeoutMs": 1500,
  "optimizeTimeoutMs": 15000,
  "gatewayTimeoutMs": 25000,
  "gatewayUrl": "http://127.0.0.1:3425"
}'
```

| 选项 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `dryRun` | `true` | 干跑：走完整链路并记日志，但**不改写**请求。先 dry run 几天看 `stats.ndjson`，确认无误判再关 |
| `deciderGroup` | `group/route-decider` | 决策模型组；留空 `""` = 纯规则模式（长线程全放行，只优化首轮） |
| `optimizeGroup` | `group/prompt-optimize` | 优化调用的模型组 |
| `minChars` / `maxChars` | `6` / `12000` | 用户原文长度窗口。`<minChars` 同步硬放行；`maxChars` 是防整本书粘贴的绝对上限，正常范围内的长文本交决策模型判断 |
| `bypassPrefix` | `"!!"` | 用户原文以此前缀开头则原样发送 |
| `bypassModels` | `[]` | 命中这些 `body.model` 直接放行（排除机器任务模型，如 `group/bili-summary`） |
| `allowedOrigins` | `[]` | 非空时仅放行白名单内的 `ctx.origin`；origin 缺字段时 fail-open（不拦截） |
| `skipToolless` | `true` | 无 tools 的请求直接放行（多为机器/闲聊调用） |
| `deciderTimeoutMs` | `1500` | 决策调用超时 |
| `optimizeTimeoutMs` | `15000` | 优化调用超时 |
| `gatewayTimeoutMs` | `25000` | **必须显式设置**的单 hook 预算，见上 |
| `gatewayUrl` | `http://127.0.0.1:3425` | 网关自环地址（决策 + 优化都回调网关） |

## 输出护栏

优化结果必须通过护栏才会被替换，否则原文放行：

- 剥离 ``` 代码围栏；
- 长度下限 `0.4×` 原文（防止越改越短）；
- 长度上限 `max(3×原文, 1500)`——短需求本就该展开成长结构化提示词（实测 17 字需求 → 552 字提示词是期望效果），固定 3× 会误杀所有短输入；
- 绝对上限 `6000` 字，防异常膨胀。

替换只动最后一条 user 消息中**唯一匹配**的用户原文 span：先逐字匹配，失败后空白规范化匹配；零命中或多重命中一律放行，绝不用 `ctx.query` 整段覆盖。

## 统计与灰度

每次经过钩子都会向插件目录下的 `stats.ndjson` 追加一条记录（append-only，写失败静默，不记原文全文，只记长度）。`action`/`reason` 覆盖：`pass`（disabled / subagent / self-loop / bypass-model / origin / bypass-prefix / no-tools / not-turn / no-user-text / short-text / too-long / no-decider-followup / optimize-fail / optimize-empty / output-guard / error）、`decide`（decider-fail / followup / low-confidence）、`optimize`（dry-run / optimized / no-span）。

建议先 `dryRun: true` 跑几天：若 `decider-fail` 偏多说明决策服务不稳；若追问被误判为 `new_task` 偏多（看 `optimize/dry-run`），需调整决策 criteria。确认无误判后再 `dryRun: false`。

## 测试

```bash
node --test     # 或 npm test
```

48 个用例：四协议 turn 判定、门禁、span 唯一匹配、fail-open（决策 500 / 决策超时 / 优化超时 / 死网关 / 垃圾 JSON）、统计、以及本轮评审修复的回归（决策器收原文、纯规则长线程放行、output-guard 短输入展开）。

## 模板来源与同步

`templates/` 下的 `.ts` 文件逐字节拷贝自上游 `packages/core/src/services/template/default-templates/user-optimize/`，文件头注释了来源路径和 commit hash（develop `62b49a1f`，2026-11-18）。`templates/index.mjs` 由 `tools/gen-templates.mjs` 从这些 `.ts` 生成，运行期零依赖。上游更新后想跟进，重新拷贝并重新生成即可；不跟进则视为有意固定版本。

## 许可证

[AGPL-3.0-only](./LICENSE)。本仓库 vendored 了 AGPL 项目的模板文本，属于衍生作品，因此整体以 AGPL-3.0-only 发布——包括你 fork 或修改后的分发版本。
