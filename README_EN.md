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
  "port": 0,
  "bind": "127.0.0.1"
}'
```

| Option | Default | Description |
|---|---|---|
| `enabled` | `true` | master switch |
| `dryRun` | `true` | run the full chain and log, but **don't rewrite** requests. Dry-run for a few days and watch the daily files under `stats/` before turning it off |
| `deciderGroup` | `group/route-decider` | decision model group; `""` = rules-only mode (threads pass through, first turns only) |
| `optimizeGroup` | `group/prompt-optimize` | model group for optimize calls |
| `minChars` / `maxChars` | `6` / `12000` | user-text length window. `<minChars` is a sync hard pass; `maxChars` is an absolute ceiling against book-length pastes — in-range long text is left to the decider |
| `bypassPrefix` | `["!!", "##"]` | user text starting with either prefix is sent verbatim |
| `bypassModels` | `[]` | requests whose `body.model` matches pass through (machine-task models, e.g. `group/bili-summary`) |
| `allowedOrigins` | `[]` | when non-empty, only these `ctx.origin` values pass; a missing origin is fail-open (not blocked) |
| `skipToolless` | `true` | requests without tools pass through (mostly machine/chit-chat calls) |
| `deciderTimeoutMs` | `1500` | decider call timeout |
| `optimizeTimeoutMs` | `15000` | optimizer call timeout |
| `gatewayTimeoutMs` | `25000` | **must be set explicitly** — per-hook budget, see above |
| `gatewayUrl` | `http://127.0.0.1:3425` | gateway loopback address (decide + optimize both call back into the gateway) |
| `logRewrites` / `logRewriteChars` | `true` / `600` | audit log carries clipped prompt text (`orig`/`rewritten`); `false` logs lengths only |
| `port` / `bind` | `0` / `127.0.0.1` | stats service listener: `port=0` = OS-assigned; `bind` defaults to loopback only. **Enabling LAN access (e.g. `0.0.0.0`) makes the clipped prompt text in the stats log (`orig`/`rewritten`) visible to your LAN** — only on trusted networks. serve.mjs also honors the `POM_BIND` env override |

## Output guardrails

An optimized result is only substituted after passing the guardrails, otherwise the original passes through:

- strip ``` fences;
- lower bound `0.4×` the original length (prevents over-shrinking);
- upper bound `max(3× original, 1500)` — a short prompt is *supposed* to expand into a long structured prompt (measured: a 17-char request → a 552-char prompt is the desired outcome), so a fixed 3× rule would kill every short input;
- absolute ceiling `max(6000, original length)` chars against runaway expansion — the ceiling scales with the `maxChars` admission width so long-but-legal inputs aren't optimized then silently discarded.

Substitution touches only the **uniquely matched** user-text span in the last user message: verbatim match first, then whitespace-normalized; zero or multiple hits → pass through. `ctx.query` is never used to overwrite the whole message.

## Stats & rollout

Every pass through the hook appends one record to the daily file `stats/YYYY-MM-DD.ndjson` in the plugin directory (UTC, append-only, write failures are silent). By default `optimized` / `dry-run` / `output-guard` / `no-span` / `decide` events carry clipped prompt text (`orig`/`rewritten`, 600 chars by default) so every rewrite can be audited at the plugin layer; set `logRewrites: false` to log lengths only. `action`/`reason` cover: `pass` (disabled / subagent / self-loop / bypass-model / origin / bypass-prefix / no-tools / not-turn / no-user-text / short-text / too-long / no-decider-followup / optimize-fail / optimize-empty / output-guard / error), `decide` (decider-fail / decider-fail-rule / followup / low-confidence), `optimize` (dry-run / optimized / no-span).

Retention: the shared `startStatsService` (both entry points — the index.mjs in-app service and the serve.mjs daemon) prunes day files older than `POM_RETAIN_DAYS` (default `7`) at startup and every 24h; `0`/negative keeps everything. Installs that only use the in-app page never grow `stats/` unbounded either. The legacy single-file `stats.ndjson` is no longer read — archive it yourself if you want the history.

`decider-fail-rule`: when the decision model is unavailable (timeout / network / parse failure) the hook no longer passes the whole request through — it falls back to the rules-only path (first turns still get optimized, threads pass conservatively, same semantics as `deciderGroup=""`), so a flapping decider never disables the plugin entirely.

Start with `dryRun: true` for a few days: a high `decider-fail` / `decider-fail-rule` rate means the decision service is unstable (on failure the hook falls back to rules-only behavior — threads pass, first turns still get optimized); if follow-ups get misclassified as `new_task` (watch `optimize/dry-run`), tune the decision criteria. Turn `dryRun: false` only once the false-positive rate looks right.

## Tests

```bash
node --test     # or npm test
```

107 cases: four-protocol turn detection, gates, unique span matching, fail-open (decider 500 / decider timeout / optimize timeout / dead gateway / garbage JSON), stats, template tier + language selection, LAN bind, plus regressions for this round's review fixes (decider failure falls back to rules-only, output ceiling scales with original length, decider receives the user text, rules-only thread pass-through, output-guard short-input expansion).

## Template provenance & syncing

The `.ts` files under `templates/` are byte-for-byte copies of upstream `packages/core/src/services/template/default-templates/user-optimize/`, each with a header comment noting source path and commit hash (develop `62b49a1f`, 2026-11-18). `templates/index.mjs` is generated from those `.ts` files by `tools/gen-templates.mjs` — zero runtime dependencies. To pick up upstream changes, re-copy and regenerate; not syncing is also a valid choice (deliberate pinning).

## License

[AGPL-3.0-only](./LICENSE). This repo vendors template text from an AGPL project, making it a derivative work, so the whole repo ships under AGPL-3.0-only — including any fork or modified version you distribute.
