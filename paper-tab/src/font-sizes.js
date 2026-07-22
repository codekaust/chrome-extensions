// Pure font-size config + resolution logic for PaperTab, shared by the
// newtab page and the test harness.

export const FONT_SIZES = [
  { id: "small", label: "S", size: "15px" },
  { id: "medium", label: "M", size: "17px" },
  { id: "large", label: "L", size: "19px" },
  { id: "xlarge", label: "XL", size: "22px" },
];

const FONT_SIZE_IDS = new Set(FONT_SIZES.map((f) => f.id));

export function resolveFontSize(preference) {
  return FONT_SIZE_IDS.has(preference) ? preference : "medium";
}
