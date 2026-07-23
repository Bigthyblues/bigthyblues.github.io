import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, join, resolve } from "node:path";

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

const inputPath = args.get("input");
const author = (args.get("author") ?? "bigthyblues").toLowerCase();
const mediaRoot = args.get("media-root");
const outDir = args.get("out") ?? "src/content/posts/imported-drafts";
const publicMediaDir = args.get("public-media") ?? "public/img/gallery/imported";
const publicMediaUrl = args.get("public-media-url") ?? "/img/gallery/imported";
const reviewPath = args.get("review") ?? "tools/twitter-import-review.md";
const dryRun = args.get("dry-run") === "true";

if (!inputPath) {
  console.error("Usage: npm run import:tweets -- --input data/twitter.json --media-root data/images");
  process.exit(1);
}

const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

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
  return tweet.id_str ?? tweet.id ?? tweet.rest_id ?? tweet.metadata?.rest_id ?? randomUUID();
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
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
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
  const firstSentence = firstLine?.split(/(?<=[.!?¡££¡£¿])\s+/)[0]?.trim();
  const candidate = (firstSentence || firstLine || "").replace(/^["'¡°¡±¡®¡¯]+|["'¡°¡±¡®¡¯]+$/g, "");
  if (candidate) return candidate.slice(0, 72);
  return `Twitter Post ${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()}`;
}

function sourceNameFromUrl(value) {
  if (!value) return "";
  const url = new URL(value);
  const base = basename(url.pathname);
  const format = url.searchParams.get("format");
  return extname(base) ? base : format ? `${base}.${format}` : base;
}

function findMediaFiles(tweet, mediaRootPath) {
  const tweetId = getTweetId(tweet);
  const media = [
    ...(tweet.media ?? []),
    ...(tweet.extended_entities?.media ?? []),
    ...(tweet.entities?.media ?? []),
    ...(tweet.metadata?.legacy?.extended_entities?.media ?? []),
    ...(tweet.metadata?.legacy?.entities?.media ?? [])
  ];
  const seen = new Set();

  return media
    .filter((item) => item.type === "photo")
    .map((item) => {
      const sourceName = sourceNameFromUrl(item.original ?? item.media_url_https ?? item.media_url);
      const key = sourceName.toLowerCase();
      if (!sourceName || seen.has(key)) return null;
      seen.add(key);
      const candidates = [
        join(mediaRootPath, sourceName),
        join(mediaRootPath, `${tweetId}-${sourceName}`),
        join(mediaRootPath, sourceName.replace(/_orig(?=\.)/, "")),
        join(mediaRootPath, sourceName.replace(/\.(jpg|jpeg|png|gif|webp)$/i, "_orig.$1"))
      ];
      return { sourceName, candidates };
    })
    .filter((item) => item && imageExtensions.has(extname(item.sourceName).toLowerCase()));
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

const raw = await readFile(resolve(inputPath), "utf8");
const records = JSON.parse(stripTwitterWrapper(raw)).map(getTweetRecord);
const mediaRootPath = mediaRoot ? resolve(mediaRoot) : resolve(dirname(inputPath), "Í¼Æ¬");
if (!dryRun) {
  await mkdir(outDir, { recursive: true });
  await mkdir(publicMediaDir, { recursive: true });
  await mkdir(dirname(reviewPath), { recursive: true });
}

const reviewRows = [];
const stats = {
  total: 0,
  imported: 0,
  skippedOtherAuthor: 0,
  skippedTextOnly: 0,
  skippedMention: 0,
  skippedFanartTag: 0,
  skippedRetweet: 0,
  skippedInvalidDate: 0,
  skippedMissingMedia: 0
};

for (const tweet of records) {
  stats.total += 1;
  const text = getText(tweet);
  const date = parseDate(tweet);
  const id = getTweetId(tweet);

  if (getScreenName(tweet) !== author) {
    stats.skippedOtherAuthor += 1;
    continue;
  }

  if (tweet.retweeted_status) {
    stats.skippedRetweet += 1;
    continue;
  }

  if (Number.isNaN(date.valueOf())) {
    stats.skippedInvalidDate += 1;
    continue;
  }

  const media = findMediaFiles(tweet, mediaRootPath);
  if (media.length === 0) {
    stats.skippedTextOnly += 1;
    continue;
  }

  if (hasMention(tweet, text)) {
    stats.skippedMention += 1;
    continue;
  }

  const hashtags = getHashtags(tweet, text);
  if (hashtags.includes("fanart")) {
    stats.skippedFanartTag += 1;
    continue;
  }

  const cleanedText = removeHashtagsAndLinks(text);
  const title = createTitle(cleanedText, date);
  const slug = `${formatDateForFilename(date)}-${slugify(title)}-${String(id).slice(-6)}`;
  const copiedImages = [];
  const missingMedia = [];

  for (let index = 0; index < media.length; index += 1) {
    const item = media[index];
    const extension = extname(item.sourceName).toLowerCase();
    const destinationName = `${slug}${index === 0 ? "" : `-${index + 1}`}${extension}`;
    const destination = join(publicMediaDir, destinationName);
    const copied = dryRun ? true : await copyFirstExisting(item.candidates, destination);
    if (copied) {
      copiedImages.push(`${publicMediaUrl}/${destinationName}`);
    } else {
      missingMedia.push(item.sourceName);
    }
  }

  if (copiedImages.length === 0) {
    stats.skippedMissingMedia += 1;
    continue;
  }

  const filename = `${slug}.md`;
  const imageFrontmatter = copiedImages.length === 1
    ? `image: ${yamlString(copiedImages[0])}`
    : `images: [${copiedImages.map(yamlString).join(", ")}]`;
  const body = cleanedText || title;
  const markdown = `---\ntitle: ${yamlString(title)}\nauthor: "blues"\ncharacter: "Blues"\ntype: "image"\ndate: ${formatDate(date)}\n${imageFrontmatter}\nexcerpt: ${yamlString(cleanedText.slice(0, 140) || title)}\ndraft: true\n---\n\n${body}\n`;

  if (!dryRun) await writeFile(join(outDir, filename), markdown, "utf8");
  reviewRows.push({ filename, date, title, text: cleanedText, url: tweet.url ?? "", imageCount: copiedImages.length, missingMedia });
  stats.imported += 1;
}

reviewRows.sort((a, b) => b.date.valueOf() - a.date.valueOf());
const review = [
  "# Twitter Import Review",
  "",
  `Author filter: ${author}`,
  `Imported drafts: ${stats.imported}`,
  "",
  "| Date | Title | File | Images | Original | Text |",
  "| --- | --- | --- | ---: | --- | --- |",
  ...reviewRows.map((row) => {
    const date = `${row.date.getFullYear()}.${row.date.getMonth() + 1}.${row.date.getDate()} ${pad(row.date.getHours())}:${pad(row.date.getMinutes())}`;
    const title = row.title.replaceAll("|", "\\|");
    const text = (row.text || row.title).replaceAll("\n", "<br>").replaceAll("|", "\\|").slice(0, 220);
    const original = row.url ? `[tweet](${row.url})` : "";
    const missing = row.missingMedia.length ? `<br>Missing: ${row.missingMedia.join(", ")}` : "";
    return `| ${date} | ${title} | \`${row.filename}\` | ${row.imageCount} | ${original} | ${text}${missing} |`;
  })
].join("\n");

if (!dryRun) await writeFile(reviewPath, review, "utf8");

console.log(`Checked ${stats.total} tweets.`);
console.log(`Imported ${stats.imported} image posts as draft markdown.`);
console.log(`Skipped other author: ${stats.skippedOtherAuthor}`);
console.log(`Skipped text-only/no-photo: ${stats.skippedTextOnly}`);
console.log(`Skipped mentions: ${stats.skippedMention}`);
console.log(`Skipped #fanart: ${stats.skippedFanartTag}`);
console.log(`Skipped retweets: ${stats.skippedRetweet}`);
console.log(`Skipped invalid date: ${stats.skippedInvalidDate}`);
console.log(`Skipped missing local media files: ${stats.skippedMissingMedia}`);
if (!dryRun) console.log(`Review file: ${reviewPath}`);



