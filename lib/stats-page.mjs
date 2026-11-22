// Server-rendered stats page (brief .omp-stats-page-brief.md). Node stdlib
// only; zero fetch/XHR; zero inline script — the sandbox CSP forbids it, and
// the opaque-origin iframe makes every fetch fail anyway. All interaction is
// links + native GET forms; state lives in the query string.
//
// i18n: both languages are rendered server-side as
//   <span data-lang="zh">…</span><span data-lang="en">…</span>
// and shown/hidden by [data-lang] CSS keyed on <html data-lang>. page/lang.js
// (same-dir static script, allowed by the sandbox CSP) copies the bridge
// theme lang (or navigator.language) onto <html data-lang>; ?lang=zh|en
// renders the attribute server-side so the page works with JS off.
//
// Theme: every color goes through --magpie-* (injected by bridge.js); the
// fallback after the comma only covers direct non-proxied 127.0.0.1 use.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validEvent } from "./stats.mjs";
import { CONFIG_FIELDS } from "./config-store.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const PAGE_SIZE = 50;

// ── i18n ──────────────────────────────────────────────────────────────────
export const T = {
  title: ["提示词优化 · 统计", "prompt-optimizer · stats"],
  kpiTotal: ["明细事件总数", "detail events"],
  kpiDecide: ["decide {p}", "decide {p}"],
  kpiOptimize: ["optimize {p}", "optimize {p}"],
  kpiScopeDecide: ["判定耗时 {p}：仅真实调用模型的事件（n={n}）", "decide latency {p}: real model calls only (n={n})"],
  kpiScopeOptimize: ["改写耗时 {p}：仅真实调用模型的事件（n={n}）", "optimize latency {p}: real model calls only (n={n})"],
  kpiPctSwitch: ["耗时视图", "latency view"],
  byGroup: ["按分组的请求汇总", "Eligible requests by group"],
  coverage: ["首轮会话覆盖", "First-turn session coverage"],
  actions: ["动作分布", "Actions"],
  reasonTop: (n) => [`reason Top ${n}`, `reason Top ${n}`],
  events: ["事件明细", "Detailed events"],
  filter: ["筛选", "Filters"],
  fAction: ["动作", "action"],
  fReason: ["reason", "reason"],
  fDay: ["日期", "day file"],
  fAgent: ["agent", "agent"],
  apply: ["应用", "Apply"],
  reset: ["清空", "Reset"],
  colTs: ["时间", "ts"],
  colAgent: ["agent", "agent"],
  colAction: ["动作", "action"],
  colReason: ["reason", "reason"],
  skippedAsIs: ["原样跳过", "skipped as-is"],
  colInOut: ["输入/输出字符", "in/out"],
  colView: ["详情", "view"],
  prev: ["上一页", "prev"],
  next: ["下一页", "next"],
  pageOf: (n, m) => [`第 ${n} / ${m} 页`, `page ${n} / ${m}`],
  noEvents: ["没有匹配的事件。调整筛选或日期。", "No events match. Adjust the filters or day file."],
  noData: ["暂无数据", "No data yet"],
  emptyWhy: [
    "汇总表为空是预期行为：灰度与预算覆盖默认关闭、实验未开启时不产生 summary 事件。开启方式：plugins.json 中设置 optimizerMode / experiments。",
    "Empty summary tables are expected: rollout/budget coverage and experiments are off by default and emit no summary events. Enable via optimizerMode / experiments in plugins.json.",
  ],
  detail: ["事件详情", "Event detail"],
  back: ["← 返回列表", "← back to list"],
  orig: ["原文（截断审计）", "Original (clipped audit)"],
  rewritten: ["改写结果（截断审计）", "Rewritten (clipped audit)"],
  meta: ["元数据", "Metadata"],
  notFound: ["事件不存在（可能已被 prune 或日期/序号有误）。", "Event not found (pruned, or day/sequence wrong)."],
  colDur: ["耗时", "ms"],
  legendTitle: ["reason 图例（按语义分组）", "reason legend (by semantics)"],
  legendGreen: ["成功类", "success"],
  legendAmber: ["预期跳过类", "expected skips"],
  legendRed: ["失败类", "failures"],
  legendNote: ["choice:* 前缀与 *-fail 后缀按前缀/后缀规则归组；未列出的 reason 归为灰组。", "choice:* prefixes and *-fail suffixes group by prefix/suffix rules; unlisted reasons fall into the gray group."],
  r_optimized: ["改写已应用", "rewrite applied"],
  "r_merged-optimized": ["合并模式改写已应用", "merged-mode rewrite applied"],
  ta_pass: ["原样放行，未调用模型", "passed through as-is, no model call"],
  ta_optimize: ["已调用模型改写提示词", "model called to rewrite the prompt"],
  ta_decide: ["仅执行是否优化的判定", "decision only: whether to optimize"],
  ta_summary: ["会话汇总事件", "session summary event"],
  a_optimize: ["改写", "optimize"],
  a_decide: ["判定", "decide"],
  a_pass: ["放行", "pass"],
  a_summary: ["汇总", "summary"],
  navStats: ["统计", "Stats"],
  cfgNav: ["配置", "Config"],
  cfgTitle: ["插件配置", "Plugin Config"],
  cfgSaved: ["已保存。需重载插件（magpie plugin off/on）后生效", "Saved. Reload the plugin (magpie plugin off/on) to take effect"],
  cfgDefault: ["默认", "default"],
  cfgEnabled: ["启用插件", "Enable plugin"],
  cfgDryRun: ["演练模式（只记录不替换）", "dry run (log only, no rewrite)"],
  cfgOptimizerMode: ["优化模式", "optimizer mode"],
  cfgMinChars: ["最小字符数", "min chars"],
  cfgMaxChars: ["最大字符数", "max chars"],
  cfgLogSkips: ["记录跳过事件", "log skipped events"],
  cfgLogOptimizes: ["记录改写事件", "log optimize events"],
  cfgDeciderGroup: ["判定模型组", "decider model group"],
  cfgOptimizeGroup: ["改写模型组", "optimizer model group"],
  cfgDeciderTimeoutMs: ["判定超时（毫秒）", "decider timeout (ms)"],
  cfgOptimizeTimeoutMs: ["改写超时（毫秒）", "optimizer timeout (ms)"],
  hintEnabled: ["总开关，关闭后 hook 直接放行，不调用任何模型", "master switch; when off the hook passes every request through, no model calls"],
  hintDryRun: ["只记录改写结果到统计，不替换实际请求", "rewrite results are logged to stats only; requests are never replaced"],
  hintOptimizerMode: ["auto = 判定+改写按各自模型组两段式；merged = 单次合并调用（决策组可空）", "auto = decide+rewrite as two calls per their groups; merged = single combined call (decider group may be empty)"],
  hintMinChars: ["短于该字符数的提示词不优化（默认 6）", "prompts shorter than this are skipped (default 6)"],
  hintMaxChars: ["超过该字符数的提示词不优化（默认 12000）", "prompts longer than this are skipped (default 12000)"],
  hintLogSkips: ["跳过事件是否记入统计文件", "whether skipped events are written to stats"],
  hintLogOptimizes: ["改写事件是否记入统计文件", "whether optimize events are written to stats"],
  hintDeciderGroup: ["判定「新任务还是追问」所用模型组", "model group used to decide new-task vs follow-up"],
  hintOptimizeGroup: ["执行提示词改写所用模型组", "model group used to rewrite prompts"],
  hintDeciderTimeoutMs: ["判定调用超时毫秒，超时按失败处理（默认 1500）", "decider call timeout in ms; timeout counts as failure (default 1500)"],
  hintOptimizeTimeoutMs: ["改写调用超时毫秒，超时放行原文（默认 15000）", "optimizer call timeout in ms; timeout passes the original through (default 15000)"],
  cfgSubmit: ["保存", "Save"],
  cfgErrInt: ["必须是整数", "must be an integer"],
  cfgErrRange: ["超出允许范围", "out of allowed range"],
  cfgErrEnum: ["不是合法选项", "not a valid choice"],
  cfgErrEmpty: ["不能为空", "must not be empty"],
  cfgErrLen: ["过长", "too long"],
  cfgErrNoFile: ["plugins.json 不存在", "plugins.json not found"],
  cfgErrBadFile: ["plugins.json 解析失败", "plugins.json failed to parse"],
  cfgErrNoSpec: ["未找到本插件的配置项（spec 不匹配）", "plugin entry (spec) not found"],
  cfgErrVerify: ["写前回验失败，未写入", "pre-rename verification failed, nothing written"],
  cfgErrWrite: ["写入失败", "write failed"],
  cfg404Title: ["配置页未开放", "Config page disabled"],
  cfg404Body: ["在 plugins.json 中设置 configPage: true 后可用（重载插件后生效）。", "Set configPage: true in plugins.json to enable (effective after plugin reload)."],
  "r_not-turn": ["非回合首条", "not first turn"],
  "r_no-tools": ["请求无工具集", "request has no tools"],
  "r_short-text": ["输入过短放行", "input too short, passed"],
  "r_too-long": ["超长放行", "too long, passed"],
  "r_bypass-agent": ["agent 名命中旁路", "agent bypassed"],
  "r_bypass-model": ["模型名命中旁路", "model bypassed"],
  "r_bypass-prefix": ["前缀命中旁路", "prefix bypassed"],
  r_subagent: ["子代理请求放行", "subagent request passed"],
  "r_self-loop": ["自身回路放行", "self loop passed"],
  r_disabled: ["插件未启用", "plugin disabled"],
  r_origin: ["来源不在白名单", "origin not allowed"],
  r_followup: ["decider 判定为追问", "decider judged follow-up"],
  "r_tpl-skip": ["模板档位跳过", "template tier skipped"],
  "r_experiment-control": ["实验对照组放行", "experiment control passed"],
  "r_no-decider-followup": ["无 decider 长线程保守放行", "no decider, long thread passed"],
  "r_merged-passthrough": ["合并模式判定放行", "merged mode passed through"],
  "r_merged-circuit-open": ["合并模式熔断中走纯规则", "merged circuit open, rules path"],
  "r_budget-exhausted": ["预算耗尽放行", "budget exhausted, passed"],
  "r_low-confidence": ["decider 置信度低放行", "low decider confidence, passed"],
  "r_unknown-choice": ["decider 未知判定保守放行", "unknown decider choice, passed"],
  "r_optimize-empty": ["优化返回空已回退", "optimize returned empty, reverted"],
  "r_output-guard": ["改写超护栏已回退", "output guard tripped, reverted"],
  "r_no-span": ["改写不含原文已回退", "rewrite lost the original span, reverted"],
  r_error: ["处理异常已放行", "error, passed through"],
  "r_decider-fail": ["decider 调用失败走纯规则", "decider call failed, rules fallback"],
  "r_decider-fail-rule": ["decider 调用失败走纯规则", "decider failed, rules-only fallback"],
  "r_merged-fail": ["合并模式输出无效已放行", "merged output invalid, passed"],
  noOrigWhy: [
    "此路径不记录原文：pass / decide 路径只记事件元数据，仅改写路径记录原文与改写（由 logRewrites 控制）。当前展示的是审计截断（前 600 字符）。",
    "This path does not record prompt text: pass / decide paths log metadata only; the rewrite path records orig/rewritten (controlled by logRewrites). What is shown is the audit clip (first 600 chars).",
  ],
  all: ["全部", "all"],
};
// 双语文案 helper：zh 恒为 [0]，en 恒为 [1]。
const zh = (k, ...a) => (typeof T[k] === "function" ? T[k](...a)[0] : T[k][0]);
const en = (k, ...a) => (typeof T[k] === "function" ? T[k](...a)[1] : T[k][1]);
// 一次性生成 zh+en 双份 span；labeled fallback 用于 title/option 等属性位。
const bi = (k, ...a) => `<span data-lang="zh">${esc(zh(k, ...a))}</span><span data-lang="en">${esc(en(k, ...a))}</span>`;

