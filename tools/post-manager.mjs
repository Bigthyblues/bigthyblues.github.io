import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, normalize, relative, resolve, sep } from "node:path";

const root = process.cwd();
const postsDir = resolve(root, "src/content/posts");
const publicDir = resolve(root, "public");
const preferredPort = Number(process.env.PORT ?? 4360);

const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".mp4", "video/mp4"],
  [".woff2", "font/woff2"],
  [".woff", "font/woff"],
  [".ttf", "font/ttf"]
]);

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(body);
}

function sendJson(res, value, status = 200) {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function safePostPath(file) {
  if (!file || file.includes("\0") || !file.endsWith(".md")) return null;
  const target = normalize(resolve(postsDir, file));
  return target === postsDir || target.startsWith(postsDir + sep) ? target : null;
}

function normalizeRelPath(file) {
  return file.replaceAll("\\", "/");
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\');
  }
  return trimmed;
}

function parseArray(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  const items = [];
  const pattern = /"((?:\\.|[^"])*)"/g;
  let match;
  while ((match = pattern.exec(trimmed))) {
    items.push(match[1].replaceAll('\\"', '"').replaceAll('\\\\', '\\'));
  }
  return items;
}

function parsePost(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: source };

  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    data[key] = value.startsWith("[") ? parseArray(value) : parseScalar(value);
  }
  return { data, body: match[2].trimEnd() };
}

function yamlString(value) {
  return `"${String(value ?? "").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function normalizeCharacters(value) {
  const source = Array.isArray(value) ? value : String(value ?? "").split(/[,/|]+/);
  return [...new Set(source.map((item) => String(item).trim()).filter(Boolean))];
}

function getImages(data) {
  const images = [];
  if (typeof data.image === "string" && data.image) images.push(data.image);
  if (Array.isArray(data.images)) images.push(...data.images.filter(Boolean));
  return [...new Set(images)];
}

function getImageCharacters(data) {
  return Array.isArray(data.imageCharacters) ? data.imageCharacters.filter(Boolean) : [];
}

function setImages(data, images) {
  delete data.image;
  delete data.images;
  const clean = [...new Set(String(images ?? "").split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean))];
  if (clean.length === 1) data.image = clean[0];
  if (clean.length > 1) data.images = clean;
}

function setImageCharacters(data, imageCharacters) {
  const clean = String(imageCharacters ?? "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);

  delete data.imageCharacters;
  if (clean.length) data.imageCharacters = clean;
}

function formatPost(data, body) {
  const lines = ["---"];
  const known = ["title", "author", "character", "type", "date", "image", "images", "imageCharacters", "video", "excerpt", "fanartSourceUrl", "fanartSourceStatus", "fanartArtist", "fanartArtistUrl", "fanartArtistStatus", "draft"];
  lines.push(`title: ${yamlString(data.title || "Untitled")}`);
  lines.push(`author: ${yamlString(data.author || "blues")}`);
  const characters = normalizeCharacters(data.character || "Blues");
  lines.push(characters.length > 1 ? `character: [${characters.map(yamlString).join(", ")}]` : `character: ${yamlString(characters[0] || "Blues")}`);
  lines.push(`type: ${yamlString(data.type || "image")}`);
  lines.push(`date: ${data.date || new Date().toISOString()}`);
  const images = getImages(data);
  const imageCharacters = getImageCharacters(data);
  if (images.length === 1) lines.push(`image: ${yamlString(images[0])}`);
  if (images.length > 1) lines.push(`images: [${images.map(yamlString).join(", ")}]`);
  if (imageCharacters.length) lines.push(`imageCharacters: [${imageCharacters.map(yamlString).join(", ")}]`);
  if (data.video) lines.push(`video: ${yamlString(data.video)}`);
  if (data.excerpt) lines.push(`excerpt: ${yamlString(data.excerpt)}`);
  if (data.fanartSourceUrl) lines.push(`fanartSourceUrl: ${yamlString(data.fanartSourceUrl)}`);
  if (data.fanartSourceStatus) lines.push(`fanartSourceStatus: ${yamlString(data.fanartSourceStatus)}`);
  if (data.fanartArtist) lines.push(`fanartArtist: ${yamlString(data.fanartArtist)}`);
  if (data.fanartArtistUrl) lines.push(`fanartArtistUrl: ${yamlString(data.fanartArtistUrl)}`);
  if (data.fanartArtistStatus) lines.push(`fanartArtistStatus: ${yamlString(data.fanartArtistStatus)}`);
  if (data.draft !== undefined) lines.push(`draft: ${data.draft === true ? "true" : "false"}`);

  for (const [key, value] of Object.entries(data)) {
    if (known.includes(key) || value === undefined || value === "") continue;
    if (Array.isArray(value)) lines.push(`${key}: [${value.map(yamlString).join(", ")}]`);
    else if (typeof value === "boolean") lines.push(`${key}: ${value ? "true" : "false"}`);
    else lines.push(`${key}: ${yamlString(value)}`);
  }

  lines.push("---", "", String(body ?? "").trimEnd(), "");
  return lines.join("\n");
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
  }
  return files;
}

async function readPost(file) {
  const target = safePostPath(file);
  if (!target) throw new Error("Invalid post file");
  const source = await readFile(target, "utf8");
  const parsed = parsePost(source);
  const stats = await stat(target);
  const images = getImages(parsed.data);
  return {
    file: normalizeRelPath(file),
    folder: normalizeRelPath(dirname(file)),
    title: String(parsed.data.title ?? "Untitled"),
    author: String(parsed.data.author ?? "blues"),
    date: String(parsed.data.date ?? ""),
    draft: parsed.data.draft === true,
    character: normalizeCharacters(parsed.data.character ?? "Blues").join(", "),
    type: String(parsed.data.type ?? "image"),
    excerpt: String(parsed.data.excerpt ?? ""),
    images,
    imageText: images.join("\n"),
    imageCharacters: getImageCharacters(parsed.data),
    imageCharactersText: getImageCharacters(parsed.data).join("\n"),
    video: typeof parsed.data.video === "string" ? parsed.data.video : "",
    fanartSourceUrl: String(parsed.data.fanartSourceUrl ?? ""),
    fanartSourceStatus: String(parsed.data.fanartSourceStatus ?? ""),
    fanartArtist: String(parsed.data.fanartArtist ?? ""),
    fanartArtistUrl: String(parsed.data.fanartArtistUrl ?? ""),
    fanartArtistStatus: String(parsed.data.fanartArtistStatus ?? ""),
    body: parsed.body,
    modified: stats.mtimeMs
  };
}

async function listPosts() {
  const files = await walk(postsDir);
  const posts = await Promise.all(files.map((file) => readPost(normalizeRelPath(relative(postsDir, file)))));
  posts.sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.file.localeCompare(b.file));
  return posts;
}

async function savePost(payload) {
  const target = safePostPath(payload.file);
  if (!target) throw new Error("Invalid post file");
  const currentStats = await stat(target);
  if (
    payload.modified !== undefined
    && Number(payload.modified) !== currentStats.mtimeMs
    && payload.force !== true
  ) {
    const error = new Error("This post changed on disk after it was opened. Reload it before saving, or confirm an overwrite.");
    error.status = 409;
    throw error;
  }
  const parsed = parsePost(await readFile(target, "utf8"));
  const data = { ...parsed.data };
  data.title = String(payload.title ?? data.title ?? "Untitled").trim() || "Untitled";
  data.author = String(payload.author ?? data.author ?? "blues").trim() || "blues";
  data.character = normalizeCharacters(payload.character ?? data.character ?? "Blues");
  data.type = String(payload.type ?? data.type ?? "image").trim() || "image";
  data.date = String(payload.date ?? data.date ?? new Date().toISOString()).trim();
  data.excerpt = String(payload.excerpt ?? data.excerpt ?? "").trim();
  data.video = String(payload.video ?? data.video ?? "").trim();
  data.fanartSourceUrl = String(payload.fanartSourceUrl ?? data.fanartSourceUrl ?? "").trim();
  data.fanartSourceStatus = String(payload.fanartSourceStatus ?? data.fanartSourceStatus ?? "").trim();
  data.fanartArtist = String(payload.fanartArtist ?? data.fanartArtist ?? "").trim();
  data.fanartArtistUrl = String(payload.fanartArtistUrl ?? data.fanartArtistUrl ?? "").trim();
  data.fanartArtistStatus = String(payload.fanartArtistStatus ?? data.fanartArtistStatus ?? "").trim();
  data.draft = Boolean(payload.draft);
  setImages(data, payload.imageText ?? getImages(data).join("\n"));
  setImageCharacters(data, payload.imageCharactersText ?? getImageCharacters(data).join("\n"));
  const body = payload.body === undefined ? parsed.body : String(payload.body);
  await writeFile(target, formatPost(data, body), "utf8");
  return readPost(payload.file);
}

function slugify(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 72) || "untitled";
}

function localDateParts(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return {
    day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}${pad(date.getMinutes())}`
  };
}

