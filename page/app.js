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
  (async () => {
    let port = FALLBACK_PORT;
    let service = "";
    try {
      await new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = "./_magpie/bridge.js";
        s.onload = res;
        s.onerror = () => rej(new Error("bridge failed to load"));
        document.head.appendChild(s);
      });
      await window.magpie?.ready; // rejects outside a magpie frame — degrade
      const opts = await window.magpie?.options?.get?.();
      const v = Number(opts?.port);
      if (Number.isInteger(v) && v > 0 && v < 65536) port = v;
      const s = window.magpie?.service;
      if (typeof s === "string" && /^https?:\/\//.test(s)) service = s;
    } catch { /* stay on defaults */ }
    const host = location.hostname || "127.0.0.1";
    location.replace(service || `http://${host}:${port}/`);
    clearTimeout(timer);
  })();
})();
