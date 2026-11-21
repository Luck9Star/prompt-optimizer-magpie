// Shared stats HTTP service (design §6). Used two ways:
//   index.mjs server() — magpie's plugin host calls it when the stats page
//     opens; the service lives in the host process and dies with the plugin.
//     hello.service (page bridge) points at the manifest port (3497).
//   serve.mjs — standalone daemon (systemd on 70) with env overrides.
// Node stdlib only. Default bind is 127.0.0.1 — origText clips of user
// prompts live in the day-files, so never expose beyond loopback unless the
// operator opts in via bind/POM_BIND. Retention (prune) runs here so BOTH
// entry points get it (in-app-only installs no longer grow stats/ forever).
// The service reads stats/; it never writes it (prune only unlinks old
// day-files, never today's).
import { createServer, get } from "node:http";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { readEvents, prune } from "./stats.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i];
}

export function aggregate(events) {
  const details = events.filter((e) => e.action !== "summary");
  const groups = new Map();
  for (const e of events) {
    if (e.action !== "summary") continue;
    const key = JSON.stringify([e.experimentId, e.version, e.group]);
    if (!groups.has(key)) {
      groups.set(key, {
        experimentId: e.experimentId, version: e.version, group: e.group,
        samples: 0, applied: 0, modelCalls: 0, passReasons: Object.create(null), durations: [],
      });
    }
    const group = groups.get(key);
    group.samples++;
    if (e.finalAction === "apply") group.applied++;
    if (e.finalAction === "pass") group.passReasons[e.reason] = (group.passReasons[e.reason] || 0) + 1;
    group.modelCalls += e.modelCalls;
    group.durations.push(e.durationMs);
  }
  const requestGroups = Array.from(groups.values(), ({ durations, ...group }) => ({
    ...group, applyRate: group.applied / group.samples, p95Ms: percentile(durations.sort((a, b) => a - b), 95),
  }));
  const actionCounts = Object.create(null);
  const reasonTop = Object.create(null);
  for (const e of details) {
    const a = e.action || "unknown";
    actionCounts[a] = (actionCounts[a] || 0) + 1;
    const r = e.reason || "unknown";
    reasonTop[r] = (reasonTop[r] || 0) + 1;
  }
  // p50/p95 over optimize-action events, wall-clock from onRequest entry —
  // includes gates + decider call (up to deciderTimeoutMs), not just the rewrite
  const durs = details
    .filter((e) => e.action === "optimize" && typeof e.durationMs === "number")
    .map((e) => e.durationMs)
    .sort((x, y) => x - y);
  return {
    requestGroups,
    total: details.length,
    actionCounts,
    reasonTop: Object.fromEntries(Object.entries(reasonTop).sort((a, b) => b[1] - a[1]).slice(0, 10)),
    optimizeDuration: { count: durs.length, p50: percentile(durs, 50), p95: percentile(durs, 95) },
    firstTs: details.length ? details[0].ts : null,
    lastTs: details.length ? details[details.length - 1].ts : null,
  };
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function renderPage(stats, recent) {
  const groups = stats.requestGroups.map((g) => {
    const passReasons = Object.entries(g.passReasons).sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${esc(reason)} (${count})`).join(", ");
    return `<tr><td>${esc(g.experimentId || "—")}</td><td>${esc(g.version || "—")}</td>
      <td>${esc(g.group)}</td><td>${g.samples}</td><td>${g.applied} (${(100 * g.applyRate).toFixed(1)}%)</td>
      <td>${g.modelCalls}</td><td>${g.p95Ms} ms</td><td>${passReasons || "—"}</td></tr>`;
  }).join("");
  const reasons = Object.entries(stats.reasonTop)
    .map(([r, n]) => `<tr><td>${esc(r)}</td><td>${n}</td></tr>`)
    .join("");
  const actions = Object.entries(stats.actionCounts)
    .map(([a, n]) => `<span class="chip">${esc(a)} <b>${n}</b></span>`)
    .join("");
  const rows = recent
    .map(
      (e) => `<tr>
      <td>${esc(new Date(e.ts).toLocaleString())}</td>
      <td>${esc(e.agent)}</td>
      <td>${esc(e.action)}</td>
      <td>${esc(e.reason)}</td>
      <td>${e.inputChars ?? ""}/${e.outputChars ?? ""}</td>
    </tr>`,
    )
    .join("");
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>prompt-optimizer stats</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 ui-monospace, monospace; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; background: #16181d; color: #d7dae0; }
  h1 { font-size: 1.2rem; } h2 { font-size: 1rem; margin-top: 1.5rem; color: #9fb0c6; }
  .chips { display: flex; flex-wrap: wrap; gap: .4rem; }
  .chip { background: #242830; border-radius: 4px; padding: .15rem .5rem; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  td, th { border: 1px solid #2c313a; padding: .25rem .5rem; text-align: left; }
  th { color: #9fb0c6; position: sticky; top: 0; background: #16181d; }
  .kpis { display: flex; gap: 2rem; } .kpi b { font-size: 1.4rem; }
</style></head><body>
<h1>prompt-optimizer-magpie · stats</h1>
<h2>Eligible requests by group</h2>
<table><thead><tr><th>Experiment</th><th>Version</th><th>Group</th><th>Requests</th><th>Applied</th>
<th>Model calls</th><th>Hook p95</th><th>Pass reasons (count)</th></tr></thead>
<tbody>${groups || "<tr><td colspan=8>No request summaries yet</td></tr>"}</tbody></table>
<h2>Detailed events</h2>
<div class="kpis">
  <div class="kpi"><b>${stats.total}</b><br>detail events</div>
  <div class="kpi"><b>${stats.optimizeDuration.p50 ?? "–"} ms</b><br>optimize p50</div>
  <div class="kpi"><b>${stats.optimizeDuration.p95 ?? "–"} ms</b><br>optimize p95</div>
</div>
<h2>Actions</h2><div class="chips">${actions || "–"}</div>
<h2>Reason Top ${Object.keys(stats.reasonTop).length}</h2>
<table><tr><th>reason</th><th>count</th></tr>${reasons || "<tr><td colspan=2>–</td></tr>"}</table>
<h2>Recent ${recent.length} detailed events</h2>
<table><tr><th>ts</th><th>agent</th><th>action</th><th>reason</th><th>in/out</th></tr>${rows}</table>
</body></html>`;
}

function canonicalHost(host) {
  if (!host.includes(":")) return host.toLowerCase();
  // IPv6 interface addresses can carry a local zone ID; HTTP literals cannot.
  try { return new URL(`http://[${host.split("%", 1)[0]}]`).hostname.slice(1, -1); }
  catch { return ""; }
}

const loopback = new Set(["127.0.0.1", "localhost", "::1"]);

function hostAllowed(authority, bind) {
  const match = /^(?:\[([a-f\d:.]+)\]|([a-z\d.-]+))(?::(\d+))?$/i.exec(authority || "");
  if (!match || Number(match[3]) > 65535 || (match[1] && !match[1].includes(":"))) return false;
  const host = canonicalHost(match[1] || match[2]);
  if (loopback.has(host)) return true;
  if (!host || loopback.has(canonicalHost(bind))) return false;
  for (const list of Object.values(os.networkInterfaces())) {
    if (list?.some(({ address }) => canonicalHost(address) === host)) return true;
  }
  return false;
}

// The HTTP server. Identical endpoints from both entry points:
//   /            stats page (HTML)
//   /api/stats   aggregate JSON
//   /api/recent  last n events (1..500)
export function makeStatsServer({ statsDir, recentDefault = 50, bind = "127.0.0.1", retainDays = process.env.POM_RETAIN_DAYS ?? 7 } = {}) {
  const STATS = statsDir || join(ROOT, "stats");
  const RECENT_DEFAULT = recentDefault;
  const server = createServer((req, res) => {
    if (!hostAllowed(req.headers.host, bind)) {
      res.writeHead(403, { "content-type": "text/plain", "cache-control": "no-store" });
      return res.end("forbidden host");
    }
    const send = (code, body, type) => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    let url;
    try { url = new URL(req.url, "http://127.0.0.1"); }
    catch { return send(400, "invalid request URL", "text/plain"); }
    if (url.pathname === "/api/recent") {
      // clamp n to 1..500; NaN/garbage → default, never a crash
      let n = parseInt(url.searchParams.get("n") ?? "", 10);
      if (!Number.isFinite(n)) n = RECENT_DEFAULT;
      n = Math.max(1, Math.min(500, n));
      const events = readEvents(STATS);
      return send(200, JSON.stringify(events.slice(-n)), "application/json");
    }
    if (url.pathname === "/api/stats") {
      return send(200, JSON.stringify(aggregate(readEvents(STATS))), "application/json");
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "method not allowed", "text/plain");
    if (url.pathname === "/") {
      const events = readEvents(STATS);
      return send(200, renderPage(aggregate(events), events.filter((e) => e.action !== "summary").slice(-RECENT_DEFAULT)), "text/html; charset=utf-8");
    }
    return send(404, "not found", "text/plain");
  });
  server.once("listening", () => {
    let days = String(retainDays).trim() === "" ? NaN : Number(retainDays);
    if (!Number.isFinite(days) || (days > 0 && !Number.isFinite(new Date(Date.now() - days * 86400_000).getTime()))) {
      console.warn(`stats: invalid POM_RETAIN_DAYS="${retainDays}", falling back to 7`);
      days = 7;
    }
    if (days <= 0) return;
    const runPrune = () => {
      const removed = prune(days, Date.now(), STATS);
      if (removed) console.log(`stats: pruned ${removed} day-file(s) older than ${days}d`);
    };
    runPrune();
    const timer = setInterval(runPrune, 86400_000);
    timer.unref();
    server.once("close", () => clearInterval(timer));
  });
  return server;
}

// Is a stats service already answering on this port? (reuse probe —
// page-usage-tree pattern: never kill or double-serve; if an instance of us
// is alive, the page reaches it either way.)
function probeStatsService(port, bind) {
  const host = canonicalHost(bind);
  const hostname = host === "::" ? "::1" : host === "0.0.0.0" ? "127.0.0.1" : bind;
  return new Promise((resolve) => {
    const req = get({ hostname, port, path: "/api/stats" }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("error", () => resolve(false));
      res.on("end", () => {
        try {
          const j = JSON.parse(body);
          resolve(typeof j?.total === "number");
        } catch {
          resolve(false);
        }
      });
    });
    req.on("error", () => resolve(false));
    req.setTimeout(500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

// startStatsService: bind `bind`:port (default 127.0.0.1, 0 = ephemeral). On
// EADDRINUSE, probe: if an existing stats service answers, reuse it (close()
// is a no-op) instead of failing — the host contract only needs *a* live
// service on the manifest port. Otherwise retry same port 16×100ms, then
// throw. Only the listening server starts its retention timer.
export async function startStatsService({ port = 3497, statsDir, recentDefault, bind = "127.0.0.1", retainDays } = {}) {
  const server = makeStatsServer({ statsDir, recentDefault, bind, retainDays });
  for (let attempt = 0; ; attempt++) {
    try {
      server.listen(port, bind);
      await once(server, "listening");
      const { port: bound } = server.address();
      return {
        port: bound,
        reused: false,
        close: () => new Promise((r) => server.close(r)),
      };
    } catch (error) {
      if (error?.code !== "EADDRINUSE") {
        server.close();
        throw error;
      }
      if (await probeStatsService(port, bind)) {
        return { port, reused: true, close: async () => {} };
      }
      if (attempt >= 15) {
        server.close();
        throw new Error(`startStatsService: port ${port} busy and no stats service answers`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

