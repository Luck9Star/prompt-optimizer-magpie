// The host part of the plugin (page-usage-tree pattern): magpie's plugin host
// loads this entry when the stats page opens and asks for `server()`. The
// service runs inside the host process, so it stops when magpie stops the
// plugin — no extra daemon needed for the in-app page. The systemd instance
// (serve.mjs direct) stays for headless 70: both only read stats.ndjson, and
// a port clash between them resolves via serve's retry+fallback.
import { startStatsService } from "./lib/stats-service.mjs";

let started = null;

export default {
  id: "prompt-optimizer-magpie",
  server: async (_input, options) => {
    if (!started) {
      started = startStatsService({
        // options.port: magpie.page.service.option "port" in package.json
        port: Number(options?.port) || 3497,
      }).catch((error) => {
        started = null;
        throw error;
      });
    }
    await started;
    return {};
  },
};
