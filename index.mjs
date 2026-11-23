// The host part of the plugin (page-usage-tree pattern): magpie's plugin host
// loads this entry when the stats page opens and asks for `server()`. The
// service runs inside the host process, so it stops when magpie stops the
// plugin — no extra daemon needed for the in-app page. The systemd instance
// (serve.mjs direct) stays for headless 70: both only read the stats
// day-files, and a port clash between them resolves via serve's
// retry+fallback. Retention (prune) runs inside startStatsService, so this
// in-app path prunes too.
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startStatsService } from "./lib/stats-service.mjs";
import { resolveStatsDir, migrateLegacyStats } from "./lib/stats.mjs";

const PAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "page");

let started = null;

export default {
  id: "prompt-optimizer-magpie",
  server: async (_input, options) => {
    if (!started) {
      // One-shot: bring package-internal legacy stats/ over (survives updates).
      if (migrateLegacyStats()) console.log("pom: migrated legacy stats/ to " + resolveStatsDir());
      started = startStatsService({
        statsDir: resolveStatsDir(),
        // options.port: magpie.page.service.option "port" in package.json;
        // 0 = ephemeral — `|| 27497` would silently swallow it.
        port: Number.isFinite(Number(options?.port)) ? Number(options.port) : 27497,
        // options.bind: default 127.0.0.1 — the browser goes through
        // magpie's same-origin proxy, so LAN exposure is never needed;
        // stats day-files carry clipped prompt text.
        bind: typeof options?.bind === "string" && options.bind ? options.bind : "127.0.0.1",
        // options.configPage: enable the /?page=config sub-page (default off).
        options: { configPage: options?.configPage === true },
      }).then((svc) => {
        // The page no longer reads port.js (same-origin proxy navigation),
        // but the host may probe it and serve.mjs dev mode uses it; keep
        // publishing the actual bound port for those readers.
        try {
          writeFileSync(join(PAGE_DIR, "port.js"), `window.__POM_PORT__ = ${svc.port};\n`);
        } catch { /* read-only install: no reader left, harmless */ }
        return svc;
      }).catch((error) => {
        started = null;
        throw error;
      });
    }
    const svc = await started;
    // The return value is the plugin's hooks object: hosts read only known
    // keys, so `port` is ignored today but already correct if a future host
    // forwards it (design §6.2a).
    return { port: svc.port };
  },
};

// test-only: stop the singleton service (page/port.js stays behind, stale).
// Exported as an OBJECT on purpose: magpie calls every exported FUNCTION as a
// plugin (docs FAQ), so a function export here would be invoked by the host.
export const __testHooks = { close: () => started?.then((s) => s.close()).catch(() => {}) };
