// Smoke tests for the PaperTab Markdown renderer. Run: node scripts/test.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert";

const here = dirname(fileURLToPath(import.meta.url));
const { renderMarkdown } = await import(join(here, "..", "src", "markdown.js"));
const { THEMES, resolveTheme } = await import(join(here, "..", "src", "themes.js"));
const { FONTS, resolveFont } = await import(join(here, "..", "src", "fonts.js"));
const { FONT_SIZES, resolveFontSize } = await import(join(here, "..", "src", "font-sizes.js"));
const { matchBlockTrigger, matchEnterTrigger, matchInlineTrigger, matchTaskBracket, matchSlashCommand } = await import(
  join(here, "..", "src", "live-markdown.js")
);

let pass = 0;

// headings
{
  assert.strictEqual(renderMarkdown("# Hello"), "<h1>Hello</h1>");
  assert.strictEqual(renderMarkdown("### Level 3"), "<h3>Level 3</h3>");
  pass++;
}

// bold, italic, strikethrough, inline code
{
  assert.strictEqual(renderMarkdown("**bold**"), "<p><strong>bold</strong></p>");
  assert.strictEqual(renderMarkdown("*italic*"), "<p><em>italic</em></p>");
  assert.strictEqual(renderMarkdown("~~gone~~"), "<p><del>gone</del></p>");
  assert.strictEqual(renderMarkdown("`code`"), "<p><code>code</code></p>");
  pass++;
}

// fenced code block is left verbatim (not run through inline formatting)
{
  const html = renderMarkdown("```js\nlet *x* = 1;\n```");
  assert.strictEqual(html, '<pre><code class="language-js">let *x* = 1;</code></pre>');
  pass++;
}

// unordered, ordered, and task lists
{
  assert.strictEqual(renderMarkdown("- a\n- b"), "<ul>\n<li>a</li>\n<li>b</li>\n</ul>");
  assert.strictEqual(renderMarkdown("1. a\n2. b"), "<ol>\n<li>a</li>\n<li>b</li>\n</ol>");
  const html = renderMarkdown("- [ ] todo\n- [x] done");
  assert.ok(html.includes('<input type="checkbox" disabled> todo'));
  assert.ok(html.includes('<input type="checkbox" disabled checked> done'));
  pass++;
}

// blockquote and horizontal rule
{
  assert.strictEqual(renderMarkdown("> quoted"), "<blockquote><p>quoted</p></blockquote>");
  assert.strictEqual(renderMarkdown("---"), "<hr>");
  pass++;
}

// GFM pipe tables: header + separator + body rows, and a header-only table.
{
  const withBody = renderMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |");
  assert.strictEqual(
    withBody,
    "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>"
  );
  const headerOnly = renderMarkdown("| A | B |\n| --- | --- |");
  assert.strictEqual(headerOnly, "<table><thead><tr><th>A</th><th>B</th></tr></thead></table>");
  assert.strictEqual(renderMarkdown("just | a pipe, no separator"), "<p>just | a pipe, no separator</p>");
  pass++;
}

// links: safe scheme allowed, javascript: scheme rejected (left as plain text)
{
  const safe = renderMarkdown("[go](https://example.com)");
  assert.strictEqual(safe, '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">go</a></p>');
  const unsafe = renderMarkdown("[go](javascript:alert(1))");
  assert.ok(!unsafe.includes("<a "), "javascript: links must not be rendered as anchors");
  pass++;
}

// bare URL autolinking
{
  const html = renderMarkdown("see https://example.com for more");
  assert.ok(html.includes('<a href="https://example.com"'));
  pass++;
}

// raw HTML in notes is escaped, never executed
{
  const html = renderMarkdown("<script>alert(1)</script>");
  assert.ok(!html.includes("<script>"), "raw HTML must be escaped");
  assert.ok(html.includes("&lt;script&gt;"));
  pass++;
}

// soft line breaks within a paragraph become <br>
{
  const html = renderMarkdown("line one\nline two");
  assert.strictEqual(html, "<p>line one<br>line two</p>");
  pass++;
}

// blank line separates paragraphs
{
  const html = renderMarkdown("first\n\nsecond");
  assert.strictEqual(html, "<p>first</p>\n<p>second</p>");
  pass++;
}

// theme resolution: explicit picks win, "system" follows the OS media query,
// and unknown/missing preferences fall back to light.
{
  assert.strictEqual(resolveTheme("dark", false), "dark");
  assert.strictEqual(resolveTheme("system", true), "dark");
  assert.strictEqual(resolveTheme("system", false), "light");
  assert.strictEqual(resolveTheme("bogus", true), "light");
  assert.ok(THEMES.every((t) => t.id && t.label && t.paper && t.accent));
  pass++;
}

// font resolution: explicit picks win, unknown/missing preferences fall back to serif.
{
  assert.strictEqual(resolveFont("mono"), "mono");
  assert.strictEqual(resolveFont("bogus"), "serif");
  assert.strictEqual(resolveFont(undefined), "serif");
  assert.ok(FONTS.every((f) => f.id && f.label && f.family));
  pass++;
}

