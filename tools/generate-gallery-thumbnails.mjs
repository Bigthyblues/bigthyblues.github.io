import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const sourceRoot = path.resolve('public/img/gallery');
const thumbRoot = path.resolve('public/img/thumbs/gallery');
const manifestPath = path.resolve('src/generated/gallery-thumbnails.ts');
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const videoExtensions = new Set(['.mp4', '.webm', '.mov']);
const maxSize = '960x960>';
const clean = process.argv.includes('--clean');

function commandExists(name) {
  const command = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(command, [name], { encoding: 'utf8' }).status === 0;
}

function isImageMagickCommand(name) {
  const result = spawnSync(name, ['-version'], { encoding: 'utf8' });
  return result.status === 0 && `${result.stdout}${result.stderr}`.includes('ImageMagick');
}

function findImageMagick() {
  if (commandExists('magick') && isImageMagickCommand('magick')) return 'magick';
  if (process.platform !== 'win32' && commandExists('convert') && isImageMagickCommand('convert')) return 'convert';
  return undefined;
}

function findFfmpeg() {
  return commandExists('ffmpeg') ? 'ffmpeg' : undefined;
}

function walk(dir, extensions) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, extensions);
    if (!entry.isFile()) return [];
    return extensions.has(path.extname(entry.name).toLowerCase()) ? [full] : [];
  });
}

function newerThan(source, target) {
  if (!fs.existsSync(target)) return true;
  return fs.statSync(source).mtimeMs > fs.statSync(target).mtimeMs;
}

function writeManifest() {
  const sourceMedia = walk(sourceRoot, new Set([...imageExtensions, ...videoExtensions]));
  const thumbnails = sourceMedia
    .map((file) => path.join(thumbRoot, `${path.relative(sourceRoot, file)}.webp`))
    .filter((file) => fs.existsSync(file))
    .map((file) => `/img/thumbs/gallery/${path.relative(thumbRoot, file).replaceAll(path.sep, '/')}`)
    .sort();
  const version = thumbnails.reduce((latest, thumbnail) => {
    const file = path.join(thumbRoot, thumbnail.slice('/img/thumbs/gallery/'.length));
    return Math.max(latest, fs.statSync(file).mtimeMs);
  }, 0).toString(36);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(
    manifestPath,
    `export const galleryThumbnails = new Set<string>(${JSON.stringify(thumbnails, null, 2)});\n` +
      `export const galleryThumbnailVersion = ${JSON.stringify(version)};\n`
  );
  return thumbnails.length;
}

const imageMagick = findImageMagick();
const ffmpeg = findFfmpeg();
const sourceImages = walk(sourceRoot, imageExtensions);
const sourceVideos = walk(sourceRoot, videoExtensions);

if (clean) {
  const missingTools = [];
  if (sourceImages.length > 0 && !imageMagick) missingTools.push('ImageMagick (magick)');
  if (sourceVideos.length > 0 && !ffmpeg) missingTools.push('ffmpeg');

  if (missingTools.length > 0) {
    console.error(`Gallery thumbnail refresh stopped before cleanup. Missing: ${missingTools.join(', ')}.`);
    process.exit(1);
  }

  fs.rmSync(thumbRoot, { recursive: true, force: true });
  fs.rmSync(manifestPath, { force: true });
  console.log('Removed old gallery thumbnails and index.');
}

if (!imageMagick && !ffmpeg) {
  const manifestCount = writeManifest();
  console.warn(`Gallery thumbnails skipped: ImageMagick and ffmpeg were not found. ${manifestCount} existing thumbnails registered.`);
  process.exit(0);
}

const images = imageMagick ? sourceImages : [];
const videos = ffmpeg ? sourceVideos : [];
const total = images.length + videos.length;
let created = 0;
let skipped = 0;
let failed = 0;
let processed = 0;

function reportProgress() {
  processed += 1;
  if (processed === 1 || processed % 10 === 0 || processed === total) {
    console.log(`Gallery thumbnails: ${processed}/${total} processed...`);
  }
}

if (!imageMagick) console.warn('Gallery image thumbnails skipped: ImageMagick was not found.');
if (!ffmpeg) console.warn('Gallery video thumbnails skipped: ffmpeg was not found.');

for (const source of images) {
  const relative = path.relative(sourceRoot, source);
  const target = path.join(thumbRoot, `${relative}.webp`);
  if (!clean && !newerThan(source, target)) {
    skipped += 1;
    reportProgress();
    continue;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const input = `${source}[0]`;
  const result = spawnSync(imageMagick, [input, '-auto-orient', '-thumbnail', maxSize, '-strip', '-quality', '78', target], {
    encoding: 'utf8'
  });

  if (result.status === 0) {
    created += 1;
  } else {
    failed += 1;
    console.error(`Failed: ${source}`);
    if (result.stderr) console.error(result.stderr.trim());
  }
  reportProgress();
}

for (const source of videos) {
  const relative = path.relative(sourceRoot, source);
  const target = path.join(thumbRoot, `${relative}.webp`);
  if (!clean && !newerThan(source, target)) {
    skipped += 1;
    reportProgress();
    continue;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const result = spawnSync(ffmpeg, [
    '-y',
    '-i',
    source,
    '-frames:v',
    '1',
    '-vf',
    'scale=960:960:force_original_aspect_ratio=decrease',
    '-q:v',
    '5',
    target
  ], {
    encoding: 'utf8'
  });

  if (result.status === 0) {
    created += 1;
  } else {
    failed += 1;
    console.error(`Failed: ${source}`);
    if (result.stderr) console.error(result.stderr.trim());
  }
  reportProgress();
}

const manifestCount = writeManifest();
console.log(`Gallery thumbnails: ${created} created, ${skipped} skipped, ${failed} failed, ${manifestCount} registered.`);
if (failed > 0) process.exitCode = 1;
