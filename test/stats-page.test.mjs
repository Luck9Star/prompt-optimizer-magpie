// stats-page.mjs unit tests: filters, pagination, detail ids, bilingual
// rendering, HTML escaping of orig/rewritten audit text, empty states.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDays, eventsByDay, parseDetailId, filterEvents, paginate, renderPage, renderDetail } from "../lib/stats-page.mjs";
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
