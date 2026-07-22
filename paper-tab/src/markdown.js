// Pure, dependency-free Markdown -> HTML renderer for PaperTab.
// Every text run is HTML-escaped before any tag is added, so raw notes can
// never inject markup, and only whitelisted link schemes become anchors.

const SAFE_SCHEMES = /^(https?:|mailto:)/i;
const STASH_OPEN = "\u0001";
const STASH_CLOSE = "\u0002";
const STASH_RE = /\u0001(\d+)\u0002/g;

// Whitelists http(s)/mailto and same-document relative links; rejects
// javascript:/data: and anything else that could execute on click.
export function isSafeUrl(url) {
  return /^[#\/]/.test(url) || SAFE_SCHEMES.test(url);
}

export function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInline(rawText) {
  const stash = [];
  const stashOf = (html) => {
    stash.push(html);
    return STASH_OPEN + (stash.length - 1) + STASH_CLOSE;
  };

  let text = escapeHtml(rawText);

  // Inline code spans first, so their contents are immune to further parsing.
  text = text.replace(/`([^`]+)`/g, (_, code) => stashOf(`<code>${code}</code>`));

  // Markdown links — validate the scheme before turning it into an <a>.
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, url) => {
    if (!isSafeUrl(url)) return whole;
    return stashOf(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  });

  // Bare URLs autolink too.
  text = text.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, lead, url) =>
    `${lead}${stashOf(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)}`
  );

  text = text
    .replace(/\*\*\*([^*]+)\*\*\*|___([^_]+)___/g, (_, a, b) => `<strong><em>${a ?? b}</em></strong>`)
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\s][^_]*)_(?!_)/g, "$1<em>$2</em>");

  return text.replace(STASH_RE, (_, index) => stash[Number(index)]);
}

function closeList(ctx) {
  if (ctx.list) {
    ctx.out.push(`</${ctx.list}>`);
    ctx.list = null;
  }
}

// GFM pipe-table row: strips optional outer pipes, splits on the rest.
function splitTableRow(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableSeparatorRow(line) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

export function renderMarkdown(src) {
  const lines = (src ?? "").split("\n");
  const out = [];
  const ctx = { out, list: null };

  let i = 0;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${renderInline(paragraph.join("\n")).replace(/\n/g, "<br>")}</p>`);
      paragraph = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block — content is escaped but never run through inline formatting.
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      flushParagraph();
      closeList(ctx);
      const lang = fence[1];
      const code = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      const cls = lang ? ` class="language-${lang}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(code.join("\n"))}</code></pre>`);
      i++; // skip closing fence
      continue;
    }

    // Blank line.
    if (/^\s*$/.test(line)) {
      flushParagraph();
      closeList(ctx);
      i++;
      continue;
    }

    // Heading.
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      closeList(ctx);
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      closeList(ctx);
      out.push("<hr>");
      i++;
      continue;
    }

    // Blockquote.
    if (/^>\s?/.test(line)) {
      flushParagraph();
      closeList(ctx);
      const quoted = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote><p>${renderInline(quoted.join("\n")).replace(/\n/g, "<br>")}</p></blockquote>`);
      continue;
    }

    // Table (GFM pipe syntax): a header row immediately followed by a
    // "| --- | --- |"-style separator row, then zero or more body rows.
    if (line.includes("|") && i + 1 < lines.length && isTableSeparatorRow(lines[i + 1])) {
      flushParagraph();
      closeList(ctx);
      const headerCells = splitTableRow(line);
      i += 2;
      const bodyRows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        bodyRows.push(splitTableRow(lines[i]));
        i++;
      }
      const thead = `<thead><tr>${headerCells.map((cell) => `<th>${renderInline(cell)}</th>`).join("")}</tr></thead>`;
      const tbody = bodyRows.length
        ? `<tbody>${bodyRows
            .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`)
            .join("")}</tbody>`
        : "";
      out.push(`<table>${thead}${tbody}</table>`);
      continue;
    }

    // Task list item.
    const task = line.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (task) {
      flushParagraph();
      if (ctx.list !== "ul") {
        closeList(ctx);
        out.push('<ul class="task-list">');
        ctx.list = "ul";
      }
      const checked = task[1].toLowerCase() === "x";
      out.push(
        `<li class="task-item"><input type="checkbox" disabled${checked ? " checked" : ""}> ${renderInline(task[2])}</li>`
      );
      i++;
      continue;
    }

    // Unordered list item.
    const bullet = line.match(/^[-*+]\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      if (ctx.list !== "ul") {
        closeList(ctx);
        out.push("<ul>");
        ctx.list = "ul";
      }
      out.push(`<li>${renderInline(bullet[1])}</li>`);
      i++;
      continue;
    }

    // Ordered list item.
    const ordered = line.match(/^\d+\.\s+(.*)$/);
    if (ordered) {
      flushParagraph();
      if (ctx.list !== "ol") {
        closeList(ctx);
        out.push("<ol>");
        ctx.list = "ol";
      }
      out.push(`<li>${renderInline(ordered[1])}</li>`);
      i++;
      continue;
    }

    // Plain paragraph text.
    closeList(ctx);
    paragraph.push(line);
    i++;
  }

  flushParagraph();
  closeList(ctx);

  return out.join("\n");
}
