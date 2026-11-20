# prompt-optimizer-magpie

English | [中文](./README.md)

A self-contained [Magpie](https://usemagpie.ai) gateway request hook that rewrites your vague prompts into precise, specific, actionable ones **before they reach the model**. Every client routing through the gateway (Claude Code, Codex, Gemini CLI, opencode...) benefits with zero per-client setup — no hooks to configure in each CLI.

```
user message ──▶ Magpie gateway ──▶ [this plugin's onRequest]
                                ├─ 1. rule pre-filter (sync, zero cost)
                                ├─ 2. decision gate (optional, /v1/systemone, 2s timeout)
                                ├─ 3. optimize (/v1/chat/completions → group/prompt-optimize)
                                └─ 4. replace the last user message, pass through
                                ✗ any failure → pass through unchanged (fail-open, never blocks)
```

> Core templates vendored from [linshenkx/prompt-optimizer](https://github.com/linshenkx/prompt-optimizer) (42k+ stars, AGPL-3.0-only) — see `templates/` and [docs/design.md](./docs/design.md).

## Features

- **Zero client config**: installs on the Magpie gateway; one deployment covers every agent CLI wired to the gateway.
- **First-turn tasks only**: follow-ups, short replies, code pastes and oversized structured prompts pass through untouched — you never burn an optimize call on "continue".
- **Two-layer gate**: sync rules reject most requests; only borderline ones hit a decision model (System One) binary call. Leave `deciderGroup` empty for rules-only mode.
- **Fail-open**: decider timeout, optimizer timeout, bad response, JSON parse error... everything falls back to the original text. A broken plugin behaves as if it weren't installed.
- **Model groups externalized**: the optimizer and decider are Magpie groups (e.g. `group/prompt-optimize`); the plugin only references group names, so swapping models never touches plugin code.
- **Recursion guard**: the optimizer's own requests re-entering the gateway are detected and skipped.

## Install

Prerequisites: a running Magpie gateway (default `http://127.0.0.1:3425`) with two model groups configured:

```bash
# optimizer group: cheap, fast, decent CN/EN rewriting, ordered failover
magpie group add group/prompt-optimize \
  opencode-zen-free/deepseek-v4.1-flash-free \
  auto/gemini-3.8-flash \
  --routing order

# decider group (optional; leave unconfigured for rules-only mode)
magpie group add group/route-decider ...
```

Then:

```bash
git clone https://github.com/Luck9Star/prompt-optimizer-magpie.git
cd prompt-optimizer-magpie
magpie plugin add . --local
```

## Configuration

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

| Option | Default | Description |
|---|---|---|
| `enabled` | `true` | master switch |
| `optimizerGroup` | `group/prompt-optimize` | model group for optimize calls |
| `deciderGroup` | `""` | decision model group; empty = rules-only mode |
| `template` | `professional` | `professional` / `basic` / `planning` (see `templates/`) |
| `minChars` / `maxChars` | `10` / `2000` | length window for the first user message; outside → pass through |
| `optimizeTimeoutMs` | `15000` | optimizer call timeout |
| `deciderTimeoutMs` | `2000` | decider call timeout |
| `skipPrefix` | `"!!"` | messages starting with this prefix skip optimization |

## Template provenance & syncing

The four files under `templates/` are byte-for-byte copies of the upstream `packages/core/src/services/template/default-templates/user-optimize/` directory, each carrying a header comment with source path and commit hash (currently: develop `62b49a1f`, 2026-11-18). To pick up upstream changes, re-copy and refresh the header; not syncing is also a valid choice (deliberate pinning).

## License

[AGPL-3.0-only](./LICENSE). This repo vendors template text from an AGPL project, making it a derivative work, so the whole repo ships under AGPL-3.0-only — including any fork or modified version you distribute.
