// Smoke tests for TabCopy formatters. Run: node scripts/test.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert";

const here = dirname(fileURLToPath(import.meta.url));
const { FORMATS, formatGroups } = await import(join(here, "..", "popup", "formats.js"));

const tabs = [
  { title: "Example", url: "https://example.com" },
  { title: 'Comma, "quote"', url: "https://a.test/x?y=1" },
];
const g1 = [{ name: "W1", tabs }];

let pass = 0;
function eq(actual, expected, label) {
  assert.strictEqual(actual, expected, label);
  pass++;
}

eq(formatGroups("URL", g1), "https://example.com\nhttps://a.test/x?y=1", "URL");
eq(formatGroups("Title", g1), 'Example\nComma, "quote"', "Title");
eq(formatGroups("Title: URL", g1), 'Example: https://example.com\nComma, "quote": https://a.test/x?y=1', "Title: URL");
eq(formatGroups("Markdown", g1), "[Example](https://example.com)\n[Comma, \"quote\"](https://a.test/x?y=1)", "Markdown");
eq(formatGroups("BBCode", g1), "[url=https://example.com]Example[/url]\n[url=https://a.test/x?y=1]Comma, \"quote\"[/url]", "BBCode");
eq(
  formatGroups("CSV", g1),
  'title,url\nExample,https://example.com\n"Comma, ""quote""",https://a.test/x?y=1',
  "CSV quoting"
);
assert.deepStrictEqual(JSON.parse(formatGroups("JSON", g1)), [
  { title: "Example", url: "https://example.com" },
  { title: 'Comma, "quote"', url: "https://a.test/x?y=1" },
]);
pass++;

// HTML escaping
assert.ok(formatGroups("HTML", g1).includes("&quot;"), "HTML escapes quotes");
assert.ok(formatGroups("HTML table", g1).includes("<table>"), "HTML table wrapper");
pass += 2;

// Multi-window grouping (non-JSON => labelled blocks)
const g2 = [
  { name: "Window 1", tabs: [tabs[0]] },
  { name: "Window 2", tabs: [tabs[1]] },
];
const md = formatGroups("Markdown", g2);
assert.ok(md.includes("# Window 1") && md.includes("# Window 2"), "grouped headers");
pass++;

// JSON grouping keeps nesting
const nested = JSON.parse(formatGroups("JSON", g2));
assert.strictEqual(nested.length, 2, "nested windows");
assert.strictEqual(nested[0].window, "Window 1");
pass++;

// Every declared format produces a string
for (const f of FORMATS) assert.strictEqual(typeof formatGroups(f, g1), "string", `format ${f}`);
pass++;

console.log(`✓ all ${pass} TabCopy assertions passed`);
