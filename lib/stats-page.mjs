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
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validEvent } from "./stats.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const PAGE_SIZE = 50;

// ── i18n ──────────────────────────────────────────────────────────────────
export const T = {
  title: ["提示词优化 · 统计", "prompt-optimizer · stats"],
  kpiTotal: ["明细事件总数", "detail events"],
  kpiP50: ["optimize p50", "optimize p50"],
  kpiP95: ["optimize p95", "optimize p95"],
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
  all: ["全部", "all"],
};
// 双语文案 helper：zh 恒为 [0]，en 恒为 [1]。
const zh = (k, ...a) => (typeof T[k] === "function" ? T[k](...a)[0] : T[k][0]);
const en = (k, ...a) => (typeof T[k] === "function" ? T[k](...a)[1] : T[k][1]);
// 一次性生成 zh+en 双份 span；labeled fallback 用于 title/option 等属性位。
const bi = (k, ...a) => `<span data-lang="zh">${esc(zh(k, ...a))}</span><span data-lang="en">${esc(en(k, ...a))}</span>`;

const VARS = "bg,card,fg,fg-2,muted,faint,line,accent,accent-fg,green,red,amber".split(",");
const css = () => `
  :root { color-scheme: light dark; }
  html[data-lang="zh"] [data-lang="en"], html[data-lang="en"] [data-lang="zh"] { display: none; }
  body { font: 13px/1.5 var(--magpie-font, ui-monospace, monospace); margin: 0; padding: 1.2rem 1.2rem 3rem;
         background: var(--magpie-bg, Canvas); color: var(--magpie-fg, CanvasText); }
  h1 { font-size: 1.15rem; margin: 0 0 .2rem; }
  h2 { font-size: .95rem; margin: 1.6rem 0 .5rem; color: var(--magpie-fg-2, GrayText); font-weight: 600; }
  .kpis { display: flex; flex-wrap: wrap; gap: 1rem; margin-top: .8rem; }
  .kpi { background: var(--magpie-card, Canvas); border: 1px solid var(--magpie-line, ButtonBorder);
         border-radius: 8px; padding: .6rem 1.1rem; min-width: 9rem; }
  .kpi b { font-size: 1.35rem; display: block; }
  .kpi span { color: var(--magpie-muted, GrayText); font-size: 11px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; margin-top: .4rem; }
  td, th { border: 1px solid var(--magpie-line, ButtonBorder); padding: .3rem .5rem; text-align: left; vertical-align: top; }
  th { color: var(--magpie-fg-2, GrayText); position: sticky; top: 0; background: var(--magpie-bg, Canvas); }
  .chips { display: flex; flex-wrap: wrap; gap: .4rem; }
  .chip { background: var(--magpie-card, Canvas); border: 1px solid var(--magpie-line, ButtonBorder);
          border-radius: 4px; padding: .1rem .5rem; }
  .empty { color: var(--magpie-muted, GrayText); font-size: 12px; margin-top: .4rem; max-width: 46rem; }
  form.filters { display: flex; flex-wrap: wrap; gap: .5rem; align-items: end; margin-top: .5rem; }
  form.filters label { display: grid; gap: .15rem; font-size: 11px; color: var(--magpie-muted, GrayText); }
  select, button { font: inherit; background: var(--magpie-card, Canvas); color: var(--magpie-fg, CanvasText);
                   border: 1px solid var(--magpie-line, ButtonBorder); border-radius: 4px; padding: .25rem .6rem; }
  button { cursor: pointer; }
  .pager { display: flex; gap: .8rem; align-items: center; margin: .8rem 0; font-size: 12px; }
  .pager a { color: var(--magpie-accent, LinkText); }
  td a { color: var(--magpie-accent, LinkText); }
  .detail-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: .6rem; }
  .detail-cols h3 { margin: 0 0 .3rem; font-size: .85rem; color: var(--magpie-fg-2, GrayText); }
  .detail-cols pre { margin: 0; padding: .6rem; overflow: auto; max-height: 24rem; white-space: pre-wrap;
                     word-break: break-word; background: var(--magpie-card, Canvas);
                     border: 1px solid var(--magpie-line, ButtonBorder); border-radius: 8px; font-size: 12px; }
  @media (max-width: 60rem) { .detail-cols { grid-template-columns: 1fr; } }
  .warn { color: var(--magpie-amber, CanvasText); }
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
  for (const k of ["action", "reason", "day", "agent", "lang"]) if (q[k]) sp.set(k, q[k]);
  for (const [k, v] of Object.entries(over)) if (v != null && v !== "") sp.set(k, String(v)); else sp.delete(k);
  const s = sp.toString();
  return s ? "?" + s : "";
};

// Distinct values for the filter dropdowns (from the full detail set, not the
// filtered one — otherwise picking a filter hides the option to change it).
const distinct = (events, key) => Array.from(new Set(events.map((e) => e[key]).filter(Boolean))).sort();

const option = (value, label, selected) =>
  `<option value="${esc(value)}"${selected ? " selected" : ""}>${esc(label)}</option>`;

// ── pages ──────────────────────────────────────────────────────────────────
function head(lang) {
  return `<!doctype html>
