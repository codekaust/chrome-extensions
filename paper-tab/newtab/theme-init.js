// Applied synchronously, before first paint, to avoid a flash of the
// wrong theme/font/size. newtab.js reconciles this against
// chrome.storage.local (the source of truth) once it loads.
// Extracted to its own file (rather than an inline <script>) because MV3's
// default extension-page CSP is `script-src 'self'` with no 'unsafe-inline' —
// an inline script is silently blocked, so this must load via `src=` instead.
(function () {
  var themePref = localStorage.getItem("themePreference") || "system";
  var prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  var theme = themePref === "system" ? (prefersDark ? "dark" : "light") : themePref;
  if (theme !== "light") document.documentElement.dataset.theme = theme;

  var font = localStorage.getItem("fontPreference") || "serif";
  if (font !== "serif") document.documentElement.dataset.font = font;

  var size = localStorage.getItem("fontSizePreference") || "medium";
  if (size !== "medium") document.documentElement.dataset.size = size;
})();
