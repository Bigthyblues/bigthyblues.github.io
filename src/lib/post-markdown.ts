export const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const renderInlineMarkdown = (value: string) => {
  let html = escapeHtml(value);
  html = html.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.*?)\*/g, "<em>$1</em>");
  html = html.replace(/`(.*?)`/g, "<code>$1</code>");
  html = html.replace(/\[hex=(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}))\]([\s\S]*?)\[\/hex\]/g, '<span class="md-hex" style="color: $1;">$2</span>');
  html = html.replace(/\[bg=(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}))\]([\s\S]*?)\[\/bg\]/g, '<span class="md-bg-custom" style="background-color: $1;">$2</span>');
  html = html.replace(/\[bg=([a-z0-9-]+)\]([\s\S]*?)\[\/bg\]/g, '<span class="md-bg md-bg-$1">$2</span>');
  html = html.replace(/\[color=([a-z0-9-]+)\]([\s\S]*?)\[\/color\]/g, '<span class="md-color md-color-$1">$2</span>');
  html = html.replace(/\[size=(small|large|xl)\]([\s\S]*?)\[\/size\]/g, '<span class="md-size-$1">$2</span>');
  html = html.replace(/\[center\]([\s\S]*?)\[\/center\]/g, '<span class="md-center">$1</span>');
  html = html.replace(/\[mark\]([\s\S]*?)\[\/mark\]/g, '<span class="md-mark">$1</span>');
  html = html.replace(/\[del\]([\s\S]*?)\[\/del\]/g, "<del>$1</del>");
  html = html.replace(/\[box\]([\s\S]*?)\[\/box\]/g, '<span class="md-box">$1</span>');
  html = html.replace(/!\[(.*?)\]\((.*?)\)/g, '<img src="$2" alt="$1" loading="lazy" decoding="async" data-image-component="manual" />');
  html = html.replace(/\[(.*?)\]\((.*?)\)/g, (_match, label: string, url: string) => {
    const safeUrl = safeMarkdownUrl(url);
    return safeUrl ? `<a href="${escapeHtml(safeUrl)}">${label}</a>` : `<span class="fanart-link-label">${label}</span>: <span class="fanart-link-note">${escapeHtml(url)}</span>`;
  });
  return html;
};

const splitTableRow = (line: string) => {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
};

const getTableAlignments = (line: string) => {
  const cells = splitTableRow(line);
  if (!cells.length || cells.some((cell) => !/^:?-{3,}:?$/.test(cell))) return null;
  return cells.map((cell) => cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "left");
};

export const renderPostBody = (markdown: string) => {
  const lines = markdown.split("\n");
  const html: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([^\s`~]+)?\s*$/);

    if (fence) {
      const marker = fence[1][0];
      const minimumFenceLength = fence[1].length;
      const language = fence[2]?.trim() ?? "";
      const codeLines: string[] = [];
      const closingFence = new RegExp(`^\\s*${marker}{${minimumFenceLength},}\\s*$`);

      index += 1;
      while (index < lines.length && !closingFence.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }

      const languageAttribute = language ? ` data-language="${escapeHtml(language)}"` : "";
      html.push(`<div class="md-code-block"${languageAttribute}><pre tabindex="0"><code>${escapeHtml(codeLines.join("\n"))}</code></pre></div>`);
      continue;
    }

    const alignments = index + 1 < lines.length && line.includes("|") ? getTableAlignments(lines[index + 1]) : null;

    if (alignments) {
      const headers = splitTableRow(line);
      const columnCount = headers.length;
      const bodyRows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        bodyRows.push(splitTableRow(lines[index]));
        index += 1;
      }
      index -= 1;

      const renderCell = (cell: string, cellIndex: number, tag: "th" | "td") =>
        `<${tag} class="md-table-align-${alignments[cellIndex] ?? "left"}">${renderInlineMarkdown(cell ?? "")}</${tag}>`;
      const headerHtml = headers.map((cell, cellIndex) => renderCell(cell, cellIndex, "th")).join("");
      const rowsHtml = bodyRows.map((row) => `<tr>${Array.from({ length: columnCount }, (_, cellIndex) => renderCell(row[cellIndex] ?? "", cellIndex, "td")).join("")}</tr>`).join("");
      html.push(`<div class="md-table-scroll" tabindex="0"><table><thead><tr>${headerHtml}</tr></thead>${rowsHtml ? `<tbody>${rowsHtml}</tbody>` : ""}</table></div>`);
      continue;
    }

    if (line.startsWith("### ")) html.push(`<h5>${renderInlineMarkdown(line.slice(4))}</h5>`);
    else if (line.startsWith("## ")) html.push(`<h4>${renderInlineMarkdown(line.slice(3))}</h4>`);
    else if (line.startsWith("# ")) html.push(`<h3>${renderInlineMarkdown(line.slice(2))}</h3>`);
    else if (line.startsWith("> ")) html.push(`<blockquote>${renderInlineMarkdown(line.slice(2))}</blockquote>`);
    else if (line.startsWith("- ")) html.push(`<p>&bull; ${renderInlineMarkdown(line.slice(2))}</p>`);
    else if (line.trim() !== "") html.push(`<p>${renderInlineMarkdown(line)}</p>`);
  }

  return html.join("");
};

const safeMarkdownUrl = (value: string) => {
  const trimmed = value.trim();
  return /^(https?:\/\/|mailto:|\/|#)/i.test(trimmed) ? trimmed : "";
};

