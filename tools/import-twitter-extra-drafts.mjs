import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

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

const dataDir = args.get("data-dir") ?? "\u6570\u636e";
const author = (args.get("author") ?? "bigthyblues").toLowerCase();
const mediaRoot = args.get("media-root") ?? join(dataDir, "\u56fe\u7247");
const outDir = args.get("out") ?? "src/content/posts/imported-drafts";
const publicMediaDir = args.get("public-media") ?? "public/img/gallery/imported";
const publicMediaUrl = args.get("public-media-url") ?? "/img/gallery/imported";
const reviewPrefix = args.get("prefix") ?? "review";

const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const videoExtensions = new Set([".mp4", ".webm", ".mov"]);

function stripTwitterWrapper(source) {
  const trimmed = source.trim();
  const firstBracket = trimmed.indexOf("[");
  if (firstBracket === -1) return trimmed;
  return trimmed.slice(firstBracket).replace(/;\s*$/, "");
}

function getTweetRecord(item) {
  return item?.tweet ?? item;
}

function getTweetId(tweet) {
  return String(tweet.id_str ?? tweet.id ?? tweet.rest_id ?? tweet.metadata?.rest_id ?? "");
}

function getText(tweet) {
  return tweet.full_text ?? tweet.text ?? tweet.note_tweet?.note_tweet_results?.result?.text ?? "";
}

function getScreenName(tweet) {
  return (
    tweet.screen_name ??
    tweet.user?.screen_name ??
    tweet.metadata?.core?.user_results?.result?.core?.screen_name ??
    ""
  ).toLowerCase();
}

function getEntityHashtags(tweet) {
  return [
    ...(tweet.entities?.hashtags ?? []),
    ...(tweet.legacy?.entities?.hashtags ?? []),
    ...(tweet.metadata?.legacy?.entities?.hashtags ?? [])
  ].map((tag) => tag.text).filter(Boolean);
}