// font-size resolution: explicit picks win, unknown/missing preferences fall back to medium.
{
  assert.strictEqual(resolveFontSize("large"), "large");
  assert.strictEqual(resolveFontSize("bogus"), "medium");
  assert.strictEqual(resolveFontSize(undefined), "medium");
  assert.ok(FONT_SIZES.every((f) => f.id && f.label && f.size));
  pass++;
}

// live editor: block markers fire on the trailing space, and only when the
// whole block matches (i.e. typed before any other content, like Notion).
{
  assert.deepStrictEqual(matchBlockTrigger("# "), { block: "heading", level: 1 });
  assert.deepStrictEqual(matchBlockTrigger("### "), { block: "heading", level: 3 });
  assert.strictEqual(matchBlockTrigger("####### "), null, "7 hashes is not a heading");
  assert.deepStrictEqual(matchBlockTrigger("- "), { block: "bullet" });
  assert.deepStrictEqual(matchBlockTrigger("* "), { block: "bullet" });
  assert.deepStrictEqual(matchBlockTrigger("1. "), { block: "ordered" });
  assert.deepStrictEqual(matchBlockTrigger("42. "), { block: "ordered" });
  assert.deepStrictEqual(matchBlockTrigger("> "), { block: "quote" });
  assert.deepStrictEqual(matchBlockTrigger("- [ ] "), { block: "task", checked: false });
  assert.deepStrictEqual(matchBlockTrigger("- [x] "), { block: "task", checked: true });
  assert.deepStrictEqual(matchBlockTrigger("- [] "), { block: "task", checked: false });
  assert.strictEqual(matchBlockTrigger("hello "), null);
  pass++;
}

// live editor: code fences and horizontal rules fire on Enter instead of space.
{
  assert.deepStrictEqual(matchEnterTrigger("```"), { block: "code", lang: "" });
  assert.deepStrictEqual(matchEnterTrigger("```js"), { block: "code", lang: "js" });
  assert.deepStrictEqual(matchEnterTrigger("---"), { block: "hr" });
  assert.deepStrictEqual(matchEnterTrigger("***"), { block: "hr" });
  assert.strictEqual(matchEnterTrigger("--"), null);
  assert.strictEqual(matchEnterTrigger("hello"), null);
  pass++;
}

// live editor: inline markers fire the instant the closing delimiter completes.
{
  assert.deepStrictEqual(matchInlineTrigger("**bold**"), { start: 0, end: 8, tags: ["strong"], content: "bold" });
  assert.deepStrictEqual(matchInlineTrigger("***both***"), {
    start: 0,
    end: 10,
    tags: ["strong", "em"],
    content: "both",
  });
  const italic = matchInlineTrigger("hi *there*");
  assert.deepStrictEqual(italic, { start: 3, end: 10, tags: ["em"], content: "there" });
  assert.deepStrictEqual(matchInlineTrigger("~~gone~~"), { start: 0, end: 8, tags: ["del"], content: "gone" });
  assert.deepStrictEqual(matchInlineTrigger("`code`"), { start: 0, end: 6, tags: ["code"], content: "code" });
  assert.deepStrictEqual(matchInlineTrigger("__bold__"), { start: 0, end: 8, tags: ["strong"], content: "bold" });
  assert.deepStrictEqual(matchInlineTrigger("_italic_"), { start: 0, end: 8, tags: ["em"], content: "italic" });
  assert.deepStrictEqual(matchInlineTrigger("[go](https://example.com)"), {
    start: 0,
    end: 25,
    tags: ["a"],
    content: "go",
    href: "https://example.com",
  });
  assert.strictEqual(matchInlineTrigger("[go](javascript:evil)"), null, "unsafe link schemes don't convert");
  assert.strictEqual(matchInlineTrigger("just text"), null);
  pass++;
}

// live editor: a plain bullet retroactively becomes a task when its content
// is exactly "[ ]"/"[x]"/"[]" (see matchTaskBracket's comment for why).
{
  assert.deepStrictEqual(matchTaskBracket("[ ]"), { checked: false });
  assert.deepStrictEqual(matchTaskBracket("[x]"), { checked: true });
  assert.deepStrictEqual(matchTaskBracket("[]"), { checked: false });
  assert.strictEqual(matchTaskBracket("[ ] extra"), null);
  assert.strictEqual(matchTaskBracket("plain"), null);
  pass++;
}

// live editor: "/table" is the only slash command, checked on Enter.
{
  assert.deepStrictEqual(matchSlashCommand("/table"), { command: "table" });
  assert.strictEqual(matchSlashCommand("/tabl"), null);
  assert.strictEqual(matchSlashCommand("/table "), null);
  assert.strictEqual(matchSlashCommand("plain"), null);
  pass++;
}

console.log(`✓ all ${pass} PaperTab assertions passed`);
