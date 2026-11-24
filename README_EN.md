# prompt-optimizer-magpie

English | [中文](./README.md)

A self-contained [Magpie](https://usemagpie.ai) gateway request hook that rewrites your vague prompts into precise, specific, actionable ones **before they reach the model**. Every client routing through the gateway (Claude Code, Codex, Gemini CLI, opencode...) benefits with zero per-client setup — no hooks to configure in each CLI.

```
user message ──▶ Magpie gateway ──▶ [this plugin's onRequest]
                                ├─ 1. rule pre-filter (sync, zero cost)
                                ├─ 2. decision gate (optional, /v1/systemone, 1.5s timeout)
                                ├─ 3. optimize (/v1/chat/completions → group/prompt-optimize)
                                └─ 4. replace the user's original text in the last user message, pass through
                                ✗ any failure → pass through unchanged (fail-open, never blocks)
```

> Core templates vendored from [linshenkx/prompt-optimizer](https://github.com/linshenkx/prompt-optimizer) (AGPL-3.0-only) — see `templates/` and [docs/design.md](./docs/design.md).

## Features

- **Zero client config**: installs on the Magpie gateway; one deployment covers every agent CLI wired to the gateway.
- **New tasks only**: follow-ups, confirmations, short replies, code pastes and oversized structured prompts pass through untouched — you never burn an optimize call on "continue". The decider sees the verbatim user text plus whether an assistant reply exists, and classifies accordingly.
- **Two-layer gate**: sync rules reject most requests; only borderline ones hit a decision model (System One) binary call. Leave `deciderGroup` empty for rules-only mode — in that mode **threads with an assistant reply always pass through; only genuine first turns are optimized**.
- **Machine-call exclusion**: `bypassModels` skips known machine-task models (Hermes compaction / title generation — these also arrive with origin=local, so source alone can't exclude them); subagents (`ctx.kind==="subagent"`) and the optimizer's/decider's own recursion are auto-skipped.
- **Fail-open**: decider timeout, optimizer timeout, bad response, JSON parse error, span mismatch... everything falls back to the original text. A broken plugin behaves as if it weren't installed.
- **Model groups externalized**: the optimizer and decider are Magpie groups; the plugin only references group names, so swapping models never touches plugin code.

## Install

Prerequisites: a running Magpie gateway (default `http://127.0.0.1:3425`) with two model groups configured (see `magpie group --help`):

```bash
# optimizer group: cheap, fast, decent CN/EN rewriting, ordered failover
magpie group add group/prompt-optimize <modelA> <modelB> --routing order

# decider group (optional; empty = rules-only mode): a model supporting /v1/systemone
magpie group add group/route-decider <decision-model> --routing order
```

Then install the plugin from a local directory:

```bash
magpie plugin add npm:prompt-optimizer-magpie
```

Or install from source (local directory):

```bash
git clone https://github.com/Luck9Star/prompt-optimizer-magpie.git
magpie plugin add /path/to/prompt-optimizer-magpie
```

## Configuration

> ⚠️ **`gatewayTimeoutMs` must be set in the plugin options** — the code default alone is not enough. Measured: without it Magpie budgets ~1s per hook and silently abandons the async hook; `25000` gives the decide+optimize chain enough room. Push options right after installing:

```bash
magpie plugin options prompt-optimizer-magpie '{
  "enabled": true,
  "dryRun": true,
  "deciderGroup": "group/route-decider",
  "optimizeGroup": "group/prompt-optimize",
  "minChars": 6,
  "maxChars": 12000,
  "bypassPrefix": ["!!", "##"],
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

| Option | Default | Description |
|---|---|---|
| `enabled` | `true` | master switch |
| `dryRun` | `true` | run the full chain and log, but **don't rewrite** requests. Dry-run for a few days and watch the daily files under `stats/` before turning it off |
| `deciderGroup` | `group/route-decider` | decision model group; `""` = rules-only mode (threads pass through, first turns only) |
| `optimizeGroup` | `group/prompt-optimize` | model group for optimize calls |
| `cacheTtlMs` | `60000` | Atomically published rewrites in `.cache.json.d/` are keyed by agent, original text, gateway, optimize group, configured and effective modes, tier and dry-run state. A value ≤0 disables cache I/O. The old `.cache.json` stays on disk and is ignored. |
| `debugDump` | off | Append a redacted copy of candidate requests to a file. Set a path or use `true` for `debug-dump.log` beside the hook. Sensitive fields become `[REDACTED]` before clipping. |
| `minChars` / `maxChars` | `6` / `12000` | user-text length window. `<minChars` is a sync hard pass; `maxChars` is an absolute ceiling against book-length pastes — in-range long text is left to the decider |
| `guardRatioLimit` | `10` | output-guard ceiling ratio: rewrite unit ceiling is `clamp(orig units × N, 60, 2000)`. Default ×10 (in production a 430-unit structured rewrite of a 52-unit prompt was killed by ×5); editable on the config page |
| `bypassPrefix` | `["!!", "##"]` | user text starting with either prefix is sent verbatim |
| `bypassAnchors` | 13 entries, see code defaults | **leading** machine-narration anchors: after stripping leading ACP lines / `[Replying to: …]`, text that starts with any entry is machine transcription (tool results, advisory, agent paraphrase) → `bypass-anchor`, zero model calls. Leading match only; a mention mid-body doesn't count. Human text that happens to start with `Tool result`, `// `, `<chat>` etc. is skipped (not optimized, request untouched) |
| `bypassWrappers` | `["<system-notice>", "<title-request>", "<progress-check>", "<job>", "<recap>"]` | **leading** open tag of a machine-injected wrapper: `<job>`, `<system-notice id="x">` (attributes allowed) → `bypass-wrapper`. Leading only; closing tags, a tag on line 2, or a mid-body mention don't match |
| `bypassModels` | `[]` | requests whose `body.model` matches pass through (machine-task models, e.g. `group/bili-summary`) |
| `allowedOrigins` | `[]` | when non-empty, only these `ctx.origin` values pass; a missing origin is fail-open (not blocked) |
| `skipToolless` | `true` | requests without tools pass through (mostly machine/chit-chat calls) |
| `optimizerMode` | `auto` | `merged` = a single optimize call does new-task detection + template tier + rewrite (first-line `[tpl:…]` / `[passthrough]` marker protocol); `auto` (default) keeps the current two-stage decider→optimize flow |
| `rollout` | `null` | First-turn session experiment (example below) |
| `overrides` | `[]` | First valid exact match on agent, requested model, or both. Set a nonnegative integer budgetMs and/or first-turn optimizerMode. |
| `deciderFallback` | `rule` | fallback when the decider fails in `auto` mode: `rule` (default) = rules-only path; `merged` = reroute to the single merged call (drops back to `rule` while the breaker is open) |
| `deciderTimeoutMs` | `1500` | decider call timeout |
| `gatewayTimeoutMs` | `25000` | **must be set explicitly** — per-hook budget, see above |
| `gatewayUrl` | `http://127.0.0.1:3425` | gateway loopback address (decide + optimize both call back into the gateway) |
| `logRewrites` / `logRewriteChars` | `true` / `600` | audit log carries clipped prompt text (`orig`/`rewritten`); `false` logs lengths only |
| `port` / `bind` | `27497` / `127.0.0.1` | stats service listener: **the browser always goes through magpie's same-origin proxy** `/_magpie/plugin/<token>/_magpie/service/` (the host reverse-proxies plugins that declare `magpie.page.service`, local and remote alike) and never connects to this port directly. `port` must be a fixed value in 1–65535 (default 27497, matching the magpie docs; on conflict the service retries +1..+5). `bind` defaults to loopback only; **`0.0.0.0` is only for running `serve.mjs` standalone, outside magpie** — it makes the clipped prompt text in the stats log (`orig`/`rewritten`) visible to the network, so only on trusted LANs. serve.mjs also honors the `POM_BIND` env override |

## Output guardrails

An optimized result is only substituted after passing the guardrails, otherwise the original passes through:

- strip surrounding code fences and verify **counts** of `[REDACTED]`, double-brace placeholders and backticked identifiers, including on cache hits; literal comparison tolerates equivalent spelling (`{{ name }}` ≡ `{{name}}`, backtick tokens compare their content), while any count change still trips the guard;
- length bounds use **token units**, not chars (each CJK ideograph = 1 unit, each contiguous word/number/identifier run = 1, punctuation/whitespace = 0): JS `.length` counts UTF-16 code units, under-measuring CJK and over-measuring English, so one char-based rule was strict for Chinese and loose for English;
- lower bound `0.4×` original units (prevents over-shrinking); upper bound `clamp(guardRatioLimit × original units, 60, 2000)` — ratio defaults to `10` and is configurable (config page `guardRatioLimit`). Short prompts get room for structured expansion (60-unit floor; measured: a 17-char request → a 552-char prompt is the desired outcome); long inputs may expand at most N× capped at 2000 units. Production-incident driven: a 182-char Chinese orig → 612-char good rewrite was killed by the char-based ×3 ceiling;
- guard trips split into three red-group reasons on the stats page: `output-guard-short` (below floor) / `output-guard-long` (above ceiling) / `output-guard-tokens` (token check failed).

Substitution touches only the **uniquely matched** user-text span in the last user message: verbatim match first, then whitespace-normalized; zero or multiple hits → pass through. `ctx.query` is never used to overwrite the whole message.

## Stats & rollout

Each eligible request writes one text-free `action=summary` record, independently of detail logging. The dashboard groups sample counts, applied rewrites, pass reasons, model calls and hook p95 by experiment, content version and arm. Older day files contribute detail events only. See the [blind evaluation guide](eval/README.md) for offline samples.

Enable `rollout` only for agents whose `ctx.session` is stable across retries. Example: `"rollout":{"experimentId":"first-v1","agents":["codex"],"autoPercent":40,"mergedPercent":10}` assigns 40% of eligible first turns to auto, 10% to merged, and 50% to true passthrough. Percentages must sum to less than 100. Setting mergedPercent to 0 preserves auto buckets; setting rollout to null restores the global configuration. Missing sessions use baseline and are counted in the dashboard. Threads and unlisted agents keep their global routing. Experiment arms inherit dryRun. The content SHA identifies both terminal summaries and cache entries across template, decision and protocol revisions.

Example: `"overrides":[{"agent":"cli","model":"group/interactive","budgetMs":350},{"agent":"batch","optimizerMode":"merged"}]`. The 350 ms budget starts at hook entry and is shared by decision and rewrite calls. Exhaustion passes the original with reason `budget-exhausted`; zero passes immediately. Model selectors match inbound `body.model`. Rollout arms take precedence over the first-turn mode override, while the budget still applies. Threads keep their existing gates; unmatched requests use global settings.

The hook appends audit events to the daily file `YYYY-MM-DD.ndjson` under `~/.config/magpie/prompt-optimizer-magpie/stats/` (resolved from `homedir()`; Windows uses `~/.config/...` too — local-timezone day boundaries, append-only, write failures are silent; page timestamps render in local time). The data dir lives **outside the package**, so `magpie plugin update` reinstalls no longer wipe it; set `POM_STATS_DIR` to override. On first start, a legacy package-internal `stats/` dir is **copied** to the new location (same-name files skipped, never overwritten; a `MIGRATED.txt` marker makes it one-shot). Existing files are UTC-day named and are neither renamed nor merged — on upgrade day a local-day and a UTC-day file may coexist; a one-off transition, harmless to the filename-grouped reader. By default `optimized` / `dry-run` / `output-guard*` / `no-span` / `decide` events carry redacted, clipped prompt text (`orig`/`rewritten`, 600 chars by default) so every rewrite can be audited at the plugin layer; set `logRewrites: false` to log lengths only. Decision/failure attribution fields are written when present: `decideVerdict` / `decideConfidence` (rejected decisions on `decide` events, accepted ones on `summary`), `bypassPrefixHit` (the matched prefix), `deciderError` (`deciderHttpStatus` has existed since 0.2.8), `errorKind` / `errorMsg`, `budgets` (the arithmetic behind `budget-short`).

**Machine bypass**: a leading `bypassAnchors` hit → `bypass-anchor`; a leading `bypassWrappers` open tag → `bypass-wrapper`. Both look only at the start of the text after leading noise is stripped — mid-body mentions don't match. **Host abort**: when the host has already aborted the hook, `deciderTimeoutMs + optimizeTimeoutMs + 1000 > gatewayTimeoutMs` logs `budget-short` with `budgets` (e.g. `2500+25000>25000`), otherwise `host-abort`; an undeclared `gatewayTimeoutMs` counts as 1000. The label means "host aborted + the declared budget can't fit the declared timeouts" — it doesn't prove the abort was caused by the budget.
 `action`/`reason` cover: `pass` (disabled / subagent / self-loop / bypass-model / bypass-anchor / bypass-wrapper / origin / bypass-prefix / no-tools / not-turn / no-user-text / short-text / too-long / host-abort / budget-short / no-decider-followup / optimize-fail / optimize-empty / output-guard-short / output-guard-long / output-guard-tokens / merged-fail / merged-passthrough / merged-circuit-open / error), `decide` (decider-fail / decider-fail-rule / decider-fail-merged / followup / low-confidence), `optimize` (dry-run / optimized / merged-optimized / cache-hit / no-span).

Retention: the active listener (embedded service or standalone daemon) prunes day files older than `POM_RETAIN_DAYS` (default `7`) at startup and every 24h; `0`/negative keeps everything. Installs that only use the in-app page never grow `stats/` unbounded either. The legacy single-file `stats.ndjson` is no longer read — archive it yourself if you want the history.

If the decider fails, an existing thread passes through. A first turn records `decider-fail-rule` or `decider-fail-merged` according to the path taken. Responses requests with `previous_response_id` pass directly. Each request reports its outcome once. An applied rewrite reports `ready` with the UTF-8 size of the returned body. Dry runs and ordinary passes report `skipped, 0`. A final model failure reports `unavailable, 0`.

**merged-mode reasons**: `merged-optimized` (marker parsed + guardrails passed, rewrite applied); `merged-passthrough` (model judged the input a follow-up / already structured, passed verbatim, never cached); `merged-fail` (response missing a valid first-line marker, or network/HTTP failure — fail-open); `merged-circuit-open` (after 5 consecutive failures for a gateway and optimize group, the breaker opens for 10 minutes and resets the count on expiry — merged and the fallback entry route to the rules-only path while open; in-memory state, resets on process restart).

Start with `dryRun: true` for a few days: a high `decider-fail` / `decider-fail-rule` rate means the decision service is unstable (on failure the hook falls back to rules-only behavior — threads pass, first turns still get optimized); if follow-ups get misclassified as `new_task` (watch `optimize/dry-run`), tune the decision criteria. Turn `dryRun: false` only once the false-positive rate looks right.

## Tests

```bash
node --test     # or npm test
```

Coverage includes four-protocol turn detection, gates, unique span matching, fail-open (decider 500 / decider timeout / optimize timeout / dead gateway / garbage JSON), stats, template tier + language selection, multi-interface Host validation, IPv6 normalization, listener reuse on the configured address, merged mode (single call / first-line marker protocol / [passthrough] never cached / successful rewrites cached and replayed / circuit breaker / thread hard gate / decider fallback / default-behavior regression), plus the previous round's review-fix regressions.

## Template provenance & syncing

The `.ts` files under `templates/` are byte-for-byte copies of upstream `packages/core/src/services/template/default-templates/user-optimize/`, each with a header comment noting source path and commit hash (develop `62b49a1f`, 2026-11-18). Maintain the three Chinese tiers and the English professional text in `templates/overrides.mjs`. Run `node tools/gen-templates.mjs` to generate and verify `templates/index.mjs`. Review the overrides when updating the vendored snapshots.

## License

[AGPL-3.0-only](./LICENSE). This repo vendors template text from an AGPL project, making it a derivative work, so the whole repo ships under AGPL-3.0-only — including any fork or modified version you distribute.