async function createPost(payload = {}) {
  const title = String(payload.title ?? "Untitled").trim() || "Untitled";
  const sourceFile = payload.sourceFile ? safePostPath(payload.sourceFile) : null;
  let sourceData = {};
  let sourceBody = "";
  if (sourceFile) {
    const parsed = parsePost(await readFile(sourceFile, "utf8"));
    sourceData = parsed.data;
    sourceBody = parsed.body;
  }

  const parts = localDateParts();
  const requestedBase = String(payload.fileBase ?? "").trim();
  const seed = requestedBase || `${parts.day}-${parts.time}-${slugify(title)}`;
  let file = `${slugify(seed)}.md`;
  let target = safePostPath(file);
  for (let suffix = 2; target; suffix += 1) {
    try {
      await stat(target);
      file = `${slugify(seed)}-${suffix}.md`;
      target = safePostPath(file);
    } catch {
      break;
    }
  }
  if (!target) throw new Error("Could not create a safe post filename");

  const data = {
    ...sourceData,
    title,
    date: new Date().toISOString(),
    draft: true
  };
  await writeFile(target, formatPost(data, sourceFile ? sourceBody : ""), { encoding: "utf8", flag: "wx" });
  return readPost(file);
}

async function bulkUpdate(payload) {
  const files = Array.isArray(payload.files) ? payload.files : [];
  const changes = payload.changes ?? {};
  const changed = [];
  for (const file of files) {
    const current = await readPost(file);
    const next = { ...current };
    if (changes.character !== undefined) next.character = String(changes.character).trim();
    if (changes.type !== undefined) next.type = String(changes.type).trim();
    if (changes.draft !== undefined) next.draft = Boolean(changes.draft);
    changed.push(await savePost(next));
  }
  return changed;
}

