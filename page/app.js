// External script (the sandbox CSP blocks inline scripts). It loads the
// bridge (served beside this page) to answer magpie's hello handshake, then
// lands the frame on the service URL through the gateway proxy — same origin
// as the UI, so the page works from any machine the UI is open on.
(() => {
  const FALLBACK_PORT = 3497;
  const said = document.getElementById("said");
  // If the navigation target exists the frame is replaced and this timer
  // never fires — it is purely the "service not running" hint.
  const timer = setTimeout(() => {
    said.textContent =
      "统计服务未启动：请在插件 options 设 port，或在插件目录运行 node serve.mjs。";
  }, 2500);
  const load = (src) =>
    new Promise((res) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = res;
      s.onerror = res; // a missing file is fine: fixed-port installs have no port.js
      document.head.appendChild(s);
    });
(async () => {
    // server() writes port.js beside this file once bound (port 0
    // auto-select): same-dir script loads pass the sandbox CSP, and it is
    // the plugin's own source of truth. The host's hello.service falls
    // back to the manifest port when the option is 0, so the bridge
    // service URL and options.port only apply when port.js gave nothing.
    await load("./port.js");
    const v = Number(window.__POM_PORT__);
    const runtime = Number.isInteger(v) && v > 0 && v < 65536 ? v : 0;
    let port = runtime || FALLBACK_PORT;
    let service = "";
    try {
      await load("./_magpie/bridge.js");
      await window.magpie?.ready; // rejects outside a magpie frame — degrade
      if (!runtime) {
        const s = window.magpie?.service;
        if (typeof s === "string" && /^https?:\/\//.test(s)) service = s;
        const opts = await window.magpie?.options?.get?.();
        const p = Number(opts?.port);
        if (!service && Number.isInteger(p) && p > 0 && p < 65536) port = p;
      }
    } catch { /* stay on defaults */ }
    const host = location.hostname || "127.0.0.1";
    location.replace(service || `http://${host}:${port}/`);
    clearTimeout(timer);
  })();
})();
