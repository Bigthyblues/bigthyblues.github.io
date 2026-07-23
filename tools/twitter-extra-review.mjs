import { readdir, readFile, writeFile } from "node:fs/promises";
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

const dataDir = args.get("data-dir") ?? "鏁版嵁";
const author = (args.get("author") ?? "bigthyblues").toLowerCase();
const mediaRoot = args.get("media-root") ?? join(dataDir, "鍥剧墖");
const outPath = args.get("out") ?? "tools/twitter-extra-review.md";

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
  return tweet.id_str ?? tweet.id ?? tweet.rest_id ?? tweet.metadata?.rest_id ?? "";
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

function parseDate(tweet) {
  const value = tweet.created_at ?? tweet.legacy?.created_at ?? tweet.metadata?.legacy?.created_at;
  if (typeof value === "number") return new Date(value);
  if (typeof tweet.metadata?.twe_private_fields?.created_at === "number") {
    return new Date(tweet.metadata.twe_private_fields.created_at);
  }
  return new Date(value);
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatDate(date) {
  if (Number.isNaN(date.valueOf())) return "unknown";
  return `${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sourceNameFromUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    const base = basename(url.pathname);
    const format = url.searchParams.get("format");
    return extname(base) ? base : format ? `${base}.${format}` : base;
  } catch {
    return basename(value.split("?")[0] ?? value);
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
      .map((variant) => variant.url)
      .filter(Boolean)
      .sort((a, b) => sourceNameFromUrl(b).length - sourceNameFromUrl(a).length)[0];
    const source = item.original ?? variantUrl ?? item.media_url_https ?? item.media_url ?? item.url ?? "";
    const sourceName = sourceNameFromUrl(source);
    const key = `${item.type ?? "unknown"}:${sourceName}`.toLowerCase();
    if (!sourceName || seen.has(key)) return null;
    seen.add(key);
    return {
      type: item.type ?? (extname(sourceName).toLowerCase() === ".mp4" ? "video" : "unknown"),
      sourceName,
      source
    };
  }).filter(Boolean);
}

function mediaKind(media) {
  if (media.type === "animated_gif") return "animated_gif";
  if (media.type === "video") return "video";
  if (extname(media.sourceName).toLowerCase() === ".mp4") return "video";
  return media.type;
}

function firstLineTitle(text, date) {
  const cleaned = removeHashtagsAndLinks(text);
  const firstLine = cleaned.split("\n").map((line) => line.trim()).find(Boolean);
  return (firstLine || `Twitter Post ${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()}`).slice(0, 90);
}

function escapeCell(value) {
  return String(value ?? "").replaceAll("\n", "<br>").replaceAll("|", "\\|");
}

const dataRoot = resolve(dataDir);
const mediaRootPath = resolve(mediaRoot);
const mediaFiles = new Set((await readdir(mediaRootPath)).map((name) => name.toLowerCase()));
const dataFiles = (await readdir(dataRoot))
  .filter((name) => name.toLowerCase().endsWith(".json"))
  .sort();

const tweetsById = new Map();
for (const file of dataFiles) {
  const raw = await readFile(join(dataRoot, file), "utf8");
  const records = JSON.parse(stripTwitterWrapper(raw)).map(getTweetRecord);
  for (const tweet of records) {
    const id = getTweetId(tweet);
    if (!id || tweetsById.has(id)) continue;
    tweetsById.set(id, { tweet, file });
  }
}

const filtered = [];
const motion = [];
const stats = {
  total: 0,
  author: 0,
  mention: 0,
  fanart: 0,
  motion: 0
};

for (const { tweet, file } of tweetsById.values()) {
  stats.total += 1;
  if (getScreenName(tweet) !== author || tweet.retweeted_status) continue;
  stats.author += 1;

  const text = getText(tweet);
  const date = parseDate(tweet);
  const media = getMedia(tweet);
  if (media.length === 0) continue;

  const hashtags = getHashtags(tweet, text);
  const mention = hasMention(tweet, text);
  const fanart = hashtags.includes("fanart");
  const title = firstLineTitle(text, date);
  const mediaSummary = media.map((item) => {
    const exists = mediaFiles.has(item.sourceName.toLowerCase()) ? "local" : "missing";
    return `${mediaKind(item)}:${item.sourceName} (${exists})`;
  }).join("<br>");
  const row = {
    date,
    title,
    file,
    url: tweet.url ?? "",
    reasons: [
      mention ? "@" : "",
      fanart ? "#fanart" : ""
    ].filter(Boolean).join(", "),
    kinds: [...new Set(media.map(mediaKind))].join(", "),
    mediaSummary,
    text: removeHashtagsAndLinks(text)
  };

  if (mention || fanart) {
    if (mention) stats.mention += 1;
    if (fanart) stats.fanart += 1;
    filtered.push(row);
  }

  if (media.some((item) => ["video", "animated_gif"].includes(mediaKind(item)))) {
    stats.motion += 1;
    motion.push(row);
  }
}

filtered.sort((a, b) => b.date.valueOf() - a.date.valueOf());
motion.sort((a, b) => b.date.valueOf() - a.date.valueOf());

function table(rows, reasonLabel) {
  return [
    `| Date | ${reasonLabel} | Title | Source JSON | Original | Media | Text |`,
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => {
      const original = row.url ? `[tweet](${row.url})` : "";
      return `| ${formatDate(row.date)} | ${escapeCell(row.reasons || row.kinds)} | ${escapeCell(row.title)} | \`${escapeCell(row.file)}\` | ${original} | ${escapeCell(row.mediaSummary)} | ${escapeCell(row.text).slice(0, 260)} |`;
    })
  ].join("\n");
}

const output = [
  "# Twitter Extra Review",
  "",
  `Author filter: ${author}`,
  `JSON files scanned: ${dataFiles.length}`,
  `Unique tweets scanned: ${stats.total}`,
  `Author tweets scanned: ${stats.author}`,
  "",
  "## Filtered by @ / #fanart",
  "",
  `Rows: ${filtered.length} (@: ${stats.mention}, #fanart: ${stats.fanart})`,
  "",
  table(filtered, "Reason"),
  "",
  "## Animation / GIF / Video Candidates",
  "",
  `Rows: ${motion.length}`,
  "",
  table(motion, "Kind")
].join("\n");

await writeFile(resolve(outPath), output, "utf8");

console.log(`Scanned ${stats.total} unique tweets from ${dataFiles.length} JSON files.`);
console.log(`Filtered review rows: ${filtered.length} (@: ${stats.mention}, #fanart: ${stats.fanart}).`);
console.log(`Animation/GIF/video candidate rows: ${motion.length}.`);
console.log(`Review file: ${outPath}`);
