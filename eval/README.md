# 三路盲评

用同一段完整对话分别运行原文直通、auto、merged，将每份最终提示词交给同一个下游模型。评审人独立判断意图保真和交付质量。内置四条虚构脱敏样本只供验证流程。

1. 运行 `node eval/generate.mjs --dry-run eval/samples.json /tmp/pom-eval-demo`。最后一个参数须为尚不存在的目录，父目录须存在。默认也是离线模式，真实 hook 消费本地构造的模型回复；下游输出也是占位文本。
2. 只把新目录中的 `review.json` 交给评审人。每条含完整原始对话、实际交给下游的末轮提示词、下游答案、随机编号及空白评分。行顺序随机。保管人另存带来源的 `key.json`，在收回评分前保密。
3. 评审人逐条填写 `lostConstraint`、`addedConstraint`（布尔值）及 `usability`（整数）。对照原始对话检查提示词和答案，遗漏原有约束记 lost，擅自增加约束记 added。按任务要求评交付物，0 为不可用，1 为需要返工，2 为可直接使用；在 `note` 写一个具体例子。固定这一套规则完成所有三路评分，保留随机编号。
4. 运行 `node eval/summarize.mjs /tmp/pom-eval-demo/key.json /tmp/pom-eval-demo/review.json`。输出按来源和样本类别统计件数、分母及最多三个实例索引。应放行却改写以样本预设的 expectPass 和实际文本比较自动计数，分母为应放行样本。丢／增约束使用全部样本作分母。交付更可用是同一样本的分数严格超过原文，下游原文组没有此比较分母。离线计数仅用于流程自检。

## 样本格式

输入是 JSON 数组。每条有唯一非空字符串 `id`、布尔值 `expectPass`（采集时确定）、`kind` 和 `messages`。消息按时间排序，角色为 user 或 assistant，content 为非空字符串，以待评 user 消息结尾。四类分别为 `vague-first`（模糊首轮）、`clear-first`（清晰首轮）、`followup`（追问）、`thread-new`（线程中的独立新任务）；后两类需保留助手回复。真实样本先脱敏再录入，包括历史中的标识值，需保留的名称和占位符原样写入。

## 真实生成

用独立的评测优化器网关和无自动改写插件的下游推理端点，避免原文对照被二次改写。每次运行只使用一个固定的下游模型版本、同一条 system 提示、相同历史、温度 0、上限 800 输出 token，无工具。样本只选能凭给定材料完成的文本任务。两种优化模式均通过生产 onRequest 生成候选，启用无工具评测、禁用缓存和正文审计，统计写入临时目录并在退出时清理。下游服务须兼容 Chat Completions。

```sh
EVAL_OPTIMIZER_GATEWAY=http://127.0.0.1:3425 \
EVAL_DOWNSTREAM_URL=http://127.0.0.1:9000/v1/chat/completions \
EVAL_MODEL=your-pinned-model-version \
node eval/generate.mjs --live eval/samples.json /tmp/pom-eval-live
```

仅 `--live` 访问这些服务，可能产生费用。按需通过环境变量 `EVAL_API_KEY` 为下游提供凭据。各路请求都不携带评审标签；模型标识和运行条件随私有 key 保存。真实模型即便温度为 0 也可能波动，比较优先看同类样本的配对结果。
