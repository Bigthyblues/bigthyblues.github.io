import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import sharp from "sharp";

const root = resolve(process.cwd());
const apply = process.argv.includes("--apply");
const yearArgIndex = process.argv.indexOf("--year");
const year = yearArgIndex >= 0 ? Number.parseInt(process.argv[yearArgIndex + 1], 10) : 2024;
if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error(`Invalid --year value: ${process.argv[yearArgIndex + 1]}`);
const tweetsPath = join(root, "数据", "twitter导出", "tweets.js");
const archiveMediaRoot = join(root, "数据", "twitter导出", "tweets_media");
const originalsRoot = join(root, "原件");
const postsRoot = join(root, "src", "content", "posts");
const publicMediaRoot = join(root, "public", "img", "gallery", "imported", String(year));
const publicMediaUrl = `/img/gallery/imported/${year}`;
const reportPath = join(root, ".tmp", `twitter-${year}-import.json`);

const pad = (value) => String(value).padStart(2, "0");
const yamlString = (value) => `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function mapLimit(items, limit, fn) {
  const result = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      result[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return result;
}

function stripWrapper(source) {
  return source.slice(source.indexOf("[")).replace(/;\s*$/, "");
}

function tweetMedia(tweet) {
  // extended_entities carries the authoritative media kind. Mixing it with
  // entities would incorrectly treat video thumbnails as additional photos.
  const media = tweet.extended_entities?.media ?? tweet.entities?.media ?? [];
  const seen = new Set();
  return media.filter((item) => {
    const key = `${item.id_str ?? item.media_url_https}:${item.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function localDate(tweet) {
  return new Date(new Date(tweet.created_at).getTime() + 8 * 60 * 60 * 1000);
}

function dateMinute(date) {
  return date.toISOString().slice(0, 16);
}

function formatDate(date) {
  return `${date.toISOString().slice(0, 19)}+08:00`;
}

function filenameDate(date) {
  return `${date.toISOString().slice(0, 10)}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`;
}

function cleanText(text) {
  return String(text ?? "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/(^|\s)#[^\s#]+/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizedText(text) {
  return cleanText(text).toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function titleFor(text, date) {
  const firstLine = cleanText(text).split("\n").map((line) => line.trim()).find(Boolean);
  return (firstLine || `Twitter Post ${date.getUTCFullYear()}.${date.getUTCMonth() + 1}.${date.getUTCDate()}`).slice(0, 90);
}

function slugify(text) {
  return text.toLocaleLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "twitter-post";
}

async function existingPostIndex() {
  const dates = new Set();
  const idTails = new Set();
  const imagePaths = new Set();
  const files = (await readdir(postsRoot)).filter((name) => name.endsWith(".md"));
  for (const file of files) {
    const idTail = file.match(/-(\d{6})\.md$/)?.[1];
    if (idTail) idTails.add(idTail);
    const content = await readFile(join(postsRoot, file), "utf8");
    const date = content.match(/^date:\s*([^\r\n]+)/m)?.[1];
    if (date) dates.add(date.slice(0, 16));
    if (file.startsWith(`${year}-`)) {
      for (const match of content.matchAll(/\/img\/gallery\/[^"']+?\.(?:png|jpe?g)/gi)) {
        imagePaths.add(join(root, "public", match[0].replace(/^\//, "")));
      }
    }
  }
  return { dates, idTails, imagePaths };
}

function mediaStem(item) {
  return basename(new URL(item.media_url_https ?? item.media_url).pathname, extname(new URL(item.media_url_https ?? item.media_url).pathname));
}

async function findArchiveMedia(tweet, item, archiveFiles) {
  const prefix = `${tweet.id_str}-`;
  const stem = mediaStem(item).toLocaleLowerCase();
  const expectedExtension = item.type === "photo" ? null : ".mp4";
  const candidates = archiveFiles.filter((path) => {
    const name = basename(path);
    return name.startsWith(prefix) && (!expectedExtension || extname(name).toLocaleLowerCase() === expectedExtension);
  });
  return candidates.find((path) => basename(path).toLocaleLowerCase().includes(stem)) ?? candidates[0] ?? null;
}

async function imageSignature(path) {
  const image = sharp(path, { failOn: "none" }).rotate();
  const metadata = await image.metadata();
  const width = metadata.autoOrient?.width ?? metadata.width ?? 0;
  const height = metadata.autoOrient?.height ?? metadata.height ?? 0;
  const pixels = await image
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb")
    .resize(48, 48, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .removeAlpha()
    .raw()
    .toBuffer();
  return { path, width, height, ratio: width / height, pixels };
}

function imageDistance(a, b) {
  let squared = 0;
  for (let index = 0; index < a.length; index += 1) {
    const difference = a[index] - b[index];
    squared += difference * difference;
  }
  return Math.sqrt(squared / a.length) / 255;
}

async function fileHash(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

const raw = await readFile(tweetsPath, "utf8");
const tweets = JSON.parse(stripWrapper(raw)).map((item) => item.tweet ?? item);
const archiveFiles = await walk(archiveMediaRoot);
const existing = await existingPostIndex();

const candidates = tweets.filter((tweet) => {
  const date = localDate(tweet);
  return date.getUTCFullYear() === year
    && !tweet.retweeted
    && !String(tweet.full_text ?? "").startsWith("RT @")
    && !tweet.in_reply_to_status_id_str
    && tweetMedia(tweet).length > 0
    && tweetMedia(tweet).every((item) => item.type === "photo");
});

const missing = candidates.filter((tweet) => {
  const date = localDate(tweet);
  return !existing.dates.has(dateMinute(date)) && !existing.idTails.has(String(tweet.id_str).slice(-6));
});

const prepared = [];
for (const tweet of missing) {
  const media = [];
  for (const item of tweetMedia(tweet)) {
    const archivePath = await findArchiveMedia(tweet, item, archiveFiles);
    media.push({ item, archivePath, hash: archivePath ? await fileHash(archivePath) : null });
  }
  prepared.push({ tweet, date: localDate(tweet), media });
}

// Drop exact repeated exports only when both their cleaned text and media bytes agree.
const dedupeKeys = new Set();
const unique = prepared.sort((a, b) => a.date - b.date).filter(({ tweet, media }) => {
  const key = `${normalizedText(tweet.full_text)}|${media.map((item) => item.hash).join(",")}`;
  if (dedupeKeys.has(key)) return false;
  dedupeKeys.add(key);
  return true;
});

const originalFiles = (await walk(originalsRoot)).filter((path) => extname(path).toLocaleLowerCase() === ".png");
const existingImageFiles = [];
for (const path of existing.imagePaths) {
  try {
    if ((await stat(path)).isFile()) existingImageFiles.push(path);
  } catch {
    // A broken pre-existing reference should not block importing unrelated media.
  }
}
const neededArchiveImages = [...new Set(unique.flatMap(({ media }) => media
  .filter(({ item, archivePath }) => item.type === "photo" && archivePath)
  .map(({ archivePath }) => archivePath)))];

console.log(`Reading ${neededArchiveImages.length} archive images, ${originalFiles.length} original PNG files, and ${existingImageFiles.length} existing post images...`);
const [archiveSignatures, originalSignatures, existingImageSignatures] = await Promise.all([
  mapLimit(neededArchiveImages, 8, async (path) => {
    try { return await imageSignature(path); } catch { return null; }
  }),
  mapLimit(originalFiles, 8, async (path) => {
    try { return await imageSignature(path); } catch { return null; }
  }),
  mapLimit(existingImageFiles, 8, async (path) => {
    try { return await imageSignature(path); } catch { return null; }
  })
]);
const validArchiveSignatures = archiveSignatures.filter(Boolean);
const validOriginalSignatures = originalSignatures.filter(Boolean);
const validExistingImageSignatures = existingImageSignatures.filter(Boolean);
const archiveSignatureMap = new Map(validArchiveSignatures.map((item) => [item.path, item]));

const results = [];
for (const { tweet, date, media } of unique) {
  const title = titleFor(tweet.full_text, date);
  const slug = `${filenameDate(date)}-${slugify(title)}-${String(tweet.id_str).slice(-6)}`;
  const resolvedMedia = [];
  let reliable = true;

  for (let index = 0; index < media.length; index += 1) {
    const { item, archivePath } = media[index];
    if (!archivePath) {
      resolvedMedia.push({ kind: item.type, error: "missing archive media" });
      reliable = false;
      continue;
    }
    if (item.type !== "photo") {
      resolvedMedia.push({ kind: "video", source: archivePath, score: 0 });
      continue;
    }

    const target = archiveSignatureMap.get(archivePath);
    if (!target) {
      resolvedMedia.push({ kind: "image", error: "unreadable archive image", accepted: false });
      reliable = false;
      continue;
    }
    const matches = validOriginalSignatures
      .filter((candidate) => Math.abs(Math.log(target.ratio / candidate.ratio)) <= 0.012)
      .map((candidate) => ({ source: candidate.path, score: imageDistance(target.pixels, candidate.pixels) }))
      .sort((a, b) => a.score - b.score);
    const best = matches[0];
    const second = matches[1];
    const accepted = best && best.score <= 0.075;
    resolvedMedia.push({
      kind: "image",
      source: best?.source,
      score: best?.score,
      secondScore: second?.score,
      accepted
    });
    if (!accepted) reliable = false;
  }

  results.push({ tweet, date, title, slug, resolvedMedia, reliable });
}

// Custom-curated posts do not always retain the tweet ID or exact publish
// minute. Treat a candidate as already present when every original image is
// visually represented by an existing post from the selected year.
const duplicateExistingMedia = [];
const seenOriginalSets = new Set();
const deduplicatedResults = [];
for (const result of results) {
  if (!result.reliable) {
    deduplicatedResults.push(result);
    continue;
  }
  const sourceSignatures = result.resolvedMedia
    .filter((media) => media.kind === "image")
    .map((media) => validOriginalSignatures.find((signature) => signature.path === media.source));
  const allAlreadyUsed = sourceSignatures.length > 0 && sourceSignatures.every((source) => validExistingImageSignatures.some((existingImage) =>
    Math.abs(Math.log(source.ratio / existingImage.ratio)) <= 0.012
      && imageDistance(source.pixels, existingImage.pixels) <= 0.075
  ));
  const sourceSet = result.resolvedMedia
    .filter((media) => media.kind === "image")
    .map((media) => media.source)
    .sort()
    .join("|");
  if (allAlreadyUsed || seenOriginalSets.has(sourceSet)) {
    duplicateExistingMedia.push({ result, reason: allAlreadyUsed ? "already-used-by-existing-post" : "duplicate-image-set-in-export" });
    continue;
  }
  seenOriginalSets.add(sourceSet);
  deduplicatedResults.push(result);
}

if (apply) {
  await mkdir(publicMediaRoot, { recursive: true });
  for (const result of deduplicatedResults.filter((item) => item.reliable)) {
    const images = [];
    let video = "";
    for (let index = 0; index < result.resolvedMedia.length; index += 1) {
      const media = result.resolvedMedia[index];
      if (media.kind === "image") {
        const name = `${result.slug}${images.length ? `-${images.length + 1}` : ""}.png`;
        await copyFile(media.source, join(publicMediaRoot, name));
        images.push(`${publicMediaUrl}/${name}`);
      } else if (media.kind === "video" && !video) {
        const name = `${result.slug}-video.mp4`;
        await copyFile(media.source, join(publicMediaRoot, name));
        video = `${publicMediaUrl}/${name}`;
      }
    }

    const frontmatter = [
      "---",
      `title: ${yamlString(result.title)}`,
      'author: "blues"',
      'character: "Blues"',
      `type: "${video ? "video" : "image"}"`,
      `date: ${formatDate(result.date)}`
    ];
    if (images.length === 1) frontmatter.push(`image: ${yamlString(images[0])}`);
    if (images.length > 1) frontmatter.push(`images: [${images.map(yamlString).join(", ")}]`);
    if (video) frontmatter.push(`video: ${yamlString(video)}`);
    const body = cleanText(result.tweet.full_text) || result.title;
    frontmatter.push(`excerpt: ${yamlString(body.slice(0, 140))}`, "draft: true", "---");
    await writeFile(
      join(postsRoot, `${result.slug}.md`),
      `${frontmatter.join("\n")}\n\n${body}\n`,
      "utf8"
    );
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  applied: apply,
  timezone: "Asia/Shanghai (+08:00)",
  range: `${year}-01-01T00:00:00+08:00 through ${year}-12-31T23:59:59+08:00`,
  counts: {
    eligibleTweets: candidates.length,
    existingTweets: candidates.length - missing.length,
    missingTweets: missing.length,
    exactDuplicatesDropped: prepared.length - unique.length,
    duplicateImagePostsDropped: duplicateExistingMedia.length,
    reliableImports: deduplicatedResults.filter((item) => item.reliable).length,
    unresolvedImports: deduplicatedResults.filter((item) => !item.reliable).length
  },
  imported: deduplicatedResults.filter((item) => item.reliable).map((item) => ({
    id: item.tweet.id_str,
    date: formatDate(item.date),
    file: `src/content/posts/${item.slug}.md`,
    title: item.title,
    media: item.resolvedMedia.map((media) => ({
      kind: media.kind,
      source: media.source ? relative(root, media.source).replaceAll("\\", "/") : null,
      score: media.score
    }))
  })),
  duplicates: duplicateExistingMedia.map(({ result, reason }) => ({
    id: result.tweet.id_str,
    date: formatDate(result.date),
    title: result.title,
    reason
  })),
  unresolved: deduplicatedResults.filter((item) => !item.reliable).map((item) => ({
    id: item.tweet.id_str,
    date: formatDate(item.date),
    title: item.title,
    media: item.resolvedMedia.map((media) => ({
      kind: media.kind,
      source: media.source ? relative(root, media.source).replaceAll("\\", "/") : null,
      score: media.score,
      secondScore: media.secondScore,
      error: media.error
    }))
  }))
};
await mkdir(join(root, ".tmp"), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report.counts, null, 2));
console.log(`Report: ${relative(root, reportPath)}`);
