import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

const root = resolve(process.cwd());
const apply = process.argv.includes("--apply");
const postsRoot = join(root, "src", "content", "posts");
const publicRoot = join(root, "public");
const galleryRoot = join(publicRoot, "img", "gallery");
const thumbsRoot = join(publicRoot, "img", "thumbs", "gallery");
const quarantineRoot = join(root, "local-only", "quarantined-drafts");
const reportPath = join(root, ".tmp", "draft-quarantine-report.json");
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function isWithin(path, parent) {
  const normalizedPath = resolve(path).toLocaleLowerCase();
  const normalizedParent = resolve(parent).toLocaleLowerCase();
  return normalizedPath.startsWith(`${normalizedParent}${sep}`);
}

function mediaUrls(source) {
  return [...source.matchAll(/(?:"|')(?<url>\/img\/gallery\/[^"']+?\.(?:png|jpe?g|gif|webp))(?:"|')/gi)]
    .map((match) => match.groups.url);
}

function publicPath(url) {
  let decoded = url;
  try { decoded = decodeURIComponent(url); } catch { /* Keep the literal URL. */ }
  const path = resolve(publicRoot, decoded.replace(/^\//, ""));
  return isWithin(path, galleryRoot) ? path : null;
}

async function exists(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function uniqueDestination(source) {
  const relativePath = relative(root, source);
  const preferred = join(quarantineRoot, relativePath);
  if (!await exists(preferred)) return preferred;
  const extension = extname(preferred);
  const stem = preferred.slice(0, -extension.length);
  for (let index = 2; ; index += 1) {
    const candidate = `${stem}-${index}${extension}`;
    if (!await exists(candidate)) return candidate;
  }
}

async function moveToQuarantine(source) {
  if (!isWithin(source, root)) throw new Error(`Refusing to move path outside workspace: ${source}`);
  const destination = await uniqueDestination(source);
  if (!isWithin(destination, quarantineRoot)) throw new Error(`Invalid quarantine destination: ${destination}`);
  await mkdir(dirname(destination), { recursive: true });
  await rename(source, destination);
  return destination;
}

const postFiles = (await walk(postsRoot)).filter((path) => extname(path).toLowerCase() === ".md");
const drafts = [];
const published = [];
for (const path of postFiles) {
  const source = await readFile(path, "utf8");
  const entry = { path, urls: mediaUrls(source) };
  if (/^draft:\s*true\s*$/mi.test(source)) drafts.push(entry);
  else published.push(entry);
}

const publishedImages = new Set(published.flatMap((post) => post.urls).map((url) => url.toLocaleLowerCase()));
const draftImageUrls = [...new Set(drafts.flatMap((post) => post.urls))];
const sharedImageUrls = draftImageUrls.filter((url) => publishedImages.has(url.toLocaleLowerCase()));
const draftOnlyImageUrls = draftImageUrls.filter((url) => !publishedImages.has(url.toLocaleLowerCase()));
const draftOnlyImages = [];
const missingDraftImages = [];
for (const url of draftOnlyImageUrls) {
  const path = publicPath(url);
  if (path && await exists(path)) draftOnlyImages.push({ url, path });
  else missingDraftImages.push(url);
}

const thumbnailFiles = [];
for (const image of draftOnlyImages) {
  const galleryRelative = relative(galleryRoot, image.path);
  const exact = join(thumbsRoot, `${galleryRelative}.webp`);
  if (await exists(exact)) thumbnailFiles.push(exact);
}

const moved = { posts: [], images: [], thumbnails: [] };
if (apply) {
  await mkdir(quarantineRoot, { recursive: true });
  // Move media first so a failure cannot leave published content without its post record.
  for (const image of draftOnlyImages) moved.images.push(await moveToQuarantine(image.path));
  for (const thumbnail of thumbnailFiles) moved.thumbnails.push(await moveToQuarantine(thumbnail));
  for (const draft of drafts) moved.posts.push(await moveToQuarantine(draft.path));
}

const formatPaths = (paths) => paths.map((path) => relative(root, path).replaceAll("\\", "/"));
const report = {
  generatedAt: new Date().toISOString(),
  applied: apply,
  quarantineRoot: relative(root, quarantineRoot).replaceAll("\\", "/"),
  counts: {
    allPosts: postFiles.length,
    draftPosts: drafts.length,
    publishedPosts: published.length,
    draftImageReferences: draftImageUrls.length,
    draftOnlyImages: draftOnlyImages.length,
    sharedImagesRetained: sharedImageUrls.length,
    missingDraftImages: missingDraftImages.length,
    thumbnails: thumbnailFiles.length
  },
  draftPosts: formatPaths(drafts.map((item) => item.path)),
  draftOnlyImages: draftOnlyImages.map((item) => ({ url: item.url, path: relative(root, item.path).replaceAll("\\", "/") })),
  sharedImagesRetained: sharedImageUrls,
  missingDraftImages,
  moved: {
    posts: formatPaths(moved.posts),
    images: formatPaths(moved.images),
    thumbnails: formatPaths(moved.thumbnails)
  }
};
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (apply) await writeFile(join(quarantineRoot, "manifest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report.counts, null, 2));
console.log(`Mode: ${apply ? "applied" : "dry run"}`);
console.log(`Report: ${relative(root, reportPath)}`);