const VARS = "bg,card,fg,fg-2,muted,faint,line,accent,accent-fg,green,red,amber".split(",");
const css = () => `
  :root { color-scheme: light dark;
    --space-1: .25rem; --space-2: .5rem; --space-3: 1rem; --space-4: 1.5rem; }
  html[data-lang="zh"] [data-lang="en"], html[data-lang="en"] [data-lang="zh"] { display: none; }
  body { font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0;
         padding: var(--space-4) var(--space-3) 3rem; max-width: 64rem; margin-inline: auto;
         background: var(--magpie-bg, Canvas); color: var(--magpie-fg, CanvasText); }
  h1 { font-size: 1.15rem; margin: 0 0 var(--space-1); }
  h2 { font-size: .95rem; margin: var(--space-4) 0 var(--space-2); color: var(--magpie-fg-2, GrayText); font-weight: 600; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: var(--space-3); margin-top: var(--space-3); }
  .kpi { background: var(--magpie-card, Canvas); border: 1px solid var(--magpie-line, ButtonBorder);
         border-radius: 8px; padding: var(--space-2) var(--space-3); min-width: 9rem; }
  .kpi b { font-size: 1.35rem; display: block; font-variant-numeric: tabular-nums; }
  /* KPI semantic colors on the value text only; cards stay neutral. */
  .kpi b.v-amber { color: var(--magpie-amber, var(--magpie-warn, #b45309)); }
  .kpi b.v-green { color: var(--magpie-green, var(--magpie-success, #15803d)); }
  .kpi b.v-muted { color: var(--magpie-muted, GrayText); }
  .kpi span { color: var(--magpie-muted, GrayText); font-size: 11px; }
  /* A. semantic nav, underline tabs via pseudo-element — no size change on state,
     no box-shadow/background (they vanish in forced-colors mode). */
  nav.tabs { border-block-end: 1px solid var(--magpie-line, ButtonBorder); margin-bottom: var(--space-3); }
  nav.tabs ul { display: flex; gap: var(--space-4); list-style: none; margin: 0; padding: 0; }
  nav.tabs a { display: inline-block; padding: var(--space-2) var(--space-1); color: var(--magpie-fg-2, GrayText);
               text-decoration: none; border-block-end: 2px solid transparent; }
  nav.tabs a:hover { color: var(--magpie-fg, CanvasText); }
  nav.tabs a[aria-current="page"] { color: var(--magpie-fg, CanvasText); font-weight: 600;
               border-block-end-color: var(--magpie-accent, AccentColor); }
  /* percentile switcher: same underline-tab affordance as nav.tabs, compact */
  nav.pct-switch { display: flex; gap: var(--space-2); }
  nav.pct-switch a { padding: var(--space-1) var(--space-2); color: var(--magpie-fg-2, GrayText);
               text-decoration: none; border-block-end: 2px solid transparent; font-variant-numeric: tabular-nums; }
  nav.pct-switch a:hover { color: var(--magpie-fg, CanvasText); }
  nav.pct-switch a[aria-current="true"] { color: var(--magpie-fg, CanvasText); font-weight: 600;
               border-block-end-color: var(--magpie-accent, AccentColor); }
  /* B. responsive tables: wrapper region + sticky head + stacked cards under 40em. */
  .table-wrapper { container-type: inline-size; overflow-x: auto; }
  table { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 12px; margin-top: var(--space-1); font-variant-numeric: tabular-nums; }
  td, th { border: 1px solid var(--magpie-line, ButtonBorder); padding: .3rem var(--space-2); text-align: left; vertical-align: top; }
  th { color: var(--magpie-fg-2, GrayText); position: sticky; inset-block-start: 0; background: var(--magpie-bg-2, var(--magpie-bg, Canvas)); }
  @container (max-width: 40em) {
    .table-wrapper table { border: 0; }
    .table-wrapper thead { display: none; }
    .table-wrapper tr { display: block; border: 1px solid var(--magpie-line, ButtonBorder); border-radius: 8px; margin-bottom: var(--space-2); }
    .table-wrapper td { display: block; border: 0; border-block-end: 1px solid var(--magpie-line, ButtonBorder); }
    .table-wrapper td:last-child { border-block-end: 0; }
    .table-wrapper td::before { content: var(--label, ""); display: block; color: var(--magpie-muted, GrayText); font-size: 10px; }
  }
  .chips { display: flex; flex-wrap: wrap; gap: var(--space-1); }
  .chip { background: var(--magpie-card, Canvas); border: 1px solid var(--magpie-line, ButtonBorder);
          border-radius: 4px; padding: .1rem var(--space-2); font-variant-numeric: tabular-nums; }
  .empty { color: var(--magpie-muted, GrayText); font-size: 12px; margin-top: var(--space-1); max-width: 46rem; }
  form.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: end; margin-top: var(--space-2); }
  form.filters label { display: grid; gap: .15rem; font-size: 11px; color: var(--magpie-muted, GrayText); }
  select, button { font: inherit; background: var(--magpie-card, Canvas); color: var(--magpie-fg, CanvasText);
                   border: 1px solid var(--magpie-line, ButtonBorder); border-radius: 4px; padding: .25rem var(--space-2); }
  button { cursor: pointer; }
  .pager { display: flex; gap: var(--space-3); align-items: center; margin: var(--space-3) 0; font-size: 12px; }
  .pager a { color: var(--magpie-accent, LinkText); }
  td a { color: var(--magpie-accent, LinkText); }
  .detail-cols { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); margin-top: var(--space-2); }
  .detail-cols h3 { margin: 0 0 var(--space-1); font-size: .85rem; color: var(--magpie-fg-2, GrayText); }
  .detail-cols pre { margin: 0; padding: var(--space-2); overflow: auto; max-height: 24rem; white-space: pre-wrap;
                     word-break: break-word; background: var(--magpie-card, Canvas); font-family: ui-monospace, monospace;
                     border: 1px solid var(--magpie-line, ButtonBorder); border-radius: 8px; font-size: 12px; }
  @media (max-width: 60rem) { .detail-cols { grid-template-columns: 1fr; } }
  .warn { color: var(--magpie-amber, CanvasText); }
  .tag { display: inline-block; border-radius: 4px; padding: 0 .4rem; font-size: 11px;
         border: 1px solid var(--magpie-line, ButtonBorder); }
  .tag-green { color: var(--magpie-green, CanvasText); border-color: var(--magpie-green, CanvasText); }
  .tag-amber { color: var(--magpie-amber, CanvasText); border-color: var(--magpie-amber, CanvasText); }
  .tag-red { color: var(--magpie-red, CanvasText); border-color: var(--magpie-red, CanvasText); }
  .tag-muted { color: var(--magpie-muted, GrayText); }
  .tag-accent { color: var(--magpie-accent, LinkText); border-color: var(--magpie-accent, LinkText); }
  .legend { margin-top: var(--space-3); }
  .legend summary { cursor: pointer; color: var(--magpie-fg-2, GrayText); font-size: 12px; }
  .legend dl { display: grid; grid-template-columns: max-content 1fr; gap: var(--space-1) var(--space-3); margin: var(--space-2) 0 0; font-size: 12px; }
  .legend dt { font-weight: 600; }
  .legend h3 { margin: var(--space-2) 0 var(--space-1); font-size: .8rem; color: var(--magpie-fg-2, GrayText); }
  form[method="POST"] label { display: flex; gap: var(--space-2); align-items: center; margin: .35rem 0; }
  form[method="POST"] .k { min-width: 11rem; font-family: ui-monospace, monospace; font-size: 12px; }
  form[method="POST"] input[type="text"], form[method="POST"] select { background: var(--magpie-bg-2, Canvas); color: var(--magpie-fg, CanvasText); border: 1px solid var(--magpie-border, CanvasText); border-radius: 4px; padding: .2rem .4rem; }
  .cfg-saved { color: var(--magpie-success, var(--magpie-green, #16a34a)); border: 1px solid var(--magpie-success, var(--magpie-green, #16a34a)); border-radius: 4px; padding: var(--space-1) var(--space-2); max-width: 46rem; }
  .skipped { color: var(--magpie-muted, GrayText); }
  .cfg-err input[type="text"], .cfg-err select { border-color: var(--magpie-danger, var(--magpie-red, #dc2626)); }
  .cfg-errmsg { color: var(--magpie-danger, var(--magpie-red, #dc2626)); font-style: normal; font-size: 12px; }
  .field-hint { display: block; font-size: 12px; color: var(--magpie-fg-2, var(--magpie-muted, GrayText)); margin: var(--space-1) 0 0; }
  /* C. focus ring on every focusable element. */
  a:focus-visible, button:focus-visible, select:focus-visible, input:focus-visible,
  summary:focus-visible, [tabindex]:focus-visible {
    outline: 2px solid var(--magpie-accent, AccentColor); outline-offset: 2px; }
`;

