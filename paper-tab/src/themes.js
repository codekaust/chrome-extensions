// Pure theme config + resolution logic for PaperTab, shared by the newtab
// page and the test harness.

export const THEMES = [
  { id: "light", label: "Light", paper: "#fbf7ee", accent: "#c1603a" },
  { id: "sepia", label: "Sepia", paper: "#f0e2c8", accent: "#a8552d" },
  { id: "dark", label: "Dark", paper: "#1c1913", accent: "#e0854f" },
  { id: "forest", label: "Forest", paper: "#17231d", accent: "#d98a52" },
  { id: "slate", label: "Slate", paper: "#1b2027", accent: "#e0854f" },
];

const THEME_IDS = new Set(THEMES.map((t) => t.id));

// preference is "system" or a THEMES id; prefersDark reflects the OS media query.
export function resolveTheme(preference, prefersDark) {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return THEME_IDS.has(preference) ? preference : "light";
}
