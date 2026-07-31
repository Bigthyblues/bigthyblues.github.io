import { copyFile, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";

const root = resolve(process.cwd());
const originalsRoot = resolve(process.argv[2] ?? "原件");
const shouldApply = process.argv.includes("--apply");
const postsRoot = join(root, "src", "content", "posts");
const publicRoot = join(root, "public");
const reportPath = join(root, ".tmp", "original-media-matches.json");
const imageExtensions = new Set([".jpg", ".jpeg"]);
const originalImageExtensions = new Set([".png"]);
const videoExtensions = new Set([".mp4"]);

async function walk(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
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

function probeDuration(path) {
  const result = spawnSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    path
  ], { encoding: "utf8" });
  return Number.parseFloat(result.stdout.trim());
}

function videoSignature(path) {
  const duration = probeDuration(path);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Unable to read video duration: ${path}`);
  const frameCount = 5;
  const fps = Math.max(frameCount / duration, 0.01);
  const result = spawnSync("ffmpeg", [
    "-v", "error", "-i", path,
    "-vf", `fps=${fps},scale=48:48:force_original_aspect_ratio=disable,format=rgb24`,
    "-frames:v", String(frameCount),
    "-f", "rawvideo", "pipe:1"
  ], { encoding: null, maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Unable to sample video: ${path}`);
  return { path, duration, pixels: result.stdout };
}