// ── day files & detail ids ─────────────────────────────────────────────────
// Available day files (YYYY-MM-DD, newest first) for the day filter.
export function listDays(statsDir) {
  let names;
  try {
    names = readdirSync(statsDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(n));
  } catch {
    return [];
  }
  return names.map((n) => n.slice(0, 10)).sort().reverse();
}
// Events from one day file, each tagged with a stable id `YYYY-MM-DD:seq`
// (seq = position among parsed lines of that day's file). readEvents() drops
// corrupted lines the same way, so ids match the strict-parsed view. Files
// are append-only and prune only removes whole old files, so a detail URL
// never dangles mid-day.
export function eventsByDay(statsDir) {
  const days = listDays(statsDir).reverse(); // oldest first, like readEvents
  const out = [];
  for (const day of days) {
    let raw;
    try {
      raw = readFileSync(join(statsDir, day + ".ndjson"), "utf8");
    } catch {
      continue;
    }
    let i = 0;
    for (const line of raw.split("\n")) {
      if (!line) continue;
      i++;
      try {
        const ev = JSON.parse(line);
        if (validEvent(ev)) out.push({ ...ev, _id: `${day}:${i}` });
      } catch { /* corrupted line → skip */ }
    }
  }
  // days were iterated oldest-first, so `out` already is
  return out;
}