function pageHtml() {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Post Manager</title>
  <style>
    @font-face { font-family: Tenacity; src: url('/fonts/Tenacity.woff2') format('woff2'); }
    :root { --bg:#96b5ff; --panel:#fbf8ff; --paper:#ffffff; --ink:#2d1f2e; --line:#3d2a3e; --mint:#dff8ee; --pink:#ffd5e7; --blue:#dbeaff; --orange:#ffca8f; }
    * { box-sizing:border-box; }
    body { margin:0; font-family: Tenacity, ui-monospace, monospace; color:var(--ink); background:var(--bg); font-size:18px; }
    button, input, textarea, select { font:inherit; color:inherit; }
    .app { display:grid; grid-template-columns: 430px minmax(0, 1fr); height:100vh; }
    aside { border-right:4px solid var(--line); background:rgba(251,248,255,.92); overflow:hidden; display:grid; grid-template-rows:auto auto auto auto minmax(0,1fr); }
    header { padding:14px; border-bottom:4px solid var(--line); display:grid; gap:10px; }
    h1 { margin:0; font-size:30px; font-weight:400; }
    .header-row, .list-tools { display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }
    .header-actions, .list-tools { display:grid; grid-template-columns:repeat(3,1fr); }
    .stats { display:flex; gap:8px; flex-wrap:wrap; font-size:15px; }
    .pill { border:3px solid var(--line); padding:4px 8px; background:white; }
    .filters, .bulk { display:grid; grid-template-columns:1fr 1fr; gap:8px; padding:12px 14px; border-bottom:4px solid var(--line); }
    .filters input, .bulk input, .bulk button { grid-column:1 / -1; }
    input, textarea, select { width:100%; border:3px solid var(--line); background:white; padding:8px; }
    button { border:3px solid var(--line); background:white; padding:8px; cursor:pointer; }
    button:disabled { cursor:wait; opacity:.55; }
    .bulk button { background:var(--orange); }
    .list-tools { padding:8px 14px; border-bottom:4px solid var(--line); }
    .list { overflow:auto; }
    .row { width:100%; text-align:left; border:0; border-bottom:2px solid rgba(61,42,62,.25); background:transparent; padding:10px 14px; display:grid; grid-template-columns:auto minmax(0,1fr); gap:10px; cursor:pointer; }
    .row:hover, .row.is-active { background:var(--blue); }
    .row input { width:auto; margin-top:4px; }
    .row-title { font-size:17px; line-height:1.15; overflow-wrap:anywhere; }
    .row-meta { font-size:13px; color:#6f6170; display:flex; justify-content:space-between; gap:8px; }
    main { overflow:auto; padding:22px; }
    .editor { max-width:1320px; margin:0 auto; display:grid; grid-template-columns:minmax(0, 820px) minmax(360px, 430px); gap:18px; align-items:start; justify-content:center; }
    .preview, .fields, .body-panel { border:4px solid var(--line); background:var(--panel); box-shadow:8px 8px 0 rgba(61,42,62,.2); }
    .preview { grid-row:1 / span 2; padding:16px; display:grid; gap:15px; align-content:start; }
    .preview-head { display:flex; justify-content:space-between; gap:12px; align-items:start; }
    .preview h2 { margin:0; font-size:clamp(30px,4vw,54px); font-weight:400; overflow-wrap:anywhere; }
    .preview-meta { margin:4px 0 0; color:#6f6170; }
    .preview-rule { height:4px; background:var(--line); }
    .media { display:grid; gap:16px; justify-items:center; }
    .media img, .media video { width:100%; max-width:780px; justify-self:center; max-height:78vh; object-fit:contain; background:white; border:3px solid var(--line); }
    .fields { padding:16px; display:grid; gap:11px; position:sticky; top:18px; background:var(--paper); }
    .two { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    .three { display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; }
    .draft-row { display:flex; align-items:center; gap:10px; }
    .draft-row input { width:auto; }
    label { display:grid; gap:6px; }
    .actions { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .save { background:var(--mint) !important; }
    .draft { background:var(--pink) !important; }
    .body-panel { grid-column:2; padding:16px; display:grid; gap:10px; background:var(--paper); }
    .toolbar { display:grid; grid-template-columns:repeat(auto-fit,minmax(58px,1fr)); gap:6px; }
    .toolbar button { padding:6px; }
    .toolbar [data-color]::before { content:''; display:inline-block; width:12px; height:12px; margin-right:5px; border:2px solid var(--line); background:var(--swatch); vertical-align:-1px; }
    .body-preview { font-family:Tenacity,ui-monospace,monospace; font-size:24px; line-height:1.35; overflow-wrap:anywhere; }
    .body-preview p, .body-preview h2, .body-preview h3, .body-preview blockquote { margin:0 0 .75em; }
    .body-preview img { max-width:100%; border:3px solid var(--line); }
    .body-preview a { color:#c2198b; }
    .md-center { display:block; text-align:center; }
    .md-size-small { font-size:.82em; }
    .md-size-large { font-size:1.28em; }
    .md-mark { background:#fff2b8; }
    .md-box { display:inline-block; padding:.1em .25em; border:2px solid currentColor; }
    .md-color-blues { color:#315ebb; } .md-color-fizz { color:#e1494a; } .md-color-glup { color:#5f9f2f; }
    .md-color-mish { color:#8060c7; } .md-color-verde { color:#629d27; } .md-color-rushy { color:#d86417; }
    body.is-dirty h1::after { content:' • unsaved'; color:#b21b34; font-size:16px; }
    textarea { min-height:118px; resize:vertical; line-height:1.25; }
    #body { min-height:220px; }
    .empty { border:4px solid var(--line); background:var(--panel); padding:24px; text-align:center; }
    .status { min-height:22px; font-size:15px; color:#4d7a59; }
    small { overflow-wrap:anywhere; color:#6f6170; }
    @media (max-width: 1050px) { .app { grid-template-columns:1fr; height:auto; } aside { height:65vh; border-right:0; border-bottom:4px solid var(--line); } .editor { grid-template-columns:1fr; } .preview, .body-panel { grid-column:auto; grid-row:auto; } .fields { position:static; } }
  </style>
</head>
<body>
  <div class="app">
    <aside>
      <header>
        <div class="header-row"><h1>Post Manager</h1></div>
        <div class="header-actions"><button id="newPost">New</button><button id="duplicatePost">Duplicate</button><button id="reloadPost">Reload</button></div>
        <div class="stats" id="stats"></div>
      </header>
      <div class="filters">
        <input id="search" type="search" placeholder="search title/body/file/artist" />
        <select id="statusFilter"><option value="all">all status</option><option value="published">published</option><option value="draft">draft</option></select>
        <select id="typeFilter"><option value="all">all type</option><option value="image">image</option><option value="video">video</option><option value="text">text</option><option value="fanart">fanart</option></select>
        <select id="mediaFilter"><option value="all">all media</option><option value="multi-image">multiple images</option><option value="single-image">single image</option><option value="no-image">no image</option><option value="has-video">has video</option></select>
        <select id="characterFilter"><option value="all">all character</option></select>
        <select id="folderFilter"><option value="all">all folder</option><option value="root">posts root</option><option value="imported-drafts">imported-drafts</option></select>
        <select id="sort"><option value="newest">newest</option><option value="oldest">oldest</option><option value="file">file</option></select>
      </div>
      <div class="bulk">
        <input id="bulkCharacter" placeholder="bulk character: Blues, Fizz" />
        <select id="bulkTarget"><option value="selected">selected rows</option><option value="visible">visible filtered rows</option></select>
        <select id="bulkType"><option value="">keep type</option><option value="image">image</option><option value="video">video</option><option value="text">text</option><option value="fanart">fanart</option></select>
        <select id="bulkStatus"><option value="">keep status</option><option value="published">publish</option><option value="draft">keep draft</option></select>
        <button id="bulkApply">Apply bulk changes</button>
      </div>
      <div class="list-tools"><button id="selectVisible">Select visible</button><button id="clearSelected">Clear</button><button id="refreshList">Refresh list</button></div>
      <div class="list" id="list"></div>
    </aside>
    <main id="main"><div class="empty">Loading...</div></main>
  </div>
<script>
const state = { posts: [], active: null, status: 'all', type: 'all', media: 'all', character: 'all', folder: 'all', search: '', sort: 'newest', selected: new Set(), dirty: false, saving: false };
const list = document.querySelector('#list');
const main = document.querySelector('#main');
const stats = document.querySelector('#stats');
const search = document.querySelector('#search');
const statusFilter = document.querySelector('#statusFilter');
const typeFilter = document.querySelector('#typeFilter');
const mediaFilter = document.querySelector('#mediaFilter');
const characterFilter = document.querySelector('#characterFilter');
const folderFilter = document.querySelector('#folderFilter');
const sort = document.querySelector('#sort');
const bulkCharacter = document.querySelector('#bulkCharacter');
const bulkTarget = document.querySelector('#bulkTarget');
const bulkType = document.querySelector('#bulkType');
const bulkStatus = document.querySelector('#bulkStatus');
const bulkApply = document.querySelector('#bulkApply');
const newPost = document.querySelector('#newPost');
const duplicatePost = document.querySelector('#duplicatePost');
const reloadPost = document.querySelector('#reloadPost');
const selectVisible = document.querySelector('#selectVisible');
const clearSelected = document.querySelector('#clearSelected');
const refreshList = document.querySelector('#refreshList');

async function api(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let message = await response.text();
    try { message = JSON.parse(message).error || message; } catch {}
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function setDirty(value) {
  state.dirty = value;
  document.body.classList.toggle('is-dirty', value);
}

function setStatus(message, error) {
  const output = document.querySelector('#status');
  if (!output) return;
  output.textContent = message;
  output.style.color = error ? '#b21b34' : '#4d7a59';
}

function draftKey(file) { return 'post-manager:draft:' + file; }
function saveBrowserDraft() {
  if (!state.active || !state.dirty) return;
  try { localStorage.setItem(draftKey(state.active.file), JSON.stringify({ savedAt: Date.now(), payload: payloadFromForm() })); } catch {}
}
function clearBrowserDraft(file) { try { localStorage.removeItem(draftKey(file)); } catch {} }

function characterKeys(post) { return post.character.split(',').map(item => item.trim().toLowerCase()).filter(Boolean); }
function folderMatches(post) { if (state.folder === 'all') return true; if (state.folder === 'root') return !post.file.includes('/'); return post.file.startsWith(state.folder + '/'); }
function filteredPosts() {
  let posts = [...state.posts];
  if (state.status === 'published') posts = posts.filter(post => !post.draft);
  if (state.status === 'draft') posts = posts.filter(post => post.draft);
  if (state.type !== 'all') posts = posts.filter(post => post.type === state.type);
  if (state.media === 'multi-image') posts = posts.filter(post => post.images.length > 1);
  if (state.media === 'single-image') posts = posts.filter(post => post.images.length === 1);
  if (state.media === 'no-image') posts = posts.filter(post => post.images.length === 0);
  if (state.media === 'has-video') posts = posts.filter(post => Boolean(post.video));
  if (state.character !== 'all') posts = posts.filter(post => characterKeys(post).includes(state.character));
  posts = posts.filter(folderMatches);
  const q = state.search.trim().toLowerCase();
  if (q) posts = posts.filter(post => [post.title, post.file, post.body, post.excerpt, post.character, post.fanartArtist].join(' ').toLowerCase().includes(q));
  if (state.sort === 'oldest') posts.sort((a,b) => String(a.date).localeCompare(String(b.date)) || a.file.localeCompare(b.file));
  if (state.sort === 'newest') posts.sort((a,b) => String(b.date).localeCompare(String(a.date)) || a.file.localeCompare(b.file));
  if (state.sort === 'file') posts.sort((a,b) => a.file.localeCompare(b.file));
  return posts;
}

function renderFilters() {
  const chars = new Map();
  for (const post of state.posts) for (const character of post.character.split(',').map(item => item.trim()).filter(Boolean)) chars.set(character.toLowerCase(), character);
  const active = state.character;
  characterFilter.innerHTML = '<option value="all">all character</option>' + [...chars.entries()].sort((a,b) => a[1].localeCompare(b[1])).map(([key,label]) => '<option value="' + escapeAttr(key) + '">' + escapeHtml(label) + '</option>').join('');
  characterFilter.value = active;
  const activeFolder = state.folder;
  const folders = [...new Set(state.posts.map(post => post.folder).filter(folder => folder && folder !== '.'))].sort();
  folderFilter.innerHTML = '<option value="all">all folder</option><option value="root">posts root</option>' + folders.map(folder => '<option value="' + escapeAttr(folder) + '">' + escapeHtml(folder) + '</option>').join('');
  folderFilter.value = folders.includes(activeFolder) || activeFolder === 'all' || activeFolder === 'root' ? activeFolder : 'all';
  state.folder = folderFilter.value;
}

function renderList() {
  const fanart = state.posts.filter(post => post.type === 'fanart').length;
  const drafts = state.posts.filter(post => post.draft).length;
  const multiImage = state.posts.filter(post => post.images.length > 1).length;
  const visible = filteredPosts();
  stats.innerHTML = '<span class="pill">all ' + state.posts.length + '</span><span class="pill">visible ' + visible.length + '</span><span class="pill">multi-image ' + multiImage + '</span><span class="pill">draft ' + drafts + '</span><span class="pill">fanart ' + fanart + '</span><span class="pill">selected ' + state.selected.size + '</span>';
  list.innerHTML = visible.map(post => '<button class="row ' + (state.active?.file === post.file ? 'is-active' : '') + '" data-file="' + escapeHtml(post.file) + '"><input type="checkbox" data-select="' + escapeHtml(post.file) + '" ' + (state.selected.has(post.file) ? 'checked' : '') + ' /><span><span class="row-title">' + escapeHtml(post.title) + '</span><span class="row-meta"><span>' + escapeHtml(post.character) + '</span><span>' + escapeHtml(post.type) + ' / ' + post.images.length + ' image' + (post.images.length === 1 ? '' : 's') + (post.video ? ' + video' : '') + '</span></span></span></button>').join('') || '<div class="empty">No matches</div>';
}

function renderEditor(post) {
  if (!post) { main.innerHTML = '<div class="empty">Pick a post from the list.</div>'; return; }
  const mediaHtml = [post.video ? '<video src="' + escapeHtml(post.video) + '" ' + (post.images[0] ? 'poster="' + escapeHtml(post.images[0]) + '" ' : '') + 'controls muted playsinline preload="metadata"></video>' : '', ...post.images.map(src => '<img src="' + escapeHtml(src) + '" alt="" />')].filter(Boolean).join('');
  main.innerHTML = '<div class="editor">' +
    '<section class="preview"><div class="preview-head"><div><h2 id="previewTitle">' + escapeHtml(post.title) + '</h2><p class="preview-meta" id="previewMeta">' + escapeHtml(post.date + ' · ' + post.character) + '</p></div><span class="pill" id="previewStatus">' + (post.draft ? 'draft' : 'published') + '</span></div><div class="preview-rule"></div><div class="media" id="mediaPreview">' + (mediaHtml || '<div class="empty">No media</div>') + '</div><div class="preview-rule"></div><div class="body-preview" id="bodyPreview">' + (markdownToHtml(post.body) || '<p>' + escapeHtml(post.excerpt) + '</p>') + '</div></section>' +
    '<section class="fields">' +
      '<div class="actions"><button type="button" id="previousPost">Previous</button><button type="button" id="nextPost">Next</button></div>' +
      '<label>Title<input id="title" value="' + escapeAttr(post.title) + '" /></label>' +
      '<div class="three"><label>Author<input id="author" value="' + escapeAttr(post.author) + '" /></label><label>Status<select id="draftStatus"><option value="published">published</option><option value="draft">draft</option></select></label><label>Type<select id="type"><option value="image">image</option><option value="text">text</option><option value="video">video</option><option value="fanart">fanart</option></select></label></div>' +
      '<label>Character<input id="character" value="' + escapeAttr(post.character) + '" placeholder="Blues, Fizz" /></label>' +
      '<label>Date<input id="date" value="' + escapeAttr(post.date) + '" /></label>' +
      '<label>Images<textarea id="imageText">' + escapeHtml(post.imageText) + '</textarea></label>' +
      '<label>Image characters<textarea id="imageCharactersText" placeholder="Blues|Fizz&#10;Blues">' + escapeHtml(post.imageCharactersText) + '</textarea><small>One row per image. Empty rows mean all post characters.</small></label>' +
      '<label>Video<input id="video" value="' + escapeAttr(post.video) + '" /></label>' +
      '<label>Excerpt<textarea id="excerpt">' + escapeHtml(post.excerpt) + '</textarea></label>' +
      '<div class="two"><label>Artist<input id="fanartArtist" value="' + escapeAttr(post.fanartArtist) + '" /></label><label>Artist URL<input id="fanartArtistUrl" value="' + escapeAttr(post.fanartArtistUrl) + '" /></label></div>' +
      '<div class="two"><label>Artist status<input id="fanartArtistStatus" value="' + escapeAttr(post.fanartArtistStatus) + '" /></label><label>Source status<input id="fanartSourceStatus" value="' + escapeAttr(post.fanartSourceStatus) + '" /></label></div>' +
      '<label>Source URL / note<input id="fanartSourceUrl" value="' + escapeAttr(post.fanartSourceUrl) + '" /></label>' +
      '<div class="actions"><button type="button" class="save" id="save">Save</button><button type="button" class="wide" id="saveNext">Save & next</button></div>' +
      '<div class="actions"><button type="button" class="save" id="publish">Publish</button><button type="button" class="draft" id="keepDraft">Keep draft</button></div>' +
      '<div class="status" id="status"></div><small>' + escapeHtml(post.file) + '</small>' +
    '</section>' +
    '<section class="body-panel"><div class="toolbar" aria-label="Formatting tools"><button type="button" data-format="bold">B</button><button type="button" data-format="italic">I</button><button type="button" data-format="heading">H</button><button type="button" data-format="quote">Quote</button><button type="button" data-format="list">List</button><button type="button" data-format="link">Link</button><button type="button" data-format="image">Image</button><button type="button" data-format="code">Code</button><button type="button" data-format="large">Big</button><button type="button" data-format="small">Small</button><button type="button" data-format="center">Center</button><button type="button" data-format="mark">Mark</button><button type="button" data-format="del">Del</button><button type="button" data-format="box">Box</button></div><div class="toolbar" aria-label="Color tools"><button type="button" data-color="blues" style="--swatch:#315ebb">Blues</button><button type="button" data-color="fizz" style="--swatch:#e1494a">Fizz</button><button type="button" data-color="glup" style="--swatch:#98e75f">Glup</button><button type="button" data-color="mish" style="--swatch:#b89dff">Mish</button><button type="button" data-color="verde" style="--swatch:#baff69">Verde</button><button type="button" data-color="rushy" style="--swatch:#ff9b4b">Rushy</button><button type="button" data-custom-color="text">Text hex</button><button type="button" data-custom-color="background">Bg hex</button></div><label>Body<textarea id="body">' + escapeHtml(post.body) + '</textarea></label><small><span id="bodyCount"></span> · Ctrl+S saves · Alt+←/→ navigates</small></section>' +
  '</div>';
  document.querySelector('#type').value = post.type;
  document.querySelector('#draftStatus').value = post.draft ? 'draft' : 'published';
  document.querySelector('#save').addEventListener('click', () => save(false));
  document.querySelector('#saveNext').addEventListener('click', () => save(true));
  document.querySelector('#publish').addEventListener('click', () => { document.querySelector('#draftStatus').value = 'published'; save(true); });
  document.querySelector('#keepDraft').addEventListener('click', () => { document.querySelector('#draftStatus').value = 'draft'; save(true); });
  document.querySelector('#previousPost').addEventListener('click', () => navigatePost(-1));
  document.querySelector('#nextPost').addEventListener('click', () => navigatePost(1));
  document.querySelectorAll('[data-format]').forEach(button => button.addEventListener('click', () => applyFormat(button.dataset.format)));
  document.querySelectorAll('[data-color]').forEach(button => button.addEventListener('click', () => wrapSelection('[color=' + button.dataset.color + ']', '[/color]', button.dataset.color)));
  document.querySelectorAll('[data-custom-color]').forEach(button => button.addEventListener('click', () => applyCustomColor(button.dataset.customColor)));
  main.querySelectorAll('input, textarea, select').forEach(input => {
    input.addEventListener('input', handleEditorInput);
    input.addEventListener('change', handleEditorInput);
  });
  updatePreview();
}

async function selectPost(file, options = {}) {
  if (!file) return;
  if (!options.skipDirty && state.dirty && !confirm('Discard unsaved changes? A browser recovery copy will remain available.')) return;
  state.active = await api('/api/post?file=' + encodeURIComponent(file));
  setDirty(false);
  renderList();
  renderEditor(state.active);
  if (!options.skipDraft) restoreBrowserDraft();
}

function payloadFromForm() {
  return {
    file: state.active.file,
    title: document.querySelector('#title').value,
    author: document.querySelector('#author').value,
    character: document.querySelector('#character').value,
    type: document.querySelector('#type').value,
    date: document.querySelector('#date').value,
    imageText: document.querySelector('#imageText').value,
    imageCharactersText: document.querySelector('#imageCharactersText').value,
    video: document.querySelector('#video').value,
    excerpt: document.querySelector('#excerpt').value,
    fanartArtist: document.querySelector('#fanartArtist').value,
    fanartArtistUrl: document.querySelector('#fanartArtistUrl').value,
    fanartArtistStatus: document.querySelector('#fanartArtistStatus').value,
    fanartSourceUrl: document.querySelector('#fanartSourceUrl').value,
    fanartSourceStatus: document.querySelector('#fanartSourceStatus').value,
    draft: document.querySelector('#draftStatus').value === 'draft',
    body: document.querySelector('#body').value,
    modified: state.active.modified
  };
}

async function save(goNext, force = false) {
  if (!state.active || state.saving) return;
  state.saving = true;
  document.querySelectorAll('#save, #saveNext, #publish, #keepDraft').forEach(button => button.disabled = true);
  setStatus('Saving...');
  const payload = payloadFromForm();
  if (force) payload.force = true;
  let retryWithForce = false;
  try {
    const saved = await api('/api/post', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    const index = state.posts.findIndex(post => post.file === saved.file);
    if (index !== -1) state.posts[index] = saved;
    state.active = saved;
    clearBrowserDraft(saved.file);
    setDirty(false);
    renderFilters();
    renderList();
    setStatus('Saved without reloading the page.');
    if (goNext) await navigatePost(1, true);
  } catch (error) {
    if (error.status === 409 && confirm(error.message + '\n\nOverwrite the disk version with the editor contents?')) {
      retryWithForce = true;
    } else {
      setStatus(error.message, true);
    }
  } finally {
    state.saving = false;
    document.querySelectorAll('#save, #saveNext, #publish, #keepDraft').forEach(button => button.disabled = false);
  }
  if (retryWithForce) return save(goNext, true);
}

async function navigatePost(direction, skipDirty = false) {
  const posts = filteredPosts();
  if (!posts.length) return;
  const current = posts.findIndex(post => post.file === state.active?.file);
  const nextIndex = current < 0 ? 0 : (current + direction + posts.length) % posts.length;
  await selectPost(posts[nextIndex].file, { skipDirty });
}

async function reloadActive() {
  if (!state.active) return;
  if (state.dirty && !confirm('Reload from disk and discard the current editor contents?')) return;
  clearBrowserDraft(state.active.file);
  await selectPost(state.active.file, { skipDirty: true, skipDraft: true });
  setStatus('Reloaded from disk.');
}

function hydrateForm(payload) {
  for (const [key, value] of Object.entries(payload)) {
    const input = document.querySelector('#' + key);
    if (input && typeof value !== 'object') input.value = value;
  }
  if (document.querySelector('#draftStatus')) document.querySelector('#draftStatus').value = payload.draft ? 'draft' : 'published';
  updatePreview();
}

function restoreBrowserDraft() {
  if (!state.active) return;
  try {
    const draft = JSON.parse(localStorage.getItem(draftKey(state.active.file)) || 'null');
    if (!draft?.payload) return;
    if (confirm('A browser recovery copy exists for this post. Restore it?')) {
      hydrateForm(draft.payload);
      setDirty(true);
      setStatus('Recovered an unsaved browser copy.');
    } else {
      clearBrowserDraft(state.active.file);
    }
  } catch {}
}

async function applyBulk() {
  const visible = filteredPosts().map(post => post.file);
  const files = bulkTarget.value === 'visible' ? visible : [...state.selected];
  if (!files.length) return alert('No posts selected.');
  const changes = {};
  if (bulkCharacter.value.trim()) changes.character = bulkCharacter.value.trim();
  if (bulkType.value) changes.type = bulkType.value;
  if (bulkStatus.value) changes.draft = bulkStatus.value === 'draft';
  if (!Object.keys(changes).length) return alert('No bulk change entered.');
  if (!confirm('Apply changes to ' + files.length + ' posts?')) return;
  const changed = await api('/api/bulk', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ files, changes }) });
  for (const saved of changed) {
    const index = state.posts.findIndex(post => post.file === saved.file);
    if (index !== -1) state.posts[index] = saved;
  }
  state.selected.clear();
  renderFilters();
  renderList();
  if (state.active) selectPost(state.active.file);
}

function escapeHtml(value) { return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'); }
function escapeAttr(value) { return escapeHtml(value).replaceAll("'", '&#39;'); }

function renderInline(value) {
  let html = escapeHtml(value);
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  html = html.replace(/\x60(.*?)\x60/g, '<code>$1</code>');
  html = html.replace(/\[hex=(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}))\]([\s\S]*?)\[\/hex\]/g, '<span style="color:$1">$2</span>');
  html = html.replace(/\[bg=(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}))\]([\s\S]*?)\[\/bg\]/g, '<span style="background-color:$1">$2</span>');
  html = html.replace(/\[color=([a-z0-9-]+)\]([\s\S]*?)\[\/color\]/g, '<span class="md-color-$1">$2</span>');
  html = html.replace(/\[size=(small|large)\]([\s\S]*?)\[\/size\]/g, '<span class="md-size-$1">$2</span>');
  html = html.replace(/\[center\]([\s\S]*?)\[\/center\]/g, '<span class="md-center">$1</span>');
  html = html.replace(/\[mark\]([\s\S]*?)\[\/mark\]/g, '<span class="md-mark">$1</span>');
  html = html.replace(/\[del\]([\s\S]*?)\[\/del\]/g, '<del>$1</del>');
  html = html.replace(/\[box\]([\s\S]*?)\[\/box\]/g, '<span class="md-box">$1</span>');
  html = html.replace(/!\[(.*?)\]\((.*?)\)/g, '<img src="$2" alt="$1" />');
  html = html.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return html;
}

function markdownToHtml(markdown) {
  return String(markdown ?? '').split(/\r?\n/).map(line => {
    if (line.startsWith('# ')) return '<h2>' + renderInline(line.slice(2)) + '</h2>';
    if (line.startsWith('## ')) return '<h3>' + renderInline(line.slice(3)) + '</h3>';
    if (line.startsWith('### ')) return '<h4>' + renderInline(line.slice(4)) + '</h4>';
    if (line.startsWith('> ')) return '<blockquote>' + renderInline(line.slice(2)) + '</blockquote>';
    if (line.startsWith('- ')) return '<p>&bull; ' + renderInline(line.slice(2)) + '</p>';
    if (!line.trim()) return '';
    return '<p>' + renderInline(line) + '</p>';
  }).join('');
}

function bodyField() { return document.querySelector('#body'); }
function wrapSelection(before, after, placeholder) {
  const body = bodyField();
  if (!body) return;
  const start = body.selectionStart;
  const end = body.selectionEnd;
  const selected = body.value.slice(start, end) || placeholder;
  body.setRangeText(before + selected + after, start, end, 'select');
  body.focus();
  handleEditorInput();
}
function prefixLine(prefix, placeholder) {
  const body = bodyField();
  if (!body) return;
  const start = body.selectionStart;
  const lineStart = body.value.lastIndexOf('\n', start - 1) + 1;
  body.setRangeText(prefix, lineStart, lineStart, 'end');
  if (body.selectionStart === body.selectionEnd) body.setRangeText(placeholder, body.selectionStart, body.selectionEnd, 'select');
  body.focus();
  handleEditorInput();
}
function applyFormat(format) {
  if (format === 'bold') wrapSelection('**', '**', 'bold text');
  if (format === 'italic') wrapSelection('*', '*', 'italic text');
  if (format === 'heading') prefixLine('## ', 'Heading');
  if (format === 'quote') prefixLine('> ', 'Quote');
  if (format === 'list') prefixLine('- ', 'List item');
  if (format === 'link') wrapSelection('[', '](https://example.com)', 'link text');
  if (format === 'image') wrapSelection('![', '](/img/gallery/image.png)', 'image alt');
  if (format === 'code') wrapSelection(String.fromCharCode(96), String.fromCharCode(96), 'code');
  if (format === 'large') wrapSelection('[size=large]', '[/size]', 'large text');
  if (format === 'small') wrapSelection('[size=small]', '[/size]', 'small text');
  if (format === 'center') wrapSelection('[center]', '[/center]', 'centered text');
  if (format === 'mark') wrapSelection('[mark]', '[/mark]', 'marked text');
  if (format === 'del') wrapSelection('[del]', '[/del]', 'deleted text');
  if (format === 'box') wrapSelection('[box]', '[/box]', 'boxed text');
}
function applyCustomColor(kind) {
  const value = prompt(kind === 'background' ? 'Background hex color:' : 'Text hex color:', kind === 'background' ? '#fff0a8' : '#315ebb');
  if (value === null) return;
  const hex = value.trim();
  if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex)) return alert('Use a hex color such as #315ebb.');
  wrapSelection(kind === 'background' ? '[bg=' + hex + ']' : '[hex=' + hex + ']', kind === 'background' ? '[/bg]' : '[/hex]', 'colored text');
}

function updatePreview() {
  const title = document.querySelector('#title');
  const date = document.querySelector('#date');
  const character = document.querySelector('#character');
  const status = document.querySelector('#draftStatus');
  const body = bodyField();
  const imageText = document.querySelector('#imageText');
  const video = document.querySelector('#video');
  if (!title || !body) return;
  document.querySelector('#previewTitle').textContent = title.value || 'Untitled';
  document.querySelector('#previewMeta').textContent = date.value + ' · ' + character.value;
  document.querySelector('#previewStatus').textContent = status.value;
  document.querySelector('#bodyPreview').innerHTML = markdownToHtml(body.value) || '<p>' + escapeHtml(document.querySelector('#excerpt').value) + '</p>';
  document.querySelector('#bodyCount').textContent = body.value.length + ' characters, ' + body.value.trim().split(/\s+/).filter(Boolean).length + ' words';
  const images = imageText.value.split(/\r?\n|,/).map(value => value.trim()).filter(Boolean);
  const media = [video.value ? '<video src="' + escapeAttr(video.value) + '" ' + (images[0] ? 'poster="' + escapeAttr(images[0]) + '" ' : '') + 'controls muted playsinline preload="metadata"></video>' : ''].concat(images.map(src => '<img src="' + escapeAttr(src) + '" alt="" loading="lazy" />')).filter(Boolean).join('');
  const mediaPreview = document.querySelector('#mediaPreview');
  const mediaSignature = video.value + '\n' + images.join('\n');
  if (mediaPreview.dataset.signature !== mediaSignature) {
    mediaPreview.dataset.signature = mediaSignature;
    mediaPreview.innerHTML = media || '<div class="empty">No media</div>';
  }
}

function handleEditorInput() {
  setDirty(true);
  updatePreview();
  saveBrowserDraft();
}

async function refreshPosts(keepActive = true) {
  const activeFile = keepActive ? state.active?.file : '';
  state.posts = await api('/api/posts');
  renderFilters();
  renderList();
  if (activeFile && state.posts.some(post => post.file === activeFile)) await selectPost(activeFile, { skipDirty: true });
}

async function createNewPost(duplicate = false) {
  if (state.dirty && !confirm('Create another post and leave the current unsaved editor contents?')) return;
  const suggested = duplicate && state.active ? state.active.title + ' copy' : '';
  const title = prompt(duplicate ? 'Title for the duplicated post:' : 'Title for the new post:', suggested);
  if (title === null || !title.trim()) return;
  try {
    const created = await api('/api/create', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ title:title.trim(), sourceFile:duplicate ? state.active?.file : '' }) });
    state.posts.unshift(created);
    renderFilters();
    await selectPost(created.file, { skipDirty:true, skipDraft:true });
    setStatus(duplicate ? 'Duplicated as a draft.' : 'Created a new draft.');
  } catch (error) {
    alert(error.message);
  }
}

list.addEventListener('click', event => {
  const checkbox = event.target.closest('[data-select]');
  if (checkbox) { event.stopPropagation(); checkbox.checked ? state.selected.add(checkbox.dataset.select) : state.selected.delete(checkbox.dataset.select); renderList(); return; }
  const button = event.target.closest('[data-file]');
  if (button) selectPost(button.dataset.file);
});
search.addEventListener('input', () => { state.search = search.value; renderList(); });
statusFilter.addEventListener('change', () => { state.status = statusFilter.value; renderList(); });
typeFilter.addEventListener('change', () => { state.type = typeFilter.value; renderList(); });
mediaFilter.addEventListener('change', () => { state.media = mediaFilter.value; renderList(); });
characterFilter.addEventListener('change', () => { state.character = characterFilter.value; renderList(); });
folderFilter.addEventListener('change', () => { state.folder = folderFilter.value; renderList(); });
sort.addEventListener('change', () => { state.sort = sort.value; renderList(); });
bulkApply.addEventListener('click', applyBulk);
newPost.addEventListener('click', () => createNewPost(false));
duplicatePost.addEventListener('click', () => createNewPost(true));
reloadPost.addEventListener('click', reloadActive);
selectVisible.addEventListener('click', () => { filteredPosts().forEach(post => state.selected.add(post.file)); renderList(); });
clearSelected.addEventListener('click', () => { state.selected.clear(); renderList(); });
refreshList.addEventListener('click', async () => {
  if (state.dirty && !confirm('Refresh the list and reload the current post from disk?')) return;
  await refreshPosts(true);
  setStatus('Post list refreshed.');
});
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(event.shiftKey); }
  if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); navigatePost(-1); }
  if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); navigatePost(1); }
});
window.addEventListener('beforeunload', event => {
  if (!state.dirty) return;
  saveBrowserDraft();
  event.preventDefault();
  event.returnValue = '';
});