const postFiles = (await walk(postsRoot)).filter((path) => extname(path).toLowerCase() === ".md");
const referenced = new Map();
for (const postPath of postFiles) {
  const content = await readFile(postPath, "utf8");
  for (const match of content.matchAll(/\/img\/gallery\/[^"']+?\.(?:mp4|jpe?g)/gi)) {
    const media = match[0];
    if (!referenced.has(media)) referenced.set(media, { media, postPaths: [] });
    referenced.get(media).postPaths.push(postPath);
  }
}

const originalFiles = await walk(originalsRoot);
const originalImages = originalFiles.filter((path) => originalImageExtensions.has(extname(path).toLowerCase()));
const originalVideos = originalFiles.filter((path) => videoExtensions.has(extname(path).toLowerCase()));
const mediaExists = async ({ media }) => {
  try {
    return (await stat(join(publicRoot, media.replace(/^\//, "")))).isFile();
  } catch {
    return false;
  }
};
const websiteImages = (await Promise.all([...referenced.values()]
  .filter(({ media }) => media.startsWith("/img/gallery/imported/") && imageExtensions.has(extname(media).toLowerCase()))
  .map(async (item) => ({ item, exists: await mediaExists(item) }))))
  .filter(({ exists }) => exists)
  .map(({ item }) => item);
const websiteVideos = (await Promise.all([...referenced.values()]
  .filter(({ media }) => media.startsWith("/img/gallery/imported/") && videoExtensions.has(extname(media).toLowerCase()))
  .map(async (item) => ({ item, exists: await mediaExists(item) }))))
  .filter(({ exists }) => exists)
  .map(({ item }) => item);

console.log(`Reading ${websiteImages.length} website images and ${originalImages.length} original PNG files...`);
const [websiteImageSignatures, originalImageSignatures] = await Promise.all([
  mapLimit(websiteImages, 8, async (item) => ({ ...await imageSignature(join(publicRoot, item.media.replace(/^\//, ""))), item })),
  mapLimit(originalImages, 8, imageSignature)
]);

const imageMatches = websiteImageSignatures.map((target) => {
  const candidates = originalImageSignatures
    .filter((candidate) => Math.abs(Math.log(target.ratio / candidate.ratio)) <= 0.008)
    .map((candidate) => ({
      original: relative(root, candidate.path).replaceAll("\\", "/"),
      score: imageDistance(target.pixels, candidate.pixels),
      width: candidate.width,
      height: candidate.height
    }))
    .sort((a, b) => a.score - b.score);
  const best = candidates[0];
  const second = candidates[1];
  return {
    media: target.item.media,
    posts: target.item.postPaths.map((path) => relative(root, path).replaceAll("\\", "/")),
    width: target.width,
    height: target.height,
    best,
    secondScore: second?.score,
    margin: best && second ? second.score - best.score : null
  };
});

console.log(`Reading ${websiteVideos.length} website videos and ${originalVideos.length} original MP4 files...`);
const websiteVideoSignatures = websiteVideos.map((item) => ({ ...videoSignature(join(publicRoot, item.media.replace(/^\//, ""))), item }));
const originalVideoSignatures = originalVideos.map(videoSignature);
const videoMatches = websiteVideoSignatures.map((target) => {
  const candidates = originalVideoSignatures
    .filter((candidate) => Math.abs(target.duration - candidate.duration) <= Math.max(0.25, target.duration * 0.15))
    .map((candidate) => ({
      original: relative(root, candidate.path).replaceAll("\\", "/"),
      duration: candidate.duration,
      score: imageDistance(target.pixels, candidate.pixels)
    }))
    .sort((a, b) => a.score - b.score);
  const best = candidates[0];
  const second = candidates[1];
  return {
    media: target.item.media,
    posts: target.item.postPaths.map((path) => relative(root, path).replaceAll("\\", "/")),
    duration: target.duration,
    best,
    secondScore: second?.score,
    margin: best && second ? second.score - best.score : null
  };
});

const scoreSummary = (matches) => matches
  .filter((match) => match.best)
  .map((match) => match.best.score)
  .sort((a, b) => a - b);
const imageScores = scoreSummary(imageMatches);
const videoScores = scoreSummary(videoMatches);
const report = {
  generatedAt: new Date().toISOString(),
  originalsRoot: relative(root, originalsRoot).replaceAll("\\", "/"),
  summary: {
    websiteImages: websiteImages.length,
    originalImages: originalImages.length,
    websiteVideos: websiteVideos.length,
    originalVideos: originalVideos.length,
    imageCandidates: imageScores.length,
    videoCandidates: videoScores.length
  },
  imageMatches,
  videoMatches
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`Report: ${relative(root, reportPath)}`);
console.log(`Image scores: ${imageScores.slice(0, 10).map((value) => value.toFixed(4)).join(", ")} ... ${imageScores.slice(-5).map((value) => value.toFixed(4)).join(", ")}`);
console.log(`Video scores: ${videoScores.map((value) => value.toFixed(4)).join(", ")}`);

if (shouldApply) {
  const acceptedImages = imageMatches.filter((match) => match.best?.score <= 0.07);
  const acceptedVideos = videoMatches.filter((match) => match.best?.score <= 0.08);
  const changedPosts = new Set();

  for (const match of acceptedImages) {
    const newMedia = match.media.replace(/\.jpe?g$/i, ".png");
    const source = join(root, match.best.original);
    const destination = join(publicRoot, newMedia.replace(/^\//, ""));
    await copyFile(source, destination);

    for (const post of match.posts) {
      const postPath = join(root, post);
      const content = await readFile(postPath, "utf8");
      const updated = content.replaceAll(match.media, newMedia);
      if (updated !== content) {
        await writeFile(postPath, updated, "utf8");
        changedPosts.add(post);
      }
    }
  }

  for (const match of acceptedVideos) {
    const source = join(root, match.best.original);
    const destination = join(publicRoot, match.media.replace(/^\//, ""));
    await copyFile(source, destination);
  }

  const appliedReport = {
    appliedAt: new Date().toISOString(),
    imagesReplaced: acceptedImages.length,
    videosReplaced: acceptedVideos.length,
    changedPosts: [...changedPosts].sort(),
    retainedJpg: imageMatches.filter((match) => !acceptedImages.includes(match)).map((match) => match.media),
    retainedVideos: videoMatches.filter((match) => !acceptedVideos.includes(match)).map((match) => match.media)
  };
  const appliedReportPath = join(root, ".tmp", "original-media-applied.json");
  await writeFile(appliedReportPath, `${JSON.stringify(appliedReport, null, 2)}\n`, "utf8");
  console.log(`Applied ${acceptedImages.length} PNG replacements across ${changedPosts.size} posts.`);
  console.log(`Applied ${acceptedVideos.length} original video replacements.`);
  console.log(`Retained ${appliedReport.retainedJpg.length} JPG and ${appliedReport.retainedVideos.length} video files without reliable matches.`);
  console.log(`Apply report: ${relative(root, appliedReportPath)}`);
}
