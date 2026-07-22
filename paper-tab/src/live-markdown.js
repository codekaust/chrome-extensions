// Pure pattern-matchers behind PaperTab's Notion-style live editing: typing
// a Markdown marker converts the current block/run immediately, the way
// Notion, Typora, etc. do it — no separate "preview" step.
import { isSafeUrl } from "./markdown.js";

// Chrome's contenteditable inserts a non-breaking space instead of a plain
// one at the end of a text run, so triggers must treat the two as equal.
function normalizeSpaces(text) {
  return text.replace(/ /g, " ");
}

// Block-level markers that fire the instant the trailing space is typed.
// `text` is the full plain-text content of the block being edited so far.
export function matchBlockTrigger(rawText) {
  const text = normalizeSpaces(rawText);
  const heading = text.match(/^(#{1,6}) $/);
  if (heading) return { block: "heading", level: heading[1].length };

  const task = text.match(/^[-*] \[([ xX]?)\] $/);
  if (task) return { block: "task", checked: /x/i.test(task[1]) };

  if (/^[-*] $/.test(text)) return { block: "bullet" };

  const ordered = text.match(/^(\d+)\. $/);
  if (ordered) return { block: "ordered" };

  if (/^> $/.test(text)) return { block: "quote" };

  return null;
}

// A plain bullet item retroactively becomes a task the instant its content
// is exactly "[ ]"/"[x]"/"[]" — "- " already converted the line to a bullet
// before "[" could be part of the same block-trigger match (see convertBlock's
// comment on the two-stage task detection).
export function matchTaskBracket(text) {
  const m = text.match(/^\[([ xX]?)\]$/);
  return m ? { checked: /x/i.test(m[1]) } : null;
}

// Block-level markers that fire on Enter instead of space (nothing to type
// after them on the same line).
export function matchEnterTrigger(text) {
  const fence = text.match(/^```(\S*)$/);
  if (fence) return { block: "code", lang: fence[1] };

  if (/^(-{3}|\*{3}|_{3})$/.test(text)) return { block: "hr" };

  return null;
}

// Slash commands, checked on Enter alongside matchEnterTrigger. Only
// "/table" is supported today; the shape leaves room for more later.
export function matchSlashCommand(text) {
  if (text === "/table") return { command: "table" };
  return null;
}

// Inline markers that fire the instant the closing delimiter is typed.
// `text` is the plain text of the current run up to and including the
// caret; a match must end exactly at the end of `text`.
export function matchInlineTrigger(text) {
  const boldItalicStar = text.match(/\*\*\*([^*\n]+)\*\*\*$/);
  if (boldItalicStar) return span(boldItalicStar, ["strong", "em"]);
  const boldItalicUnder = text.match(/___([^_\n]+)___$/);
  if (boldItalicUnder) return span(boldItalicUnder, ["strong", "em"]);

  const boldStar = text.match(/\*\*([^*\n]+)\*\*$/);
  if (boldStar) return span(boldStar, ["strong"]);
  const boldUnder = text.match(/__([^_\n]+)__$/);
  if (boldUnder) return span(boldUnder, ["strong"]);

  const strike = text.match(/~~([^~\n]+)~~$/);
  if (strike) return span(strike, ["del"]);

  const code = text.match(/`([^`\n]+)`$/);
  if (code) return span(code, ["code"]);

  const italicStar = text.match(/(?<=^|[^*])\*([^*\n]+)\*$/);
  if (italicStar) return span(italicStar, ["em"]);
  const italicUnder = text.match(/(?<=^|[^_])_([^_\n]+)_$/);
  if (italicUnder) return span(italicUnder, ["em"]);

  const link = text.match(/\[([^[\]\n]+)\]\(([^()\s]+)\)$/);
  if (link && isSafeUrl(link[2])) {
    return { start: link.index, end: text.length, tags: ["a"], content: link[1], href: link[2] };
  }

  return null;
}

function span(match, tags) {
  return { start: match.index, end: match.index + match[0].length, tags, content: match[1] };
}
