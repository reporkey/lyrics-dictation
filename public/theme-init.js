/* global document, localStorage, matchMedia */

(() => {
  let stored = null;
  try {
    stored = localStorage.getItem("lyrics-dictation:theme");
  } catch {
    // Storage can be unavailable under browser privacy policies.
  }
  const theme =
    stored === "light" || stored === "dark"
      ? stored
      : matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const color = theme === "dark" ? "#131915" : "#f5f3ee";
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", color);
})();
