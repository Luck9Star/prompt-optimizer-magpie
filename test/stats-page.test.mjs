// stats-page.mjs unit tests: filters, pagination, detail ids, bilingual
// rendering, HTML escaping of orig/rewritten audit text, empty states.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDays, eventsByDay, parseDetailId, filterEvents, paginate, renderPage, renderDetail, renderConfigPage, fmtDur, shortId, reasonGroup, ACTION_TAG, localStamp, css } from "../lib/stats-page.mjs";
import { aggregate } from "../lib/stats-service.mjs";

const mk = (rows, day = "2026-01-01") => {
  const dir = mkdtempSync(join(tmpdir(), "pom-page-"));
  writeFileSync(join(dir, day + ".ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return dir;
};
const ev = (over = {}) => ({ ts: 1700000000000, agent: "claude", action: "optimize", reason: "optimized", durationMs: 10, inputChars: 10, outputChars: 20, ...over });

test("stats-page: listDays newest-first; missing dir → []", () => {
  const dir = mkdtempSync(join(tmpdir(), "pom-days-"));
  mkdirSync(join(dir, "sub"), { recursive: true });
  for (const d of ["2026-01-01", "2026-01-03", "2026-01-02"]) writeFileSync(join(dir, d + ".ndjson"), "");
  assert.deepEqual(listDays(dir), ["2026-01-03", "2026-01-02", "2026-01-01"]);
  assert.deepEqual(listDays(join(dir, "nonexistent")), []);
});

test("stats-page: eventsByDay tags day:line ids, skips corrupt + invalid rows, oldest day first", () => {
  const dir = mkdtempSync(join(tmpdir(), "pom-evd-"));
  writeFileSync(join(dir, "2026-01-01.ndjson"), [
    JSON.stringify(ev({ action: "pass", reason: "not-turn" })),
    "{corrupt json",
    JSON.stringify(ev({ reason: "dry-run" })),
  ].join("\n") + "\n");
  writeFileSync(join(dir, "2026-01-02.ndjson"), JSON.stringify(ev({ action: "pass", reason: "short-text" })) + "\n");
  const evs = eventsByDay(dir);
  // corrupt line counted in line numbering, id of valid line 3 stays 3
  assert.deepEqual(evs.map((e) => e._id), ["2026-01-01:1", "2026-01-01:3", "2026-01-02:1"]);
  // invalid shape (no ts) dropped, keeps numbering stable
  writeFileSync(join(dir, "2026-01-03.ndjson"), JSON.stringify({ action: "pass", reason: "x" }) + "\n" + JSON.stringify(ev({ action: "pass", reason: "no-tools" })) + "\n");
  const evs2 = eventsByDay(dir);
  assert.ok(evs2.some((e) => e._id === "2026-01-03:2"));
  assert.ok(!evs2.some((e) => e._id === "2026-01-03:1"));
});

test("stats-page: parseDetailId strict; malformed → null", () => {
  assert.deepEqual(parseDetailId("2026-01-01:3"), { day: "2026-01-01", seq: 3 });
  for (const bad of ["", null, undefined, "2026-01-01", ":3", "foo:3", "2026-01-01:abc", "2026-1-1:3"]) {
    assert.equal(parseDetailId(bad), null, String(bad));
  }
});

test("stats-page: filterEvents by action/reason/day/agent, all optional", () => {
  const evs = [
    { ...ev(), _id: "2026-01-01:1" },
    { ...ev({ action: "pass", reason: "not-turn" }), _id: "2026-01-01:2" },
    { ...ev({ reason: "dry-run", agent: "codex" }), _id: "2026-01-02:1" },
  ];
  assert.equal(filterEvents(evs, {}).length, 3);
  assert.equal(filterEvents(evs, { action: "pass" }).length, 1);
  assert.equal(filterEvents(evs, { reason: "dry-run" }).length, 1);
  assert.equal(filterEvents(evs, { day: "2026-01-01" }).length, 2);
  assert.equal(filterEvents(evs, { agent: "codex" }).length, 1);
  assert.equal(filterEvents(evs, { action: "pass", day: "2026-01-02" }).length, 0);
});

test("stats-page: paginate 50/page, clamps out-of-range pages", () => {
  const evs = Array.from({ length: 120 }, (_, i) => ({ ...ev(), _id: `2026-01-01:${i + 1}` }));
  const p1 = paginate(evs, 1);
  assert.equal(p1.rows.length, 50);
  assert.equal(p1.page, 1);
  assert.equal(p1.pages, 3);
  const p3 = paginate(evs, 3);
  assert.equal(p3.rows.length, 20);
  assert.equal(paginate(evs, 99).page, 3); // clamp high
  assert.equal(paginate(evs, 0).page, 1);  // clamp low
  assert.equal(paginate(evs, NaN).page, 1);
  assert.deepEqual(paginate([], 1), { rows: [], page: 1, pages: 1 });
});

test("stats-page: renderPage bilingual — zh default, ?lang=en flips visible spans", () => {
  const dir = mk([ev()]);
  const stats = aggregate(eventsByDay(dir));
  const zh = renderPage(stats, eventsByDay(dir), {});
  assert.match(zh, /<html lang="zh" data-lang="zh">/);
  assert.match(zh, /事件明细/);
  assert.doesNotMatch(zh, /<html lang="en"/);
  const en = renderPage(stats, eventsByDay(dir), { lang: "en" });
  assert.match(en, /<html lang="en" data-lang="en">/);
  assert.match(en, /Detailed events/);
  // both languages present server-side; CSS hides the inactive one
  assert.match(zh, /data-lang="en"/);
  assert.match(en, /data-lang="zh"/);
});

test("stats-page: renderPage filters show in table and dropdown options", () => {
  const dir = mk([ev({ action: "pass", reason: "not-turn" }), ev({ reason: "optimized" }), ev({ reason: "dry-run", agent: "codex" })]);
  const evs = eventsByDay(dir);
  const stats = aggregate(evs);
  const html = renderPage(stats, evs, { reason: "not-turn" });
  assert.match(html, /not-turn/);
  assert.ok(!/>codex<\/td>/.test(html), "filtered-out agent row absent");
  assert.match(html, /value="codex"/); // agent stays a filter option
  const html2 = renderPage(stats, evs, { agent: "codex" });
  assert.match(html2, /dry-run/);
  assert.ok(!/<td>not-turn<\/td><\/tr>/.test(html2.split("事件明细")[1] ?? ""), "filtered-out reason row absent from event table");
  assert.match(html2, /value="not-turn"/); // stays a filter option
  // filter values appear as <option> for distinct dropdowns
  assert.match(html, /<option value="optimize"/);
});

// ── .omp-pass0-brief.md（pass 行 in/out 列显示「原样跳过/skipped as-is」） ──────
test("pass0: pass 行 in/out 显示「原样跳过」而非 0/0；en 显示 skipped as-is；optimize 行保持数字", () => {
  const dir = mk([ev({ action: "pass", reason: "not-turn", inputChars: 0, outputChars: 0 }), ev({ inputChars: 34, outputChars: 303 })]);
  const evs = eventsByDay(dir);
  const stats = aggregate(evs);
  const zh = renderPage(stats, evs, {});
  assert.match(zh, /<span class="skipped"><span data-lang="zh">原样跳过<\/span><span data-lang="en">skipped as-is<\/span><\/span>/);
  assert.ok(!/<td>0\/0<\/td>/.test(zh), "no 0/0 cell on pass rows");
  const en = renderPage(stats, evs, { lang: "en" });
  assert.match(en, /data-lang="en">skipped as-is<\/span>/);
  assert.ok(!/<td>0\/0<\/td>/.test(en));
  // optimize 行照旧数字形态（fixture 34/303）
  assert.match(zh, /<td style="--label:var\(--label-5\)">34\/303<\/td>/);
  // decide 行不受影响（无 rewritten 仍显示数字）
  const dir2 = mk([ev({ action: "decide", reason: "followup", inputChars: 12, outputChars: 0 })]);
  const html2 = renderPage(aggregate(eventsByDay(dir2)), eventsByDay(dir2), {});
  assert.match(html2, /<td style="--label:var\(--label-5\)">12\/0<\/td>/);
});

test("stats-page: pagination renders page 2 and next/prev links keep filters", () => {
  const rows = Array.from({ length: 60 }, (_, i) => ev({ reason: i < 30 ? "optimized" : "dry-run" }));
  const dir = mk(rows);
  const evs = eventsByDay(dir);
  const stats = aggregate(evs);
  const p1 = renderPage(stats, evs, { reason: "dry-run" });
  assert.match(p1, /第 1 \/ 1 页/); // filtered set (30) fits one page
  const all1 = renderPage(stats, evs, {});
  assert.match(all1, /第 1 \/ 2 页/);
  assert.match(all1, /href="\?page=2"/); // next link on page 1
  const all2 = renderPage(stats, evs, { page: "2" });
  assert.match(all2, /第 2 \/ 2 页/);
  assert.match(all2, /href="\?page=1"/); // prev link on page 2
  // filters survive pager navigation
  const all3 = renderPage(stats, evs, { page: "1", reason: "dry-run" });
  assert.match(all3, /name="reason"/);
  assert.match(all3, /value="dry-run" selected/);
});

test("stats-page: detail page renders metadata + escaped orig/rewritten; unknown id → note", () => {
  const dir = mk([ev({ orig: '<script>alert("x")</script>', rewritten: 'a & "b" <img>' })]);
  const e = eventsByDay(dir)[0];
  const html = renderDetail(e, {});
  assert.match(html, /事件详情/);
  assert.ok(html.includes("&#60;script&#62;alert(&#34;x&#34;)&#60;/script&#62;"), "orig escaped");
  assert.ok(html.includes("a &#38; &#34;b&#34; &#60;img&#62;"), "rewritten escaped");
  assert.ok(!html.includes("<script>alert"), "no raw script tag");
  const nf = renderDetail(null, {});
  assert.match(nf, /事件不存在/);
  const nfEn = renderDetail(null, { lang: "en" });
  assert.match(nfEn, /not found/i);
});

test("stats-page: empty stats render the empty-state note, not a blank table", () => {
  const html = renderPage({ total: 0, optimizeDuration: { p50: null, p95: null }, requestGroups: [], sessionCoverage: [], actionCounts: {}, reasonTop: {} }, [], {});
  assert.match(html, /汇总表为空是预期行为/);
  assert.match(html, /暂无数据|没有匹配的事件/);
  const en = renderPage({ total: 0, optimizeDuration: { p50: null, p95: null }, requestGroups: [], sessionCoverage: [], actionCounts: {}, reasonTop: {} }, [], { lang: "en" });
  assert.match(en, /Empty summary tables are expected/);
});

test("stats-page: page uses --magpie-* vars and no inline handlers; zero fetch/XHR/script src beyond lang.js", () => {
  const dir = mk([ev()]);
  const evs = eventsByDay(dir);
  const html = renderPage(aggregate(evs), evs, {});
  assert.match(html, /--magpie-bg/);
  assert.match(html, /--magpie-fg/);
  assert.match(html, /--magpie-accent/);
  assert.ok(!/on(click|load|error|change)=/i.test(html), "no inline handlers");
  assert.ok(!/fetch\(|XMLHttpRequest/i.test(html), "no fetch/XHR");
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ["../bridge.js", "./lang.js"]);
  // form is GET, no JS needed
  assert.match(html, /<form class="filters" method="get">/);
});

test("stats-page: day filter option list matches available day files", () => {
  const dir = mkdtempSync(join(tmpdir(), "pom-dayopt-"));
  writeFileSync(join(dir, "2026-01-01.ndjson"), JSON.stringify(ev()) + "\n");
  writeFileSync(join(dir, "2026-01-02.ndjson"), JSON.stringify(ev({ action: "pass", reason: "no-tools" })) + "\n");
  const evs = eventsByDay(dir);
  const html = renderPage(aggregate(evs), evs, {});
  assert.match(html, /<option value="2026-01-01"/);
  assert.match(html, /<option value="2026-01-02"/);
  rmSync(dir, { recursive: true, force: true });
});

// ── .omp-tags-brief.md 需求1-5（新增断言，不改已有断言） ────────────────────
test("stats-page: 需求1 shortId = sha256(day:seq) 前 6 位小写 hex；detail 链接保留原始 id", () => {
  assert.equal(shortId("2026-11-22:17"), "fead3d");
  assert.ok(/^[0-9a-f]{6}$/.test(shortId("2026-01-01:0")));
  assert.notEqual(shortId("2026-01-01:0"), shortId("2026-01-01:1"));
  const dir = mk([ev(), ev({ action: "pass", reason: "not-turn" })]);
  const evs = eventsByDay(dir);
  const html = renderPage(aggregate(evs), evs, {});
  const link = html.match(/<a href="([^"]*detail=2026-01-01%3A1[^"]*)">([0-9a-f]{6})<\/a>/);
  assert.ok(link, "detail link present");
  assert.equal(link[2], shortId("2026-01-01:1"), "visible text is the short id");
  assert.ok(!/>2026-01-01:1</.test(html), "raw day:seq not shown as cell text");
});

test("stats-page: 需求1 durationMs 列出现在事件明细表", () => {
  const dir = mk([ev({ durationMs: 1234 }), ev({ action: "pass", reason: "not-turn", durationMs: 0 })]);
  const evs = eventsByDay(dir);
  const html = renderPage(aggregate(evs), evs, {});
  assert.match(html, /<th[^>]*>.*?耗时/s);
  assert.match(html, /<td style="--label:var\(--label-6\)">1\.2s<\/td>/); // 1234ms → floored 1dp
  assert.match(html, /<td style="--label:var\(--label-6\)">0ms<\/td>/);  // pass rows show explicit 0
});

test("stats-page: 需求2 action 列渲染彩色 tag（映射 + 渲染）", () => {
  assert.equal(ACTION_TAG.optimize, "green");
  assert.equal(ACTION_TAG.decide, "amber");
  assert.equal(ACTION_TAG.pass, "muted");
  assert.equal(ACTION_TAG.summary, "accent");
  const dir = mk([ev(), ev({ action: "decide", reason: "followup" }), ev({ action: "pass", reason: "not-turn" })]);
  const evs = eventsByDay(dir);
  const html = renderPage(aggregate(evs), evs, {});
  assert.match(html, /<span class="tag tag-green"[^>]*><span data-lang="zh">改写<\/span><span data-lang="en">optimize<\/span><\/span>/);
  assert.match(html, /<span class="tag tag-amber"[^>]*><span data-lang="zh">判定<\/span><span data-lang="en">decide<\/span><\/span>/);
  assert.match(html, /<span class="tag tag-muted"[^>]*><span data-lang="zh">放行<\/span><span data-lang="en">pass<\/span><\/span>/);
});

test("stats-page: 需求3 reason 分组纯函数：green/amber/red/后缀-失败/前缀-choice/未知灰", () => {
  assert.equal(reasonGroup("optimized"), "green");
  assert.equal(reasonGroup("merged-optimized"), "green");
  assert.equal(reasonGroup("cache-hit"), "green");
  assert.equal(reasonGroup("not-turn"), "amber");
  assert.equal(reasonGroup("followup"), "amber");
  assert.equal(reasonGroup("choice:whatever"), "amber"); // 前缀规则
  assert.equal(reasonGroup("output-guard"), "red");
  assert.equal(reasonGroup("merged-fail"), "red");       // 后缀规则
  assert.equal(reasonGroup("never-seen-reason"), "muted"); // 未知归灰
  const dir = mk([ev({ action: "pass", reason: "output-guard", durationMs: 5 })]);
  const evs = eventsByDay(dir);
  const html = renderPage(aggregate(evs), evs, {});
  assert.match(html, /<span class="tag tag-red"[^>]*>output-guard<\/span>/);
});

test("stats-page: 需求4 reason 图例在 <details> 中，按语义分组且双语", () => {
  const dir = mk([ev()]);
  const evs = eventsByDay(dir);
  const html = renderPage(aggregate(evs), evs, {});
  assert.match(html, /<details class="legend"><summary>/);
  assert.ok(html.includes("改写已应用"), "green legend entry (zh)");
  assert.ok(html.includes("rewrite applied"), "green legend entry (en)");
  assert.ok(html.includes("改写超护栏已回退"), "red legend entry");
  assert.ok(html.includes("非回合首条"), "amber legend entry");
  assert.ok(html.includes("choice:*"), "suffix/prefix rule note");
  const en = renderPage(aggregate(evs), evs, { lang: "en" });
  assert.ok(en.includes("reason legend"), "en legend title rendered");
});

test("stats-page: 需求5 详情页空 orig/rewritten 显示解释文案；有内容时不显示", () => {
  const noText = mk([ev({ action: "pass", reason: "not-turn" })]);
  const evs1 = eventsByDay(noText);
  const d1 = renderDetail(evs1[0], {});
  assert.ok(d1.includes("此路径不记录原文"), "zh explanation shown");
  const d1en = renderDetail(evs1[0], { lang: "en" });
  assert.ok(d1en.includes("does not record prompt text"), "en explanation shown");
  const withText = mk([ev({ orig: "原文", rewritten: "改写" })]);
  const evs2 = eventsByDay(withText);
  const d2 = renderDetail(evs2[0], {});
  assert.ok(!d2.includes("此路径不记录原文"), "no explanation when text present");
});

// ── .omp-i18n-brief.md 需求1-2（新增断言，不改已有断言） ─────────────────────
test("i18n: 需求1 列表页首行是最新事件（时间倒序，第 1 页最新）", () => {
  const dir = mk([ev({ ts: 1700000000000 }), ev({ ts: 1700000001000 }), ev({ ts: 1700000002000 })]);
  const evs = eventsByDay(dir);
  const html = renderPage(aggregate(evs), evs, {});
  const firstTs = html.match(/<tbody><tr>\s*<td><a[^>]*>[0-9a-f]{6}<\/a><\/td>\s*<td[^>]*>(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})<\/td>/);
  assert.ok(firstTs, "first row timestamp captured");
  assert.equal(firstTs[1], localStamp(1700000002000), "newest ts first (local)");
});

test("i18n: 需求2 zh 模式 action/reason 显示中文标签", () => {
  const dir = mk([ev(), ev({ action: "pass", reason: "not-turn" }), ev({ action: "decide", reason: "followup" })]);
  const evs = eventsByDay(dir);
  const html = renderPage(aggregate(evs), evs, {});
  assert.match(html, /<span class="tag tag-green"[^>]*><span data-lang="zh">改写<\/span>/);
  assert.match(html, /<span class="tag tag-amber"[^>]*><span data-lang="zh">判定<\/span>/);
  assert.match(html, /<span class="tag tag-amber"[^>]*><span data-lang="zh">非回合首条<\/span>/); // reason reuses r_* legend entry
  assert.match(html, /<span class="chip"><span data-lang="zh">改写<\/span>/); // 动作分布胶囊
  assert.match(html, /<option value="not-turn"[^>]*><span data-lang="zh">非回合首条<\/span>/);
  const d = renderDetail(evs[0], {});
  assert.match(d, /<th>action<\/th><td><span class="tag tag-green"[^>]*><span data-lang="zh">改写<\/span>/); // 详情元数据
});

test("i18n: 需求2 en 模式显示原始英文值", () => {
  const dir = mk([ev(), ev({ action: "pass", reason: "not-turn" })]);
  const evs = eventsByDay(dir);
  const html = renderPage(aggregate(evs), evs, { lang: "en" });
  assert.match(html, /<span class="tag tag-green"[^>]*><span data-lang="zh">改写<\/span><span data-lang="en">optimize<\/span>/);
  assert.match(html, /<span class="tag tag-amber"[^>]*><span data-lang="zh">非回合首条<\/span><span data-lang="en">not first turn<\/span>/);
  assert.match(html, /<option value="not-turn"[^>]*><span data-lang="zh">非回合首条<\/span><span data-lang="en">not first turn<\/span>/);
  const d = renderDetail(evs[1], { lang: "en" });
  assert.match(d, /<th>reason<\/th><td><span class="tag tag-amber"[^>]*><span data-lang="zh">非回合首条<\/span><span data-lang="en">not first turn<\/span>/);
});

test("i18n: 需求2 tag CSS class 仍基于原始值生成；筛选 option value 保持原始英文", () => {
  const dir = mk([ev(), ev({ action: "pass", reason: "output-guard" })]);
  const evs = eventsByDay(dir);
  const html = renderPage(aggregate(evs), evs, {});
  // class 由原始 reason 值分组（output-guard → red），与中文文案无关
  assert.match(html, /<span class="tag tag-red"[^>]*><span data-lang="zh">改写超护栏已回退<\/span>/);
  assert.ok(!/tag-(改写|放行)/.test(html), "no translated class names");
  // 服务端筛选依赖原始 value
  assert.match(html, /<option value="output-guard"/);
  assert.match(html, /<option value="optimize"/);
});

test("i18n: 需求1 详情链接与 KPI/Top10 不受排序影响", () => {
  const dir = mk([ev({ ts: 1700000000000, reason: "optimized" }), ev({ ts: 1700000001000, reason: "optimized" }), ev({ ts: 1700000002000, action: "pass", reason: "short-text" })]);
  const evs = eventsByDay(dir);
  const stats = aggregate(evs);
  const html = renderPage(stats, evs, {});
  assert.equal(stats.total, 3, "KPI 不变");
  assert.match(html, /detail=2026-01-01%3A2/, "原始 day:seq 寻址仍在");
  const byId = renderPage(stats, evs, { action: "pass" });
  assert.match(byId, /detail=2026-01-01%3A3/, "筛选后链接仍指向同一事件");
});

// ── .omp-tooltip-brief.md（title 悬浮注释；仅新增断言） ────────────────────────
test("tooltip: 事件表与详情页 tag 均含 title 属性", () => {
  const dir = mk([ev(), ev({ action: "pass", reason: "not-turn" })]);
  const evs = eventsByDay(dir);
  const html = renderPage(aggregate(evs), evs, {});
  assert.match(html, /<span class="tag tag-green" title="/); // 列表 action tag
  assert.match(html, /<span class="tag tag-amber" title="/); // 列表 reason tag
  const d = renderDetail(evs[1], {});
  assert.match(d, /<th>action<\/th><td><span class="tag tag-muted" title="/); // 详情 action
  assert.match(d, /<th>reason<\/th><td><span class="tag tag-amber" title="/); // 详情 reason
});

test("tooltip: zh 中文说明 / en 英文说明（4 个 action 全覆盖）", () => {
  const summaryEv = { ts: 1700000000000, agent: "claude", action: "summary", reason: "session-end", durationMs: 5, group: "g", experimentId: "E", version: "v1", turn: "first", mode: "auto", fallbackFrom: "", finalAction: "pass", fromCache: false, modelCalls: 0 };
  const dir = mk([ev(), ev({ action: "decide", reason: "followup" }), ev({ action: "pass", reason: "not-turn" }), summaryEv]);
  const evs = eventsByDay(dir);
  const zh = renderPage(aggregate(evs), evs, {});
  assert.match(zh, /tag tag-green" title="已调用模型改写提示词"/);
  assert.match(zh, /tag tag-amber" title="仅执行是否优化的判定"/);
  assert.match(zh, /tag tag-muted" title="原样放行，未调用模型"/);
  // summary 事件不进事件明细表（进按分组聚合表），accent title 在详情页断言
  assert.match(renderDetail(evs.find((e) => e.action === "summary"), {}), /tag tag-accent" title="会话汇总事件"/);
  const en = renderPage(aggregate(evs), evs, { lang: "en" });
  assert.match(en, /tag tag-green" title="model called to rewrite the prompt"/);
  assert.match(en, /tag tag-amber" title="decision only: whether to optimize"/);
  assert.match(en, /tag tag-muted" title="passed through as-is, no model call"/);
  assert.match(renderDetail(evs.find((e) => e.action === "summary"), { lang: "en" }), /tag tag-accent" title="session summary event"/);
});

test("tooltip: reason 无 r_* 词条时 title 回退原始值", () => {
  const dir = mk([ev({ reason: "some-brand-new-reason" })]);
  const evs = eventsByDay(dir);
  const html = renderPage(aggregate(evs), evs, { lang: "en" });
  assert.match(html, /tag tag-muted" title="some-brand-new-reason"/);
  const d = renderDetail(evs[0], { lang: "en" });
  assert.match(d, /<th>reason<\/th><td><span class="tag tag-muted" title="some-brand-new-reason"/);
});

test("tooltip: title 值经属性转义（含引号与尖括号的 reason）", () => {
  const nasty = 'weird "reason" <b>x</b>';
  const dir = mk([ev({ reason: nasty })]);
  const evs = eventsByDay(dir);
  const html = renderPage(aggregate(evs), evs, {});
  // esc() 属性上下文：引号与尖括号都必须转成实体，不得裸露
  assert.match(html, /title="weird &#34;reason&#34; &#60;b&#62;x&#60;\/b&#62;"/);
  assert.ok(!/title="[^"]*<b>/.test(html), "no raw <b> inside title");
});

// ── .omp-redesign-brief.md（A/B/C 规则回归断言） ──────────────────────────────
test("redesign A: semantic nav tabs with aria-current, no layout-shift states", () => {
  const dir = mk([ev()]);
  const evs = eventsByDay(dir);
  const html = renderPage(aggregate(evs), evs, {});
  assert.match(html, /<nav class="tabs" aria-label="[^"]+"><ul><li><a href="\.\/"/);
  assert.match(html, /href="\.\/" aria-current="page"/, "stats tab current on list page");
  assert.ok(!/href="\.\/\?page=config" aria-current/.test(html), "config tab not current");
  const cfg = renderConfigPage({ current: {}, lang: "zh" });
  assert.match(cfg, /href="\.\/\?page=config" aria-current="page"/, "config tab current on config page");
  // no size change on selected/hover; no box-shadow/background states
  assert.match(html, /nav\.tabs a\[aria-current="page"\][^}]*border-block-end-color/);
  assert.ok(!/nav\.tabs a(:hover|\[aria-current="page"\])[^}]*(box-shadow|background)/s.test(html));
});

test("redesign B: responsive tables — wrapper region, sticky head, stacked cards, labels", () => {
  const dir = mk([ev()]);
  const evs = eventsByDay(dir);
  const html = renderPage(aggregate(evs), evs, {});
  assert.match(html, /<div class="table-wrapper" tabindex="0" role="region" aria-labelledby="[^"]+">/);
  assert.match(html, /container-type: inline-size/);
  assert.match(html, /position: sticky/);
  assert.match(html, /@container \(max-width: 40em\)/);
  assert.match(html, /td::before \{ content: var\(--label/);
  assert.match(html, /style="--label-1:[^;]+;--label-2:[^;]+;--label-3:[^;]+;--label-4:[^;]+;--label-5:[^;]+;--label-6:[^;]+"/, "per-column label vars on the events table");
  assert.match(html, /--label:var\(--label-5\)/, "in/out cell carries its label var");
});

test("redesign C: focus-visible ring + spacing tokens present", () => {
  const dir = mk([ev()]);
  const evs = eventsByDay(dir);
  const html = renderPage(aggregate(evs), evs, {});
  assert.match(html, /:focus-visible \{\s*outline: 2px solid var\(--sem-accent/);
  assert.match(html, /a:focus-visible, button:focus-visible, select:focus-visible, input:focus-visible/);
  assert.match(html, /--space-1: \.25rem; --space-2: \.5rem; --space-3: 1rem; --space-4: 1\.5rem/);
  assert.match(html, /padding: var\(--space-4\) var\(--space-3\) 3rem/);
});

test("redesign hard constraints: script tags byte-identical, zero JS additions", () => {
  const dir = mk([ev()]);
  const evs = eventsByDay(dir);
  const html = renderPage(aggregate(evs), evs, {});
  const cfg = renderConfigPage({ current: {}, lang: "en" });
  const det = renderDetail(evs[0], {});
  for (const [name, page] of [["list", html], ["config", cfg], ["detail", det]]) {
    assert.ok(page.includes(`<script src="../bridge.js"></script>\n<script src="./lang.js" defer></script>`), `${name}: both script tags unchanged`);
    assert.equal((page.match(/<script/g) || []).length, 2, `${name}: exactly two script tags`);
    assert.ok(!/fetch\(|XMLHttpRequest/.test(page), `${name}: no fetch/XHR`);
    assert.ok(!/\son[a-z]+="/.test(page), `${name}: no inline event handlers`);
  }
});

// ── .omp-details-brief.md ───────────────────────────────────────────────────
test("details A: fmtDur 自适应单位（ms→s，floor 一位小数，去尾零）", () => {
  assert.equal(fmtDur(862), "862ms");
  assert.equal(fmtDur(999), "999ms");
  assert.equal(fmtDur(6031), "6s");
  assert.equal(fmtDur(9499), "9.4s");
  assert.equal(fmtDur(6000), "6s");
  assert.equal(fmtDur(1234), "1.2s");
  assert.equal(fmtDur(0), "0ms");
  assert.equal(fmtDur(undefined), "–");
  assert.equal(fmtDur(null), "–");
});

test("details A: KPI p95 与详情页耗时人性化", () => {
  const dir = mk([ev({ durationMs: 9499, optimizeMs: 9499 })]);
  const evs = eventsByDay(dir);
  const html = renderPage(aggregate(evs), evs, {});
  assert.match(html, /<b class="v-green"[^>]*>9\.4s<\/b>/);
  assert.ok(!/9499 ms/.test(html), "no raw ms-with-space suffix");
  const d = renderDetail(evs[0], {});
  assert.match(d, /<th>durationMs<\/th><td>9\.4s<\/td>/);
});

test("details B: 11 个配置字段双语 label + hint（非裸 key）", () => {
  const cfg = renderConfigPage({ current: {}, lang: "zh" });
  for (const key of ["enabled", "dryRun", "optimizerMode", "minChars", "maxChars", "logSkips", "logOptimizes", "deciderGroup", "optimizeGroup", "deciderTimeoutMs", "optimizeTimeoutMs"]) {
    assert.ok(cfg.includes(`name="${key}"`), key);
  }
  // 抽 4 个断言 label 是 T 词条而非裸 key
  assert.match(cfg, /启用插件/);
  assert.match(cfg, /演练模式（只记录不替换）/);
  assert.match(cfg, /判定模型组/);
  assert.match(cfg, /改写超时（毫秒）/);
  // hints 渲染且双语
  assert.match(cfg, /总开关，关闭后 hook 直接放行，不调用任何模型/);
  assert.match(cfg, /master switch; when off the hook passes every request through/);
  assert.match(cfg, /超时放行原文（默认 15000）/); // 与 hooks.mjs DEFAULTS 一致
  assert.match(cfg, /optimizer call timeout in ms; timeout passes the original through \(default 15000\)/);
  assert.ok(!/<span class="k">deciderTimeoutMs<\/span>/.test(cfg), "no bare key label");
});

test("details C: 模型组下拉注入 providers.json groups；缺失静默降级", () => {
  const groups = ["route-decider", "prompt-optimize"];
  const cfg = renderConfigPage({ current: { deciderGroup: "group/route-decider" }, lang: "zh", groups });
  assert.match(cfg, /<select name="deciderGroup">/);
  assert.match(cfg, /<option value="group\/route-decider" selected>group\/route-decider<\/option>/);
  assert.match(cfg, /<option value="group\/prompt-optimize">group\/prompt-optimize<\/option>/);
  assert.match(cfg, /<select name="optimizeGroup">/);
  // 当前值不在列表时仍可选中（fallback option）
  const cfg2 = renderConfigPage({ current: { optimizeGroup: "group/custom-gpu" }, lang: "zh", groups });
  assert.match(cfg2, /<option value="group\/custom-gpu" selected>group\/custom-gpu<\/option>/);
  // 缺 providers.json：不 throw，退化为仅空选项+当前值
  const cfg3 = renderConfigPage({ current: { deciderGroup: "group/x" }, lang: "zh", groups: [] });
  assert.match(cfg3, /<select name="deciderGroup"><option value=""><\/option><option value="group\/x" selected>group\/x<\/option><\/select>/);
});

// ── .omp-kpi-brief.md / .omp-pct-brief.md ────────────────────────────────────
test("KPI: 卡渲染（总数 + decide/optimize/pass 各一张，随 pct 取值）+ title 口径", () => {
  const dir = mk([
    ev({ action: "decide", reason: "new-task", durationMs: 1200, decideMs: 1200 }),
    ev({ action: "decide", reason: "new-task", durationMs: 2400, decideMs: 2400 }),
    ev({ durationMs: 300, optimizeMs: 300 }),
    ev({ action: "pass", reason: "not-turn", durationMs: 1 }), // no stage fields → no bucket
  ]);
  const evs = eventsByDay(dir);
  const html = renderPage(aggregate(evs), evs, {});
  assert.equal((html.match(/class="kpi"/g) || []).length, 3, "total + decide + optimize only");
  assert.match(html, /<b class="v-amber"[^>]*>2\.4s<\/b>/); // decide p95 default
  assert.match(html, /<b class="v-green"[^>]*>300ms<\/b>/);
  assert.match(html, /<b>4<\/b>/, "total card keeps default color");
  assert.match(html, /title="判定耗时 p95：仅真实调用模型的事件（n=2）"/);
  assert.match(html, /title="改写耗时 p95：仅真实调用模型的事件（n=1）"/);
  assert.match(html, />decide p95<\/span>/);
  assert.ok(!/pass p95/.test(html), "pass card gone");
});

test("KPI: 无该 action 数据时显示 —", () => {
  const dir = mk([ev({ durationMs: 500, optimizeMs: 500 })]); // only optimize
  const evs = eventsByDay(dir);
  const html = renderPage(aggregate(evs), evs, {});
  assert.match(html, /<b class="v-amber"[^>]*>–<\/b>/); // decide dash
  assert.equal((html.match(/v-amber[^>]*>–/g) || []).length, 1);
  assert.match(html, /<b class="v-green"[^>]*>500ms<\/b>/);
  assert.match(html, /title="判定耗时 p95：仅真实调用模型的事件（n=0）"/);
});

test("KPI: percentile 正确性（按 action 分桶）", () => {
  const dir = mk([
    ...[100, 200, 300, 400, 5000].map((d) => ev({ durationMs: d, optimizeMs: d })),       // optimize
    ...[10, 20, 30].map((d) => ev({ action: "decide", reason: "new-task", durationMs: d, decideMs: d })),
  ]);
  const evs = eventsByDay(dir);
  const agg = aggregate(evs);
  assert.equal(agg.actionDuration.optimize.count, 5);
  assert.equal(agg.actionDuration.optimize.p50, 300); // ceil(0.5*5)-1 = index 2
  assert.equal(agg.actionDuration.decide.p50, 20);
  assert.equal(agg.actionDuration.decide.p95, 30);
  assert.equal(agg.actionDuration.pass, undefined); // pass bucket removed entirely
  // 兼容别名：optimizeDuration = actionDuration.optimize
  assert.equal(agg.optimizeDuration.p95, 5000);
});

// ── .omp-pct-brief.md: 切换器 + 贯通 ─────────────────────────────────────────
test("pct: ?pct=p99 取 p99 值与 label；非法 pct 回落 p95", () => {
  const dir = mk([
    ev({ durationMs: 100, optimizeMs: 100 }),
    ev({ durationMs: 200, optimizeMs: 200 }),
    ev({ durationMs: 300, optimizeMs: 300 }),
    ev({ durationMs: 400, optimizeMs: 400 }),
    ev({ durationMs: 5000, optimizeMs: 5000 }),
    ev({ action: "decide", reason: "new-task", durationMs: 42, decideMs: 42 }),
  ]);
  const evs = eventsByDay(dir);
  const p99 = renderPage(aggregate(evs), evs, { pct: "p99" });
  // ceil(0.99*5)-1 = index 4 → 5000; decide p99 = 42
  assert.match(p99, /<b class="v-green"[^>]*>5s<\/b>/);
  assert.match(p99, /<b class="v-amber"[^>]*>42ms<\/b>/);
  assert.match(p99, /title="判定耗时 p99：仅真实调用模型的事件（n=1）"/);
  // invalid falls back to p95 (ceil(0.95*5)-1 = 4 → 5000 too, so use label to distinguish)
  const bad = renderPage(aggregate(evs), evs, { pct: "p42" });
  assert.match(bad, />optimize p95<\/span>/);
  assert.match(bad, /<a href="\?pct=p95" aria-current="true">p95<\/a>/, "fallback marks p95");
  assert.match(bad, /<a href="\?pct=p95"[^>]*aria-current="true"/);
});

test("pct: 切换器 4 链接保留既有 query；aria-current 唯一", () => {
  const dir = mk([ev({ durationMs: 100 }), ev({ action: "pass", reason: "not-turn", durationMs: 2 })]);
  const evs = eventsByDay(dir);
  const html = renderPage(aggregate(evs), evs, { pct: "p50", action: "optimize", lang: "en" });
  assert.match(html, /<a href="\?action=optimize&lang=en&pct=p50" aria-current="true">p50<\/a>/);
  assert.match(html, /<a href="\?action=optimize&lang=en&pct=p95">p95<\/a>/);
  assert.match(html, /<a href="\?action=optimize&lang=en&pct=p99">p99<\/a>/);
  assert.match(html, /<a href="\?action=optimize&lang=en&pct=max">max<\/a>/);
  assert.equal((html.match(/aria-current="true"[^>]*>(?:p50|p95|p99|max)<\/a>/g) || []).length, 1, "exactly one current pct link");
});

test("pct: 翻页与详情返回链接携带 pct", () => {
  const rows = Array.from({ length: 60 }, (_, i) => ev({ durationMs: i }));
  const dir = mk(rows);
  const evs = eventsByDay(dir);
  const list = renderPage(aggregate(evs), evs, { pct: "p99" });
  assert.match(list, /href="\?pct=p99&page=2"/); // next keeps pct
  const detail = renderDetail(evs[0], { pct: "p99" });
  assert.match(detail, /href="\?pct=p99"/); // back link keeps pct
});

test("pct: max 分位数取桶内最大值", () => {
  const dir = mk([ev({ durationMs: 100, optimizeMs: 100 }), ev({ durationMs: 9000, optimizeMs: 9000 }), ev({ durationMs: 500, optimizeMs: 500 })]);
  const evs = eventsByDay(dir);
  const agg = aggregate(evs);
  assert.equal(agg.actionDuration.optimize.max, 9000);
  assert.equal(agg.actionDuration.decide.max, null); // empty bucket
  const html = renderPage(agg, evs, { pct: "max" });
  assert.match(html, /<b class="v-green"[^>]*>9s<\/b>/);
  assert.match(html, />optimize max<\/span>/);
});

// dark theme regression (.omp-darkcolor-brief.md): tags used to fall back to
// CanvasText (white-on-dark, all four semantic colors collapsed). css() must
// define light-dark() pairs and sem tokens, and never fall back to CanvasText
// for colored elements.
test("stats-page: css uses light-dark() semantic tokens, no CanvasText color fallback", () => {
  const s = css();
  assert.match(s, /--sem-green:\s*var\(--magpie-green,\s*light-dark\(/);
  assert.match(s, /light-dark\(var\(--green-l\),\s*var\(--green-d\)\)/);
  for (const c of ["green", "amber", "red", "accent"]) assert.ok(s.includes(`--sem-${c}:`), `--sem-${c} defined`);
  assert.ok(!/\.tag-\w+\s*\{[^}]*CanvasText/.test(s), "no CanvasText fallback in tag colors");
  assert.match(s, /\.tag-green\s*\{\s*color:\s*var\(--sem-green\)/);
});
