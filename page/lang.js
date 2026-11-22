// Same-dir static script (sandbox CSP allows these, not inline ones).
// Sets <html data-lang> from the bridge theme lang, falling back to
// navigator.language, then re-syncs whenever the theme changes.
// The server already renders data-lang (zh default, or ?lang=en override),
// so this only refines the choice when the client knows better.
(() => {
  const apply = (lang) => {
    if (lang === "en" || lang === "zh") document.documentElement.dataset.lang = lang;
  };
  const fromNav = () => apply((navigator.language || "zh").toLowerCase().startsWith("en") ? "en" : "zh");
  const t = window.magpie && window.magpie.theme;
  if (t && t.lang) apply(t.lang); else fromNav();
  // ?lang=zh|en was rendered server-side; an explicit override should win
  // over the theme for this page view.
  try {
    const q = new URLSearchParams(location.search).get("lang");
    if (q === "zh" || q === "en") apply(q);
  } catch { /* never mind */ }
  if (window.magpie && typeof window.magpie.onTheme === "function") {
    window.magpie.onTheme((next) => {
      const q = new URLSearchParams(location.search).get("lang");
      if (q === "zh" || q === "en") return; // explicit override sticks
      apply(next && next.lang);
    });
  }
})();
