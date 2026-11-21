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
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { readEvents, prune } from "./stats.mjs";

import { get } from "node:http";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i];
}

export function aggregate(events) {
  const actionCounts = {};
  const reasonTop = {};
  for (const e of events) {
    const a = e.action || "unknown";
    actionCounts[a] = (actionCounts[a] || 0) + 1;
    const r = e.reason || "unknown";
    reasonTop[r] = (reasonTop[r] || 0) + 1;
  }
  // p50/p95 over optimize-action events, wall-clock from onRequest entry —
  // includes gates + decider call (up to deciderTimeoutMs), not just the rewrite
  const durs = events
    .filter((e) => e.action === "optimize" && typeof e.durationMs === "number")
    .map((e) => e.durationMs)
    .sort((x, y) => x - y);
  return {
    total: events.length,
    actionCounts,
    reasonTop: Object.fromEntries(Object.entries(reasonTop).sort((a, b) => b[1] - a[1]).slice(0, 10)),
    optimizeDuration: { count: durs.length, p50: percentile(durs, 50), p95: percentile(durs, 95) },
    firstTs: events.length ? events[0].ts : null,
    lastTs: events.length ? events[events.length - 1].ts : null,
  };
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function renderPage(stats, recent) {
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
<div class="kpis">
  <div class="kpi"><b>${stats.total}</b><br>events</div>
  <div class="kpi"><b>${stats.optimizeDuration.p50 ?? "–"} ms</b><br>optimize p50</div>
  <div class="kpi"><b>${stats.optimizeDuration.p95 ?? "–"} ms</b><br>optimize p95</div>
</div>
<h2>Actions</h2><div class="chips">${actions || "–"}</div>
<h2>Reason Top ${Object.keys(stats.reasonTop).length}</h2>
<table><tr><th>reason</th><th>count</th></tr>${reasons || "<tr><td colspan=2>–</td></tr>"}</table>
<h2>Recent ${recent.length} events</h2>
<table><tr><th>ts</th><th>agent</th><th>action</th><th>reason</th><th>in/out</th></tr>${rows}</table>
</body></html>`;
}

// Host[:port] → hostname, IPv6-literal aware ("[::1]:3497" → "::1").
function hostName(req) {
  const h = req.headers.host || "";
  const i = h.lastIndexOf(":");
  if (i === -1) return h;
  if (h.startsWith("[")) return h.slice(1, h.indexOf("]")); // "[::1]:3497" → "::1"
  return h.slice(0, i);
}

// DNS-rebinding guard: stats events carry truncated user prompt text
// (orig). A rebinding page hits us with its own domain in Host — only names
// belonging to the bind address may read stats. Loopback bind → loopback
// names; non-loopback bind (LAN opt-in) → every address on this machine's
// interfaces, still never a foreign domain.
function hostAllowed(req, bind) {
  const host = hostName(req);
  if (bind !== "127.0.0.1" && bind !== "localhost" && bind !== "::1") {
    for (const list of Object.values(networkInterfaces())) {
      for (const ni of list || []) if (host === ni.address) return true;
    }
  }
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

// The HTTP server. Identical endpoints from both entry points:
//   /            stats page (HTML)
//   /api/stats   aggregate JSON
//   /api/recent  last n events (1..500)
export function makeStatsServer({ statsDir, recentDefault = 50, bind = "127.0.0.1" } = {}) {
  const STATS = statsDir || join(ROOT, "stats");
  const RECENT_DEFAULT = recentDefault;
  return createServer((req, res) => {
    if (!hostAllowed(req, bind)) {
      res.writeHead(403, { "content-type": "text/plain", "cache-control": "no-store" });
      return res.end("forbidden host");
    }
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (code, body, type) => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
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
      return send(200, renderPage(aggregate(events), events.slice(-RECENT_DEFAULT)), "text/html; charset=utf-8");
    }
    return send(404, "not found", "text/plain");
  });
}

// Is a stats service already answering on this port? (reuse probe —
// page-usage-tree pattern: never kill or double-serve; if an instance of us
// is alive, the page reaches it either way.)
function probeStatsService(port) {
  return new Promise((resolve) => {
    const req = get(`http://127.0.0.1:${port}/api/stats`, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
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
// throw. Retention runs here (startup + daily) so both entry points (index.mjs
// host process and serve.mjs) prune; POM_RETAIN_DAYS: default 7, 0/negative =
// keep forever (explicit opt-out), invalid → 7 (silent 0 would disable
// cleanup and let the disk grow without bound).
export async function startStatsService({ port = 3497, statsDir, recentDefault, bind = "127.0.0.1", retainDays } = {}) {
  const STATS = statsDir || join(ROOT, "stats");
  const RAW_RETAIN = retainDays ?? Number(process.env.POM_RETAIN_DAYS ?? 7);
  const RETAIN = Number.isFinite(RAW_RETAIN) ? RAW_RETAIN : 7;
  const runPrune = () => {
    if (RETAIN <= 0) return;
    const n = prune(RETAIN, Date.now(), STATS);
    if (n > 0) console.log(`stats: pruned ${n} day-file(s) older than ${RETAIN}d`);
  };
  runPrune();
  const timer = setInterval(runPrune, 86400_000);
  timer.unref?.(); // timer must not keep the loop alive — the socket does
  const server = makeStatsServer({ statsDir, recentDefault, bind });
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, bind, resolve);
      });
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
      if (await probeStatsService(port)) {
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

