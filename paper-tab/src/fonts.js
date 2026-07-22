// Pure font config + resolution logic for PaperTab, shared by the newtab
// page and the test harness.

export const FONTS = [
  { id: "serif", label: "Serif", family: 'Georgia, "Iowan Old Style", serif' },
  { id: "elegant", label: "Elegant", family: '"Palatino Linotype", Palatino, "Book Antiqua", serif' },
  { id: "classic", label: "Classic", family: '"Times New Roman", Times, serif' },
  { id: "sans", label: "Sans", family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' },
  { id: "rounded", label: "Rounded", family: 'ui-rounded, "SF Pro Rounded", "Segoe UI", sans-serif' },
  { id: "mono", label: "Mono", family: '"SF Mono", Menlo, Consolas, monospace' },
  { id: "casual", label: "Casual", family: '"Bradley Hand", "Segoe Print", cursive' },
];

const FONT_IDS = new Set(FONTS.map((f) => f.id));

export function resolveFont(preference) {
  return FONT_IDS.has(preference) ? preference : "serif";
}