// parse `YYYY-MM-DD:N` → { day, seq }; null when malformed.
export function parseDetailId(id) {
  const m = /^(\d{4}-\d{2}-\d{2}):(\d+)$/.exec(String(id || ""));
  if (!m) return null;
  return { day: m[1], seq: Number(m[2]) };
}

// 6-hex display id: first 6 chars of sha256(day:seq). Stable across renders,
// visually distinct from timestamps; ?detail= keeps the raw day:seq.
export function shortId(id) {
  return createHash("sha256").update(String(id)).digest("hex").slice(0, 6);
}

// ── colored tags (brief 需求2/3) ───────────────────────────────────────────
// Pure mappings — no logic in the template strings. Colors ride the
// --magpie-* token set; .tag carries the shared chip shape.
export const ACTION_TAG = { optimize: "green", decide: "amber", pass: "muted", summary: "accent" };
export const REASON_GROUPS = {
  green: ["optimized", "merged-optimized", "cache-hit", "dry-run"],
  amber: ["not-turn", "no-tools", "short-text", "too-long", "bypass-agent", "bypass-model", "bypass-prefix", "subagent", "self-loop", "disabled", "origin", "followup", "tpl-skip", "experiment-control", "no-decider-followup", "merged-passthrough", "merged-circuit-open", "budget-exhausted", "low-confidence", "unknown-choice"],
  red: ["optimize-empty", "output-guard", "no-span", "error"],
};
export function reasonGroup(reason) {
  if (REASON_GROUPS.green.includes(reason)) return "green";
  if (REASON_GROUPS.amber.includes(reason) || String(reason).startsWith("choice:")) return "amber";
  if (String(reason).endsWith("-fail") || REASON_GROUPS.red.includes(reason)) return "red";
  return "muted";
}
// `label` overrides the raw text (i18n); the CSS class still derives from the
// raw group value, so colors never depend on translation (i18n brief 硬约束).
// `title` is a plain single-language string (attribute context — never bi());
// esc() handles the attribute escaping.
const tag = (text, group, label, title) =>
  `<span class="tag tag-${group}"${title ? ` title="${esc(title)}"` : ""}>${label ?? esc(text)}</span>`;