<html lang="${lang === "en" ? "en" : "zh"}" data-lang="${lang === "en" ? "en" : "zh"}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(lang === "en" ? en("title") : zh("title"))}</title>
<style>${css()}</style>
<script src="./lang.js" defer></script>
</head><body>`;
}

// Main list page: KPI cards, both summary tables (with empty-state notes),
// filter form, paginated event table. `events` = ALL detail events (unfiltered,
// newest last); `stats` = aggregate() over the same set.
export function renderPage(stats, events, q = {}) {
  const lang = q.lang === "en" ? "en" : "zh";
  const details = events.filter((e) => e.action !== "summary");
  const filtered = filterEvents(details, q);
  const { rows, page, pages } = paginate(filtered, Number.parseInt(q.page ?? "1", 10));
  const newest = [...details].reverse(); // recent first for display

  const kpis = `
  <div class="kpis">
    <div class="kpi"><b>${stats.total}</b><span>${bi("kpiTotal")}</span></div>
    <div class="kpi"><b>${stats.optimizeDuration.p50 ?? "–"} ms</b><span>${bi("kpiP50")}</span></div>
    <div class="kpi"><b>${stats.optimizeDuration.p95 ?? "–"} ms</b><span>${bi("kpiP95")}</span></div>
  </div>`;

  const emptyNote = `<p class="empty">${bi("emptyWhy")}</p>`;
  const groups = stats.requestGroups.map((g) => {
    const passReasons = Object.entries(g.passReasons).sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${esc(reason)} (${count})`).join(", ");
    return `<tr><td>${esc(g.experimentId || "—")}</td><td>${esc(g.version || "—")}</td>
      <td>${esc(g.group)}</td><td>${g.samples}${g.missingSessions ? ` (no session: ${g.missingSessions})` : ""}</td><td>${g.applied} (${(100 * g.applyRate).toFixed(1)}%)</td>
      <td>${g.modelCalls}</td><td>${g.p95Ms} ms</td><td>${passReasons || "—"}</td></tr>`;
  }).join("");
  const coverage = stats.sessionCoverage.map((c) =>
    `<tr><td>${esc(c.experimentId)}</td><td>${esc(c.version)}</td><td>${c.bucketed} / ${c.total} (${(100 * c.rate).toFixed(1)}%)</td><td>${c.missingSessions}</td></tr>`
  ).join("");
  const actions = Object.entries(stats.actionCounts)
    .map(([a, n]) => `<span class="chip">${esc(a)} <b>${n}</b></span>`).join("");
  const reasons = Object.entries(stats.reasonTop)
    .map(([r, n]) => `<tr><td>${esc(r)}</td><td>${n}</td></tr>`).join("");

  const sel = (v, cur) => v === cur ? " selected" : "";
  const filters = `
  <form class="filters" method="get">
    <label>${bi("fAction")}<select name="action">${option("", zh("all") + " / " + en("all"), !q.action)}${distinct(details, "action").map((a) => option(a, a, a === q.action)).join("")}</select></label>
    <label>${bi("fReason")}<select name="reason">${option("", zh("all") + " / " + en("all"), !q.reason)}${distinct(details, "reason").map((r) => option(r, r, r === q.reason)).join("")}</select></label>
    <label>${bi("fDay")}<select name="day">${option("", zh("all") + " / " + en("all"), !q.day)}${distinct(details.map((e) => ({ day: String(e._id).slice(0, 10) })), "day").map((d) => option(d, d, d === q.day)).join("")}</select></label>
    <label>${bi("fAgent")}<select name="agent">${option("", zh("all") + " / " + en("all"), !q.agent)}${distinct(details, "agent").map((a) => option(a, a, a === q.agent)).join("")}</select></label>
    <button type="submit">${bi("apply")}</button>
    <button type="submit" formaction="${qs({})}">${bi("reset")}</button>
  </form>`;

  const rowsHtml = rows.length
    ? rows.map((e) => `<tr>
      <td><a href="${qs(q, { detail: e._id })}">${esc(e._id)}</a></td>
      <td>${esc(new Date(e.ts).toISOString().replace("T", " ").slice(0, 19))}</td>
      <td>${esc(e.agent)}</td><td>${esc(e.action)}</td><td>${esc(e.reason)}</td>
      <td>${e.inputChars ?? ""}/${e.outputChars ?? ""}</td></tr>`).join("")
    : `<tr><td colspan="6" class="empty">${bi("noEvents")}</td></tr>`;

  const pager = `
  <div class="pager">
    ${page > 1 ? `<a href="${qs(q, { page: page - 1 })}">‹ ${bi("prev")}</a>` : ""}
    <span>${bi("pageOf", page, pages)}</span>
    ${page < pages ? `<a href="${qs(q, { page: page + 1 })}">${bi("next")} ›</a>` : ""}
  </div>`;

  return `${head(lang)}
<h1>${bi("title")}</h1>
${kpis}
<h2>${bi("byGroup")}</h2>
${groups ? `<table><thead><tr><th>experiment</th><th>version</th><th>group</th><th>requests</th><th>applied</th><th>model calls</th><th>hook p95</th><th>pass reasons (count)</th></tr></thead><tbody>${groups}</tbody></table>` : emptyNote}
<h2>${bi("coverage")}</h2>
${coverage ? `<table><thead><tr><th>experiment</th><th>version</th><th>bucketed / eligible</th><th>missing session</th></tr></thead><tbody>${coverage}</tbody></table>` : emptyNote}
<h2>${bi("actions")}</h2><div class="chips">${actions || "–"}</div>
<h2>${bi("reasonTop", Object.keys(stats.reasonTop).length)}</h2>
${reasons ? `<table><tr><th>reason</th><th>count</th></tr>${reasons}</table>` : `<p class="empty">${bi("noData")}</p>`}
<h2>${bi("events")}${filtered.length !== details.length ? ` (${filtered.length}/${details.length})` : ` (${details.length})`}</h2>
${filters}
${pager}
<table><thead><tr><th>id</th><th>${bi("colTs")}</th><th>${bi("colAgent")}</th><th>${bi("colAction")}</th><th>${bi("colReason")}</th><th>${bi("colInOut")}</th></tr></thead>
<tbody>${rowsHtml}</tbody></table>
${pager}
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
    .map((k) => `<tr><th>${esc(k)}</th><td>${esc(k === "ts" ? new Date(event.ts).toISOString() : event[k])}</td></tr>`).join("");
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
</body></html>`;
}
