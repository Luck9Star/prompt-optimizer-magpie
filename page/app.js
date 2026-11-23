// External script (the sandbox CSP blocks inline ones). The stats UI is
// reached through magpie's same-origin service proxy: one navigation to
// ./_magpie/service/ relative to the plugin page. The browser never
// connects to the stats port directly (loopback-only by default).
(() => {
  location.replace("./_magpie/service/");
})();
