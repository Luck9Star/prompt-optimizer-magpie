// The host part of the plugin (page-usage-tree pattern): magpie's plugin host
// loads this entry when the stats page opens and asks for `server()`. The
// service runs inside the host process, so it stops when magpie stops the
// plugin — no extra daemon needed for the in-app page. The systemd instance
// (serve.mjs direct) stays for headless 70: both only read the stats
// day-files, and a port clash between them resolves via serve's
// retry+fallback. Retention (prune) runs inside startStatsService, so this
// in-app path prunes too.
import { startStatsService } from "./lib/stats-service.mjs";

let started = null;

export default {
  id: "prompt-optimizer-magpie",
  server: async (_input, options) => {
    if (!started) {
      started = startStatsService({
        // options.port: magpie.page.service.option "port" in package.json;
        // 0 = ephemeral — `|| 3497` would silently swallow it.
        port: Number.isFinite(Number(options?.port)) ? Number(options.port) : 3497,
        // options.bind: LAN opt-in ("0.0.0.0" / a NIC address). Default
        // 127.0.0.1 — stats day-files carry clipped prompt text.
        bind: typeof options?.bind === "string" && options.bind ? options.bind : "127.0.0.1",
      }).catch((error) => {
        started = null;
        throw error;
      });
    }
    await started;
    return {};
  },
};