// zh display labels: actions map to a_* T entries, reasons reuse the legend's
// r_* entries; both fall back to the raw value when no entry exists.
const biKey = (prefix, v) => (v && T[`${prefix}${v}`] ? `${prefix}${v}` : null);
const actionLabel = (a) => { const k = biKey("a_", a); return k ? bi(k) : esc(a); };
const reasonLabel = (r) => { const k = biKey("r_", r); return k ? bi(k) : esc(r); };
// Tooltip text (attribute context, single language per render lang):
// actions use ta_* notes, reasons reuse the full r_* legend entry;
// fallback = the raw value.
const actionTitle = (a, lang) => { const k = biKey("ta_", a); return k ? T[k][lang === "en" ? 1 : 0] : a; };
const reasonTitle = (r, lang) => { const k = biKey("r_", r); return k ? T[k][lang === "en" ? 1 : 0] : r; };

// A. humanized duration: <1s raw ms; ≥1s one decimal (floored), trailing zero trimmed.
export const fmtDur = (ms) => {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return "–";
  if (ms < 1000) return `${ms}ms`;
  return `${Math.floor(ms / 100) / 10}s`.replace(/\.0s$/, "s");
};

// ── filters / pagination ───────────────────────────────────────────────────
export function filterEvents(events, q) {
  return events.filter((e) =>
    (!q.action || e.action === q.action)
    && (!q.reason || e.reason === q.reason)
    && (!q.day || String(e._id).startsWith(q.day + ":"))
    && (!q.agent || e.agent === q.agent));
}

export function paginate(events, page) {
  const pages = Math.max(1, Math.ceil(events.length / PAGE_SIZE));
  const p = Math.min(Math.max(1, Number.isFinite(page) ? page : 1), pages);
  return { rows: events.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE), page: p, pages };
}

// Keep current filters across pager links / detail back-links.
const qs = (q, over = {}) => {
  const sp = new URLSearchParams();
  for (const k of ["action", "reason", "day", "agent", "lang", "pct"]) if (q[k]) sp.set(k, q[k]);
  for (const [k, v] of Object.entries(over)) if (v != null && v !== "") sp.set(k, String(v)); else sp.delete(k);
  const s = sp.toString();
  // href="" keeps the current query (RFC 3986) and re-loads the detail page; "?" clears it.
  return s ? "?" + s : "?";
};

// Distinct values for the filter dropdowns (from the full detail set, not the
// filtered one — otherwise picking a filter hides the option to change it).
const distinct = (events, key) => Array.from(new Set(events.map((e) => e[key]).filter(Boolean))).sort();

// `label` is either pre-rendered dual-lang spans from bi() (already escaped)
// or a raw plain string fallback — escape only when it contains no markup.
const option = (value, label, selected) =>
  `<option value="${esc(value)}"${selected ? " selected" : ""}>${label.includes("<") ? label : esc(label)}</option>`;