api('/api/posts').then(posts => { state.posts = posts; renderFilters(); renderList(); selectPost(filteredPosts()[0]?.file, { skipDirty:true }); }).catch(error => { main.innerHTML = '<div class="empty">' + escapeHtml(error.message) + '</div>'; });
</script>
</body>
</html>`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function serveStatic(_req, res, pathname) {
  const target = normalize(resolve(publicDir, "." + decodeURIComponent(pathname)));
  if (!target.startsWith(publicDir + sep)) return send(res, 403, "Forbidden", "text/plain; charset=utf-8");
  try {
    await stat(target);
    res.writeHead(200, { "Content-Type": mime.get(extname(target).toLowerCase()) ?? "application/octet-stream", "Cache-Control": "no-store" });
    createReadStream(target).pipe(res);
  } catch {
    send(res, 404, "Not found", "text/plain; charset=utf-8");
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "OPTIONS") return send(res, 204, "", "text/plain; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, pageHtml(), "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/api/posts") return sendJson(res, await listPosts());
    if (req.method === "GET" && url.pathname === "/api/post") return sendJson(res, await readPost(url.searchParams.get("file")));
    if (req.method === "POST" && url.pathname === "/api/post") return sendJson(res, await savePost(JSON.parse(await readBody(req))));
    if (req.method === "POST" && url.pathname === "/api/create") return sendJson(res, await createPost(JSON.parse(await readBody(req))), 201);
    if (req.method === "POST" && url.pathname === "/api/bulk") return sendJson(res, await bulkUpdate(JSON.parse(await readBody(req))));
    if (req.method === "GET" && (url.pathname.startsWith("/img/") || url.pathname.startsWith("/fonts/"))) return serveStatic(req, res, url.pathname);
    send(res, 404, "Not found", "text/plain; charset=utf-8");
  } catch (error) {
    sendJson(res, { error: error.message }, Number(error.status) || 500);
  }
});

function listen(port) {
  const onError = (error) => {
    server.off("listening", onListening);
    if (error.code === "EADDRINUSE" && port < preferredPort + 20) {
      listen(port + 1);
      return;
    }
    throw error;
  };
  const onListening = () => {
    server.off("error", onError);
    console.log(`Post manager: http://127.0.0.1:${port}/`);
  };
  server.once("error", onError);
  server.once("listening", onListening);
  server.listen(port, "127.0.0.1");
}

listen(preferredPort);
