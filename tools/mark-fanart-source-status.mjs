import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const postsDir = resolve(process.cwd(), "src/content/posts");

async function listMarkdown(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) continue;
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
  }
  return files;
}

const readField = (frontmatter, key) => {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
};

const sourceStatusForPost = (frontmatter) => {
  const artist = readField(frontmatter, "fanartArtist").toLowerCase();
  const date = readField(frontmatter, "date").slice(0, 10);
  const sourceUrl = readField(frontmatter, "fanartSourceUrl");

  if (artist.includes("jaydengunn09")) return "Deleted";
  if (artist.includes("soliasroscura") && date && date <= "2025-05-13") return "Deleted";
  if (artist.includes("superwolko2004") && /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(sourceUrl)) {
    return "Sometimes unavailable";
  }

  return "";
};

const upsertSourceStatus = (frontmatter, status) => {
  if (/^fanartSourceStatus:/m.test(frontmatter)) {
    return frontmatter.replace(/^fanartSourceStatus:\s*.*$/m, `fanartSourceStatus: "${status}"`);
  }

  if (/^fanartSourceUrl:/m.test(frontmatter)) {
    return frontmatter.replace(/^(fanartSourceUrl:\s*.*)$/m, `$1\nfanartSourceStatus: "${status}"`);
  }

  return `${frontmatter.trimEnd()}\nfanartSourceStatus: "${status}"`;
};

let changed = 0;
for (const file of await listMarkdown(postsDir)) {
  const source = await readFile(file, "utf8");
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) continue;

  const status = sourceStatusForPost(match[1]);
  if (!status) continue;

  const nextFrontmatter = upsertSourceStatus(match[1], status).replace(/^fanartArtistStatus:\s*["']?Deleted["']?\r?\n/m, "");
  const next = `---\n${nextFrontmatter}\n---\n${match[2]}`;
  if (next !== source) {
    await writeFile(file, next, "utf8");
    console.log(file);
    changed += 1;
  }
}

console.log(`Marked ${changed} fanart source statuses.`);