// ── pages ──────────────────────────────────────────────────────────────────
function head(lang) {
  return `<!doctype html>
<html lang="${lang === "en" ? "en" : "zh"}" data-lang="${lang === "en" ? "en" : "zh"}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(lang === "en" ? en("title") : zh("title"))}</title>
<style>${css()}</style>
<script src="../bridge.js"></script>
<script src="./lang.js" defer></script>
</head><body>`;
}


// Native <details> legend right under the event table (brief 需求4): one
// definition list per semantic group, each reason via the T bilingual table.
const LEGEND_GROUPS = [
  ["legendGreen", "green"],
  ["legendAmber", "amber"],
  ["legendRed", "red"],
];
function reasonLegend() {
  const section = (group) => Object.keys(T).filter((k) => k.startsWith("r_") && reasonGroup(k.slice(2)) === group).sort()
    .map((k) => `<dt>${tag(k.slice(2), group)}</dt><dd>${bi(k)}</dd>`).join("");
  return `<details class="legend"><summary>${bi("legendTitle")}</summary>
${LEGEND_GROUPS.map(([titleKey, group]) => `<h3>${bi(titleKey)}</h3><dl>${section(group)}</dl>`).join("\n")}
<p class="empty">${bi("legendNote")}</p></details>`;
}

// Main list page: KPI cards, both summary tables (with empty-state notes),
// filter form, paginated event table newest-first (page 1 = most recent).
// `events` = ALL detail events (unfiltered); `stats` = aggregate() over the same set.
export function renderPage(stats, events, q = {}) {
  const lang = q.lang === "en" ? "en" : "zh";
  const details = [...events.filter((e) => e.action !== "summary")].reverse();
  const filtered = filterEvents(details, q);
  const { rows, page, pages } = paginate(filtered, Number.parseInt(q.page ?? "1", 10));

  // latency card helper: value = current percentile of that action's durations.
  // plain() and label() substitute {p} (percentile) and {n} (bucket sample count).
  // title attr = plain single-language text; visible label = bilingual spans.
  const PCTS = ["p50", "p95", "p99", "max"];
  const pct = PCTS.includes(q.pct) ? q.pct : "p95"; // invalid → default p95
  const plain = (key, a) => T[key][lang === "en" ? 1 : 0].replaceAll("{p}", pct).replaceAll("{n}", stats.actionDuration?.[a]?.count ?? 0);
  const label = (key) => bi(key).replaceAll("{p}", pct);
  const ad = (a) => stats.actionDuration?.[a]?.[pct];
  const kpi = (cls, scopeKey, labelKey, a) =>
    `<div class="kpi"><b class="${cls}" title="${esc(plain(scopeKey, a))}">${fmtDur(ad(a))}</b><span>${label(labelKey)}</span></div>`;
  const pctSwitch = `<nav class="pct-switch">${PCTS.map((p) =>
    `<a href="${qs(q, { pct: p, page: null, detail: null })}"${p === pct ? ' aria-current="true"' : ""}>${p}</a>`).join("")}</nav>`;

  const kpis = `
  ${pctSwitch}
  <div class="kpis">
    <div class="kpi"><b>${stats.total}</b><span>${bi("kpiTotal")}</span></div>
    ${kpi("v-amber", "kpiScopeDecide", "kpiDecide", "decide")}
    ${kpi("v-green", "kpiScopeOptimize", "kpiOptimize", "optimize")}
  </div>`;

  const emptyNote = `<p class="empty">${bi("emptyWhy")}</p>`;
  const groups = stats.requestGroups.map((g) => {
    const passReasons = Object.entries(g.passReasons).sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${esc(reason)} (${count})`).join(", ");
    return `<tr><td>${esc(g.experimentId || "—")}</td><td>${esc(g.version || "—")}</td>
      <td>${esc(g.group)}</td><td>${g.samples}${g.missingSessions ? ` (no session: ${g.missingSessions})` : ""}</td><td>${g.applied} (${(100 * g.applyRate).toFixed(1)}%)</td>
      <td>${g.modelCalls}</td><td>${fmtDur(g.p95Ms)}</td><td>${passReasons || "—"}</td></tr>`;
  }).join("");
  const coverage = stats.sessionCoverage.map((c) =>
    `<tr><td>${esc(c.experimentId)}</td><td>${esc(c.version)}</td><td>${c.bucketed} / ${c.total} (${(100 * c.rate).toFixed(1)}%)</td><td>${c.missingSessions}</td></tr>`
  ).join("");
  const actions = Object.entries(stats.actionCounts)
    .map(([a, n]) => `<span class="chip">${actionLabel(a)} <b>${n}</b></span>`).join("");
  const reasons = Object.entries(stats.reasonTop)
    .map(([r, n]) => `<tr><td>${reasonLabel(r)}</td><td>${n}</td></tr>`).join("");

  const sel = (v, cur) => v === cur ? " selected" : "";
  const filters = `
  <form class="filters" method="get">
    <label>${bi("fAction")}<select name="action">${option("", zh("all") + " / " + en("all"), !q.action)}${distinct(details, "action").map((a) => option(a, actionLabel(a), a === q.action)).join("")}</select></label>
    <label>${bi("fReason")}<select name="reason">${option("", zh("all") + " / " + en("all"), !q.reason)}${distinct(details, "reason").map((r) => option(r, reasonLabel(r), r === q.reason)).join("")}</select></label>
    <label>${bi("fDay")}<select name="day">${option("", zh("all") + " / " + en("all"), !q.day)}${distinct(details.map((e) => ({ day: String(e._id).slice(0, 10) })), "day").map((d) => option(d, d, d === q.day)).join("")}</select></label>
    <label>${bi("fAgent")}<select name="agent">${option("", zh("all") + " / " + en("all"), !q.agent)}${distinct(details, "agent").map((a) => option(a, a, a === q.agent)).join("")}</select></label>
    <button type="submit">${bi("apply")}</button>
    <button type="submit" formaction="${qs({})}">${bi("reset")}</button>
  </form>`;

  const rowsHtml = rows.length
    ? rows.map((e) => `<tr>
      <td><a href="${qs(q, { detail: e._id })}">${shortId(e._id)}</a></td>
      <td style="--label:var(--label-1)">${esc(new Date(e.ts).toISOString().replace("T", " ").slice(0, 19))}</td>
      <td style="--label:var(--label-2)">${esc(e.agent)}</td><td style="--label:var(--label-3)">${tag(e.action, ACTION_TAG[e.action] ?? "muted", actionLabel(e.action), actionTitle(e.action, lang))}</td><td style="--label:var(--label-4)">${tag(e.reason, reasonGroup(e.reason), reasonLabel(e.reason), reasonTitle(e.reason, lang))}</td>
      <td style="--label:var(--label-5)">${e.action === "pass" ? `<span class="skipped">${bi("skippedAsIs")}</span>` : `${e.inputChars ?? ""}/${e.outputChars ?? ""}`}</td><td style="--label:var(--label-6)">${fmtDur(e.durationMs)}</td></tr>`).join("")
    : `<tr><td colspan="7" class="empty">${bi("noEvents")}</td></tr>`;

  const pager = `
  <div class="pager">
    ${page > 1 ? `<a href="${qs(q, { page: page - 1 })}">‹ ${bi("prev")}</a>` : ""}
    <span>${bi("pageOf", page, pages)}</span>
    ${page < pages ? `<a href="${qs(q, { page: page + 1 })}">${bi("next")} ›</a>` : ""}
  </div>`;

  return `${head(lang)}
${navTabs("stats", lang)}
<h1 id="stats-title">${bi("title")}</h1>
${kpis}
<h2>${bi("byGroup")}</h2>
${groups ? `<div class="table-wrapper" tabindex="0" role="region" aria-labelledby="stats-title"><table><thead><tr><th>experiment</th><th>version</th><th>group</th><th>requests</th><th>applied</th><th>model calls</th><th>hook p95</th><th>pass reasons (count)</th></tr></thead><tbody>${groups}</tbody></table></div>` : emptyNote}
<h2>${bi("coverage")}</h2>
${coverage ? `<div class="table-wrapper" tabindex="0" role="region" aria-labelledby="stats-title"><table><thead><tr><th>experiment</th><th>version</th><th>bucketed / eligible</th><th>missing session</th></tr></thead><tbody>${coverage}</tbody></table></div>` : emptyNote}
<h2>${bi("actions")}</h2><div class="chips">${actions || "–"}</div>
<h2>${bi("reasonTop", Object.keys(stats.reasonTop).length)}</h2>
${reasons ? `<div class="table-wrapper" tabindex="0" role="region" aria-labelledby="stats-title"><table><tr><th>reason</th><th>count</th></tr>${reasons}</table></div>` : `<p class="empty">${bi("noData")}</p>`}
<h2 id="events-title">${bi("events")}${filtered.length !== details.length ? ` (${filtered.length}/${details.length})` : ` (${details.length})`}</h2>
${filters}
${pager}
<div class="table-wrapper" tabindex="0" role="region" aria-labelledby="events-title"><table style="--label-1:${esc(zh("colTs"))};--label-2:${esc(zh("colAgent"))};--label-3:${esc(zh("colAction"))};--label-4:${esc(zh("colReason"))};--label-5:${esc(zh("colInOut"))};--label-6:${esc(zh("colDur"))}"><thead><tr><th>id</th><th>${bi("colTs")}</th><th>${bi("colAgent")}</th><th>${bi("colAction")}</th><th>${bi("colReason")}</th><th>${bi("colInOut")}</th><th>${bi("colDur")}</th></tr></thead>
<tbody>${rowsHtml}</tbody></table></div>
${pager}
${reasonLegend()}
</body></html>`;
}

// A. semantic page nav: <nav aria-label><ul><li><a>>, aria-current on the
// active page. Selected state = color + border-block-end pseudo underline —
// never box-shadow/background (invisible in forced-colors), never a
// padding/border-width change (layout shift).
const navTabs = (page, lang) => {
  const link = (href, key, cur) => `<li><a href="${href}"${cur ? ' aria-current="page"' : ""}>${bi(key)}</a></li>`;
  return `<nav class="tabs" aria-label="${esc(lang === "en" ? "Page" : "页面")}"><ul>${link("./", "navStats", page === "stats")}${link("./?page=config", "cfgNav", page === "config")}</ul></nav>`;
};

// ── config sub-page (brief .omp-config-brief.md) ────────────────────────────
// Pure SSR form: native method=POST action="?page=config", zero JS.
// `current` = options snapshot from plugins.json; keys absent there show the
// field default annotated 「默认」. `errors` = {key: T-errorKey} from a failed
// POST; those fields render with the error style + bilingual message.
export function renderConfigPage({ current = {}, values = {}, errors = {}, saved = false, lang, groups = [] } = {}) {
  const L = lang === "en" ? "en" : "zh";
  const field = (f, groups) => {
    const inJson = Object.prototype.hasOwnProperty.call(current, f.key);
    const shown = Object.prototype.hasOwnProperty.call(values, f.key)
      ? values[f.key]
      : (inJson ? current[f.key] : f.def);
    const errKey = errors[f.key];
    const label = `<label class="${errKey ? "cfg-err" : ""}"><span class="k">${bi("cfg" + f.key[0].toUpperCase() + f.key.slice(1))}</span>`;
    let input;
    if (f.type === "bool") {
      input = `<input type="checkbox" name="${esc(f.key)}"${shown === true || shown === "on" ? " checked" : ""}>`;
    } else if (f.key === "deciderGroup" || f.key === "optimizeGroup") {
      // C. model-group select: options from providers.json (read-only), current value
      // always selectable even if absent from the list; submits full "group/<id>".
      const cur = shown === undefined || shown === null ? "" : String(shown);
      const opts = groups.map((id) => `<option value="group/${esc(id)}"${cur === `group/${id}` ? " selected" : ""}>group/${esc(id)}</option>`).join("");
      const curSelected = cur && !groups.some((id) => `group/${id}` === cur);
      input = `<select name="${esc(f.key)}"><option value=""></option>${curSelected ? `<option value="${esc(cur)}" selected>${esc(cur)}</option>` : ""}${opts}</select>`;
    } else if (f.type === "enum") {
      input = `<select name="${esc(f.key)}">${f.choices.map((c) => option(c, esc(c), shown === c)).join("")}</select>`;
    } else {
      const v = shown === undefined || shown === null ? "" : String(shown);
      input = `<input type="text" name="${esc(f.key)}" value="${esc(v)}">`;
    }
    const note = inJson ? "" : ` <small>${bi("cfgDefault")}</small>`;
    const err = errKey ? `<em class="cfg-errmsg">${bi(errKey)}</em>` : "";
    const hint = `<span class="field-hint">${bi("hint" + f.key[0].toUpperCase() + f.key.slice(1))}</span>`;
    return `${label}${input}${note}${err}${hint}</label>`;
  };
  return `${head(L)}
${navTabs("config", L)}
<h1>${bi("cfgTitle")}</h1>
${saved ? `<p class="cfg-saved">${bi("cfgSaved")}</p>` : ""}
<form method="POST" action="?page=config">
${CONFIG_FIELDS.map((f) => field(f, (f.key === "deciderGroup" || f.key === "optimizeGroup") ? groups : [])).join("\n")}
<button type="submit">${bi("cfgSubmit")}</button>
</form>
</body></html>`;
}

// Config disabled: 404-style notice page (configPage !== true).
export function renderConfigDisabled({ lang } = {}) {
  const L = lang === "en" ? "en" : "zh";
  return `${head(L)}
${navTabs("config", L)}
<h1>${bi("cfg404Title")}</h1>
<p class="empty">${bi("cfg404Body")}</p>
</body></html>`;
}

// Store-side error page (plugins.json missing/broken/spec absent/write fail).
export function renderConfigError({ errKey, lang } = {}) {
  const L = lang === "en" ? "en" : "zh";
  return `${head(L)}
${navTabs("config", L)}
<h1>${bi("cfgTitle")}</h1>
<p class="empty warn">${bi(errKey || "cfgErrWrite")}</p>
<p><a href="./?page=config">${bi("cfgNav")}</a></p>
</body></html>`;
}

// Detail page: metadata table + orig/rewritten side by side (pre-wrap).
export function renderDetail(event, q = {}) {
  const lang = q.lang === "en" ? "en" : "zh";
  if (!event) return `${head(lang)}
<h1>${bi("detail")}</h1>
<p class="empty warn">${bi("notFound")}</p>
<p><a href="${qs(q, { detail: null })}">${bi("back")}</a></p>
</body></html>`;
  const META_KEYS = ["ts", "agent", "action", "reason", "durationMs", "inputChars", "outputChars", "dryRun", "fromCache", "model", "group", "experimentId", "version", "bucket", "turn", "assignment", "finalAction", "mode", "fallbackFrom", "modelCalls"];
  const meta = META_KEYS.filter((k) => event[k] !== undefined)
    .map((k) => `<tr><th>${esc(k)}</th><td>${k === "action" ? tag(event[k], ACTION_TAG[event[k]] ?? "muted", actionLabel(event[k]), actionTitle(event[k], lang)) : k === "reason" ? tag(event[k], reasonGroup(event[k]), reasonLabel(event[k]), reasonTitle(event[k], lang)) : k === "durationMs" ? fmtDur(event[k]) : esc(k === "ts" ? new Date(event.ts).toISOString() : event[k])}</td></tr>`).join("");
  const extra = Object.keys(event).filter((k) => !META_KEYS.includes(k) && k !== "orig" && k !== "rewritten" && !k.startsWith("_"))
    .map((k) => `<tr><th>${esc(k)}</th><td>${esc(event[k])}</td></tr>`).join("");
  return `${head(lang)}
<h1>${bi("detail")} <small style="color:var(--magpie-muted)">${esc(event._id)}</small></h1>
<p><a href="${qs(q, { detail: null })}">${bi("back")}</a></p>
<h2>${bi("meta")}</h2>
<table><tbody>${meta}${extra}</tbody></table>
<div class="detail-cols">
  <div><h3>${bi("orig")}</h3><pre>${esc(event.orig) || "—"}</pre></div>
  <div><h3>${bi("rewritten")}</h3><pre>${esc(event.rewritten) || "—"}</pre></div>
</div>
${event.orig || event.rewritten ? "" : `<p class="empty">${bi("noOrigWhy")}</p>`}
</body></html>`;
}