function getHashtags(tweet, text) {
  const textTags = [...text.matchAll(/(^|\s)#([^\s#]+)/g)].map((match) => match[2]);
  return [...new Set([...getEntityHashtags(tweet), ...textTags].map((tag) => tag.toLowerCase()))];
}

function hasMention(tweet, text) {
  const mentions = [
    ...(tweet.entities?.user_mentions ?? []),
    ...(tweet.legacy?.entities?.user_mentions ?? []),
    ...(tweet.metadata?.legacy?.entities?.user_mentions ?? [])
  ];
  if (mentions.length > 0) return true;
  return text.includes("@");
}

function removeHashtagsAndLinks(text) {
  return text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/(^|\s)#[^\s#]+/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function slugify(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "twitter-post";
}

function yamlString(value) {
  return `"${String(value ?? "").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function parseDate(tweet) {
  const value = tweet.created_at ?? tweet.legacy?.created_at ?? tweet.metadata?.legacy?.created_at;
  if (typeof value === "number") return new Date(value);
  if (typeof tweet.metadata?.twe_private_fields?.created_at === "number") {
    return new Date(tweet.metadata.twe_private_fields.created_at);
  }
  return new Date(value);
}

function formatDate(date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const offset = `${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00${offset}`;
}

function formatDateForFilename(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function createTitle(text, date) {
  const firstLine = text.split("\n").map((line) => line.trim()).find(Boolean);
  const firstSentence = firstLine?.split(/(?<=[.!?。！？])\s+/)[0]?.trim();
  const candidate = (firstSentence || firstLine || "").replace(/^["'“”‘’]+|["'“”‘’]+$/g, "");
  if (candidate) return candidate.slice(0, 72);
  return `Twitter Post ${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()}`;
}

function sourceNameFromUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    const base = basename(url.pathname);
    const format = url.searchParams.get("format");
    return extname(base) ? base : format ? `${base}.${format}` : base;
  } catch {
    return basename(String(value).split("?")[0]);
  }
}

function getMedia(tweet) {
  const raw = [
    ...(tweet.media ?? []),
    ...(tweet.extended_entities?.media ?? []),
    ...(tweet.entities?.media ?? []),
    ...(tweet.metadata?.legacy?.extended_entities?.media ?? []),
    ...(tweet.metadata?.legacy?.entities?.media ?? [])
  ];
  const seen = new Set();

  return raw.map((item) => {
    const variants = item.video_info?.variants ?? item.video?.variants ?? [];
    const variantUrl = variants
      .filter((variant) => variant.url && !variant.content_type?.includes("mpegurl"))
      .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0]?.url;
    const source = item.original ?? variantUrl ?? item.media_url_https ?? item.media_url ?? item.url ?? "";
    const sourceName = sourceNameFromUrl(source);
    const type = item.type ?? (extname(sourceName).toLowerCase() === ".mp4" ? "video" : "unknown");
    const key = `${type}:${sourceName}`.toLowerCase();
    if (!sourceName || seen.has(key)) return null;
    seen.add(key);
    return { type, sourceName };
  }).filter(Boolean);
}

function isVideoMedia(item) {
  return item.type === "video" || item.type === "animated_gif" || videoExtensions.has(extname(item.sourceName).toLowerCase());
}

function localCandidates(item, tweetId) {
  return [
    join(mediaRoot, item.sourceName),
    join(mediaRoot, `${tweetId}-${item.sourceName}`),
    join(mediaRoot, item.sourceName.replace(/_orig(?=\.)/, "")),
    join(mediaRoot, item.sourceName.replace(/\.(jpg|jpeg|png|gif|webp)$/i, "_orig.$1"))
  ].map((candidate) => resolve(candidate));
}

async function copyFirstExisting(candidates, destination) {
  for (const candidate of candidates) {
    try {
      await copyFile(candidate, destination);
      return true;
    } catch {
      // Try the next exporter/archive naming pattern.
    }
  }
  return false;
}

async function collectKnownIdTails() {
  const known = new Set();
  for (const dir of ["src/content/posts", outDir]) {
    let files = [];
    try {
      files = await readdir(dir, { recursive: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (typeof file === "string" && file.endsWith(".md")) known.add(file);
    }
  }
  return known;
}

const dataRoot = resolve(dataDir);
const outRoot = resolve(outDir);
const publicRoot = resolve(publicMediaDir);
const dataFiles = (await readdir(dataRoot)).filter((file) => file.toLowerCase().endsWith(".json")).sort();
const knownFiles = await collectKnownIdTails();
const tweetsById = new Map();

await mkdir(outRoot, { recursive: true });
await mkdir(publicRoot, { recursive: true });

for (const file of dataFiles) {
  const raw = await readFile(join(dataRoot, file), "utf8");
  const records = JSON.parse(stripTwitterWrapper(raw)).map(getTweetRecord);
  for (const tweet of records) {
    const id = getTweetId(tweet);
    if (!id || tweetsById.has(id)) continue;
    tweetsById.set(id, tweet);
  }
}

const stats = {
  scanned: tweetsById.size,
  imported: 0,
  skippedExisting: 0,
  skippedOther: 0,
  skippedMissingMedia: 0,
  filtered: 0,
  motion: 0
};

for (const tweet of tweetsById.values()) {
  if (getScreenName(tweet) !== author || tweet.retweeted_status) {
    stats.skippedOther += 1;
    continue;
  }

  const id = getTweetId(tweet);
  const idTail = id.slice(-6);
  if ([...knownFiles].some((file) => file.includes(idTail))) {
    stats.skippedExisting += 1;
    continue;
  }

  const text = getText(tweet);
  const date = parseDate(tweet);
  if (Number.isNaN(date.valueOf())) continue;
  const media = getMedia(tweet);
  if (media.length === 0) continue;

  const hashtags = getHashtags(tweet, text);
  const mention = hasMention(tweet, text);
  const fanart = hashtags.includes("fanart");
  const motion = media.some(isVideoMedia);
  if (!mention && !fanart && !motion) continue;

  const cleanedText = removeHashtagsAndLinks(text);
  const title = createTitle(cleanedText, date);
  const reasons = [
    mention ? "mention" : "",
    fanart ? "fanart-tag" : "",
    motion ? "motion-media" : ""
  ].filter(Boolean);
  const slug = `${reviewPrefix}-${formatDateForFilename(date)}-${slugify(title)}-${idTail}`;
  const copiedImages = [];
  let copiedVideo = "";
  const missingMedia = [];

  for (let index = 0; index < media.length; index += 1) {
    const item = media[index];
    const extension = extname(item.sourceName).toLowerCase();
    if (!imageExtensions.has(extension) && !videoExtensions.has(extension)) continue;
    const kind = isVideoMedia(item) ? "video" : "image";
    const destinationName = `${slug}${kind === "video" ? "-video" : copiedImages.length ? `-${copiedImages.length + 1}` : ""}${extension}`;
    const destination = join(publicRoot, destinationName);
    const copied = await copyFirstExisting(localCandidates(item, id), destination);
    if (!copied) {
      missingMedia.push(item.sourceName);
      continue;
    }
    const publicUrl = `${publicMediaUrl}/${destinationName}`;
    if (kind === "video" && !copiedVideo) copiedVideo = publicUrl;
    if (kind === "image") copiedImages.push(publicUrl);
  }

  if (!copiedVideo && copiedImages.length === 0) {
    stats.skippedMissingMedia += 1;
    continue;
  }

  if (mention || fanart) stats.filtered += 1;
  if (motion) stats.motion += 1;

  const filename = `${slug}.md`;
  const frontmatter = [
    "---",
    `title: ${yamlString(title)}`,
    'author: "blues"',
    'character: "Blues"',
    `type: "${copiedVideo ? "video" : "image"}"`,
    `date: ${formatDate(date)}`
  ];
  if (copiedImages.length === 1) frontmatter.push(`image: ${yamlString(copiedImages[0])}`);
  if (copiedImages.length > 1) frontmatter.push(`images: [${copiedImages.map(yamlString).join(", ")}]`);
  if (copiedVideo) frontmatter.push(`video: ${yamlString(copiedVideo)}`);
  frontmatter.push(`excerpt: ${yamlString(cleanedText.slice(0, 140) || title)}`);
  frontmatter.push("draft: true");
  frontmatter.push("---");

  const reviewNote = [
    "<!--",
    `review-reasons: ${reasons.join(", ")}`,
    `original-tweet: ${tweet.url ?? ""}`,
    missingMedia.length ? `missing-media: ${missingMedia.join(", ")}` : "",
    "-->"
  ].filter(Boolean).join("\n");
  const body = `${cleanedText || title}\n\n${reviewNote}\n`;
  await writeFile(join(outRoot, filename), `${frontmatter.join("\n")}\n\n${body}`, "utf8");
  knownFiles.add(filename);
  stats.imported += 1;
}

console.log(`Scanned ${stats.scanned} unique tweets.`);
console.log(`Created ${stats.imported} review drafts.`);
console.log(`Filtered review candidates included: ${stats.filtered}.`);
console.log(`Motion media candidates included: ${stats.motion}.`);
console.log(`Skipped existing posts/drafts: ${stats.skippedExisting}.`);
console.log(`Skipped missing local media: ${stats.skippedMissingMedia}.`);
