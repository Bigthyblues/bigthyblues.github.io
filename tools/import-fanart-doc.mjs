import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const item = process.argv[index];
  if (!item.startsWith("--")) continue;
  const key = item.slice(2);
  const next = process.argv[index + 1];
  if (!next || next.startsWith("--")) {
    args.set(key, "true");
  } else {
    args.set(key, next);
    index += 1;
  }
}

const input = args.get("input") ?? "\u6570\u636e/allcharactersintro.docx.html";
const imageRoot = args.get("image-root") ?? "\u6570\u636e/images";
const outDir = args.get("out") ?? "src/content/posts";
const publicMediaDir = args.get("public-media") ?? "public/img/gallery/fanart";
const publicMediaUrl = args.get("public-media-url") ?? "/img/gallery/fanart";
const dryRun = args.get("dry-run") === "true";

function decodeEntities(value) {
  return String(value ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function unwrapGoogleUrl(value) {
  const decoded = decodeEntities(value);
  try {
    const url = new URL(decoded);
    if (url.hostname === "www.google.com" && url.pathname === "/url") {
      return url.searchParams.get("q") ?? decoded;
    }
    return decoded;
  } catch {
    return decoded;
  }
}

function stripTags(value) {
  return decodeEntities(
    String(value ?? "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]*>/g, "")
  )
    .replace(/\u202a|\u202c/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getLinks(value) {
  const links = [];
  const pattern = /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(value))) {
    links.push({
      href: unwrapGoogleUrl(match[1]),
      text: stripTags(match[2])
    });
  }
  return links;
}

function getImages(value) {
  const images = [];
  const pattern = /<img\b[^>]*src="([^"]*)"[^>]*>/gi;
  let match;
  while ((match = pattern.exec(value))) images.push(decodeEntities(match[1]));
  return [...new Set(images)];
}

function splitCells(rowHtml) {
  const cells = [];
  const pattern = /<td\b[^>]*>[\s\S]*?<\/td>/gi;
  let match;
  while ((match = pattern.exec(rowHtml))) cells.push(match[0]);
  return cells;
}

function slugify(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "fanart";
}

function yamlString(value) {
  return `"${String(value ?? "").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function parseDate(value) {
  const match = String(value).match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/);
  if (!match) return null;
  const [, year, month, day] = match;
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    iso: `${year}-${pad(month)}-${pad(day)}T12:00:00+08:00`,
    file: `${year}-${pad(month)}-${pad(day)}`
  };
}

function existingFilenames(files) {
  return new Set(files.filter((file) => file.endsWith(".md")).map((file) => basename(file)));
}

async function existingFanartSources(rootDir) {
  const sources = new Set();
  let files = [];
  try {
    files = await readdir(rootDir, { recursive: true });
  } catch {
    return sources;
  }

  for (const file of files) {
    if (typeof file !== "string" || !file.endsWith(".md")) continue;
    try {
      const source = await readFile(resolve(rootDir, file), "utf8");
      const match = source.match(/^fanartSourceUrl:\s*["\']?([^"\'\r\n]+)["\']?\s*$/m);
      if (match) sources.add(match[1].trim());
    } catch {
      // Ignore unreadable files and keep importing the rest.
    }
  }

  return sources;
}

function makeUniqueFilename(existing, base) {
  let name = `${base}.md`;
  let counter = 2;
  while (existing.has(name)) {
    name = `${base}-${counter}.md`;
    counter += 1;
  }
  existing.add(name);
  return name;
}

function titleCaseFallback(value) {
  return value || "Fanart";
}

const html = await readFile(resolve(input), "utf8");
const rows = [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)].map((match) => match[0]);
const entries = [];

for (const row of rows) {
  const cells = splitCells(row);
  if (cells.length !== 4) continue;

  const imageSources = getImages(cells[0]);
  const date = parseDate(stripTags(cells[2]));
  if (imageSources.length === 0 || !date) continue;

  const creditLinks = getLinks(cells[1]);
  const resourceLinks = getLinks(cells[3]);
  const artistName = titleCaseFallback(creditLinks[0]?.text || stripTags(cells[1]).split("\n")[0]?.trim());
  const resourceText = stripTags(cells[3]);
  const resourceTitle = titleCaseFallback(resourceLinks[0]?.text || resourceText.split("\n")[0]?.trim());

  entries.push({
    imageSources,
    artistName,
    artistUrl: creditLinks[0]?.href ?? "",
    title: resourceTitle,
    sourceUrl: resourceLinks[0]?.href ?? "",
    date,
    resourceText
  });
}

if (!dryRun) {
  await mkdir(outDir, { recursive: true });
  await mkdir(publicMediaDir, { recursive: true });
}

const existing = existingFilenames(await readdir(outDir, { recursive: true }));
const existingSources = await existingFanartSources(outDir);
const imported = [];
const skippedExisting = [];
const missing = [];

for (const entry of entries) {
  if (entry.sourceUrl && existingSources.has(entry.sourceUrl)) {
    skippedExisting.push(entry.sourceUrl);
    continue;
  }

  const slug = `fanart-${entry.date.file}-${slugify(entry.artistName)}-${slugify(entry.title)}`;
  if (!entry.sourceUrl && existing.has(`${slug}.md`)) {
    skippedExisting.push(slug);
    continue;
  }

  const filename = makeUniqueFilename(existing, slug);
  const fileSlug = filename.replace(/\.md$/, "");
  const copiedImages = [];

  for (let index = 0; index < entry.imageSources.length; index += 1) {
    const source = entry.imageSources[index];
    const sourcePath = resolve(imageRoot, basename(source));
    const extension = extname(sourcePath).toLowerCase() || ".jpg";
    const destinationName = `${fileSlug}${index === 0 ? "" : `-${index + 1}`}${extension}`;
    const destinationPath = resolve(publicMediaDir, destinationName);

    try {
      if (!dryRun) await copyFile(sourcePath, destinationPath);
      copiedImages.push(`${publicMediaUrl}/${destinationName}`);
    } catch {
      missing.push(source);
    }
  }

  if (copiedImages.length === 0) continue;

  const body = [
    `Fanart by ${entry.artistName}.`,
    entry.sourceUrl ? `[Original source](${entry.sourceUrl})` : "",
    entry.artistUrl ? `[Artist profile](${entry.artistUrl})` : "",
    entry.resourceText && entry.resourceText !== entry.title ? entry.resourceText : ""
  ].filter(Boolean).join("\n\n");

  const lines = [
    "---",
    `title: ${yamlString(entry.title)}`,
    'author: "blues"',
    'character: "Blues"',
    'type: "fanart"',
    `date: ${entry.date.iso}`
  ];
  if (copiedImages.length === 1) lines.push(`image: ${yamlString(copiedImages[0])}`);
  if (copiedImages.length > 1) lines.push(`images: [${copiedImages.map(yamlString).join(", ")}]`);
  lines.push(`excerpt: ${yamlString(`Fanart by ${entry.artistName}.`)}`);
  if (entry.sourceUrl) lines.push(`fanartSourceUrl: ${yamlString(entry.sourceUrl)}`);
  lines.push(`fanartArtist: ${yamlString(entry.artistName)}`);
  if (entry.artistUrl) lines.push(`fanartArtistUrl: ${yamlString(entry.artistUrl)}`);
  lines.push("draft: false");
  lines.push("---");

  if (!dryRun) await writeFile(resolve(outDir, filename), `${lines.join("\n")}\n\n${body}\n`, "utf8");
  imported.push(filename);
  if (entry.sourceUrl) existingSources.add(entry.sourceUrl);
}

const review = [
  "# Fanart Import Review",
  "",
  `Imported posts: ${imported.length}`,
  `Rows parsed: ${entries.length}`,
  `Missing images: ${missing.length}`,
  `Skipped existing: ${skippedExisting.length}`,
  "",
  ...imported.map((file) => `- \`${file}\``)
].join("\n");

if (!dryRun) await writeFile(resolve(dirname(input), "fanart-import-review.md"), review, "utf8");

console.log(`Parsed ${entries.length} fanart rows.`);
console.log(`Imported ${imported.length} fanart posts.`);
console.log(`Missing images: ${missing.length}.`);
console.log(`Skipped existing: ${skippedExisting.length}.`);
console.log(`Review file: ${resolve(dirname(input), "fanart-import-review.md")}`);
