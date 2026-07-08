// Tab -> text formatters for TabCopy.
// Each formatter receives an array of {title, url} tab objects (optionally
// grouped by window) and returns a single string ready for the clipboard.

// The list of supported "Copy as" formats, in display order.
export const FORMATS = [
  "URL",
  "Title: URL",
  "Title & URL",
  "Title",
  "Markdown",
  "BBCode",
  "CSV",
  "JSON",
  "HTML",
  "HTML table",
];

function esc(str) {
  return String(str ?? "");
}

function csvCell(value) {
  const s = esc(value);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function htmlEsc(value) {
  return esc(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Format a flat list of tabs. `windows` is only used by window-aware output.
function formatFlat(format, tabs) {
  switch (format) {
    case "URL":
      return tabs.map((t) => t.url).join("\n");
    case "Title: URL":
      return tabs.map((t) => `${t.title}: ${t.url}`).join("\n");
    case "Title & URL":
      return tabs.map((t) => `${t.title}\n${t.url}`).join("\n\n");
    case "Title":
      return tabs.map((t) => t.title).join("\n");
    case "Markdown":
      return tabs.map((t) => `[${t.title}](${t.url})`).join("\n");
    case "BBCode":
      return tabs.map((t) => `[url=${t.url}]${t.title}[/url]`).join("\n");
    case "CSV":
      return (
        "title,url\n" +
        tabs.map((t) => `${csvCell(t.title)},${csvCell(t.url)}`).join("\n")
      );
    case "JSON":
      return JSON.stringify(
        tabs.map((t) => ({ title: t.title, url: t.url })),
        null,
        2
      );
    case "HTML":
      return tabs
        .map((t) => `<a href="${htmlEsc(t.url)}">${htmlEsc(t.title)}</a>`)
        .join("\n");
    case "HTML table":
      return (
        "<table>\n  <tr><th>Title</th><th>URL</th></tr>\n" +
        tabs
          .map(
            (t) =>
              `  <tr><td>${htmlEsc(t.title)}</td><td><a href="${htmlEsc(
                t.url
              )}">${htmlEsc(t.url)}</a></td></tr>`
          )
          .join("\n") +
        "\n</table>"
      );
    default:
      return tabs.map((t) => t.url).join("\n");
  }
}

// Format tabs grouped by window. `groups` is an array of {name, tabs}.
export function formatGroups(format, groups) {
  if (groups.length === 1) return formatFlat(format, groups[0].tabs);

  // JSON gets a real nested structure; everything else gets labelled blocks.
  if (format === "JSON") {
    return JSON.stringify(
      groups.map((g) => ({
        window: g.name,
        tabs: g.tabs.map((t) => ({ title: t.title, url: t.url })),
      })),
      null,
      2
    );
  }

  return groups
    .map((g) => `# ${g.name}\n${formatFlat(format, g.tabs)}`)
    .join("\n\n");
}

export function formatTabs(format, tabs) {
  return formatFlat(format, tabs);
}
