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
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
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

function setImages(data, images) {
  delete data.image;
  delete data.images;
  const clean = [...new Set(String(images ?? "").split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean))];
  if (clean.length === 1) data.image = clean[0];
  if (clean.length > 1) data.images = clean;
}

function formatPost(data, body) {
  const lines = ["---"];
  const known = ["title", "author", "character", "type", "date", "image", "images", "video", "excerpt", "fanartSourceUrl", "fanartArtist", "fanartArtistUrl", "draft"];
  lines.push(`title: ${yamlString(data.title || "Untitled")}`);
  lines.push(`author: ${yamlString(data.author || "blues")}`);
  const characters = normalizeCharacters(data.character || "Blues");
  lines.push(characters.length > 1 ? `character: [${characters.map(yamlString).join(", ")}]` : `character: ${yamlString(characters[0] || "Blues")}`);
  lines.push(`type: ${yamlString(data.type || "image")}`);
  lines.push(`date: ${data.date || new Date().toISOString()}`);
  const images = getImages(data);
  if (images.length === 1) lines.push(`image: ${yamlString(images[0])}`);
  if (images.length > 1) lines.push(`images: [${images.map(yamlString).join(", ")}]`);
  if (data.video) lines.push(`video: ${yamlString(data.video)}`);
  if (data.excerpt) lines.push(`excerpt: ${yamlString(data.excerpt)}`);
  if (data.fanartSourceUrl) lines.push(`fanartSourceUrl: ${yamlString(data.fanartSourceUrl)}`);
  if (data.fanartArtist) lines.push(`fanartArtist: ${yamlString(data.fanartArtist)}`);
  if (data.fanartArtistUrl) lines.push(`fanartArtistUrl: ${yamlString(data.fanartArtistUrl)}`);
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
    video: typeof parsed.data.video === "string" ? parsed.data.video : "",
    fanartSourceUrl: String(parsed.data.fanartSourceUrl ?? ""),
    fanartArtist: String(parsed.data.fanartArtist ?? ""),
    fanartArtistUrl: String(parsed.data.fanartArtistUrl ?? ""),
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
  data.fanartArtist = String(payload.fanartArtist ?? data.fanartArtist ?? "").trim();
  data.fanartArtistUrl = String(payload.fanartArtistUrl ?? data.fanartArtistUrl ?? "").trim();
  data.draft = Boolean(payload.draft);
  setImages(data, payload.imageText ?? getImages(data).join("\n"));
  const body = payload.body === undefined ? parsed.body : String(payload.body);
  await writeFile(target, formatPost(data, body), "utf8");
  return readPost(payload.file);
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
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Post Manager</title>
  <style>
    @font-face { font-family: Tenacity; src: url('/fonts/Tenacity.woff2') format('woff2'); }
    :root { --bg:#96b5ff; --panel:#fbf8ff; --ink:#2d1f2e; --line:#3d2a3e; --mint:#dff8ee; --pink:#ffd5e7; --blue:#dbeaff; --orange:#ffca8f; }
    * { box-sizing:border-box; }
    body { margin:0; font-family: Tenacity, ui-monospace, monospace; color:var(--ink); background:var(--bg); font-size:18px; }
    button, input, textarea, select { font:inherit; color:inherit; }
    .app { display:grid; grid-template-columns: 430px minmax(0, 1fr); height:100vh; }
    aside { border-right:4px solid var(--line); background:rgba(251,248,255,.92); overflow:hidden; display:grid; grid-template-rows:auto auto auto minmax(0,1fr); }
    header { padding:14px; border-bottom:4px solid var(--line); display:grid; gap:10px; }
    h1 { margin:0; font-size:30px; font-weight:400; }
    .stats { display:flex; gap:8px; flex-wrap:wrap; font-size:15px; }
    .pill { border:3px solid var(--line); padding:4px 8px; background:white; }
    .filters, .bulk { display:grid; grid-template-columns:1fr 1fr; gap:8px; padding:12px 14px; border-bottom:4px solid var(--line); }
    .filters input, .bulk input, .bulk button { grid-column:1 / -1; }
    input, textarea, select { width:100%; border:3px solid var(--line); background:white; padding:8px; }
    .bulk button, .actions button, .wide { border:3px solid var(--line); background:white; padding:9px; cursor:pointer; }
    .bulk button { background:var(--orange); }
    .list { overflow:auto; }
    .row { width:100%; text-align:left; border:0; border-bottom:2px solid rgba(61,42,62,.25); background:transparent; padding:10px 14px; display:grid; grid-template-columns:auto minmax(0,1fr); gap:10px; cursor:pointer; }
    .row:hover, .row.is-active { background:var(--blue); }
    .row input { width:auto; margin-top:4px; }
    .row-title { font-size:17px; line-height:1.15; overflow-wrap:anywhere; }
    .row-meta { font-size:13px; color:#6f6170; display:flex; justify-content:space-between; gap:8px; }
    main { overflow:auto; padding:22px; }
    .editor { max-width:1260px; margin:0 auto; display:grid; grid-template-columns:minmax(0, 1fr) 390px; gap:18px; align-items:start; }
    .media, .fields, .body-panel { border:4px solid var(--line); background:var(--panel); box-shadow:8px 8px 0 rgba(61,42,62,.2); }
    .media { padding:16px; display:grid; gap:16px; }
    .media img, .media video { width:100%; max-height:74vh; object-fit:contain; background:white; border:3px solid var(--line); }
    .fields { padding:16px; display:grid; gap:11px; position:sticky; top:18px; }
    .two { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    .draft-row { display:flex; align-items:center; gap:10px; }
    .draft-row input { width:auto; }
    label { display:grid; gap:6px; }
    .actions { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .save { background:var(--mint) !important; }
    .draft { background:var(--pink) !important; }
    .body-panel { grid-column:1 / -1; padding:16px; display:grid; gap:10px; }
    textarea { min-height:118px; resize:vertical; line-height:1.25; }
    #body { min-height:220px; }
    .empty { border:4px solid var(--line); background:var(--panel); padding:24px; text-align:center; }
    .status { min-height:22px; font-size:15px; color:#4d7a59; }
    small { overflow-wrap:anywhere; color:#6f6170; }
    @media (max-width: 1050px) { .app { grid-template-columns:1fr; height:auto; } aside { height:60vh; border-right:0; border-bottom:4px solid var(--line); } .editor { grid-template-columns:1fr; } .fields { position:static; } }
  </style>
</head>
<body>
  <div class="app">
    <aside>
      <header>
        <h1>Post Manager</h1>
        <div class="stats" id="stats"></div>
      </header>
      <div class="filters">
        <input id="search" type="search" placeholder="search title/body/file/artist" />
        <select id="typeFilter"><option value="all">all type</option><option value="image">image</option><option value="video">video</option><option value="text">text</option><option value="fanart">fanart</option></select>
        <select id="characterFilter"><option value="all">all character</option></select>
        <select id="folderFilter"><option value="all">all folder</option><option value="root">posts root</option><option value="imported-drafts">imported-drafts</option></select>
        <select id="sort"><option value="newest">newest</option><option value="oldest">oldest</option><option value="file">file</option></select>
      </div>
      <div class="bulk">
        <input id="bulkCharacter" placeholder="bulk character: Blues, Fizz" />
        <select id="bulkTarget"><option value="selected">selected rows</option><option value="visible">visible filtered rows</option></select>
        <select id="bulkType"><option value="">keep type</option><option value="image">image</option><option value="video">video</option><option value="text">text</option><option value="fanart">fanart</option></select>
        <button id="bulkApply">Apply bulk changes</button>
      </div>
      <div class="list" id="list"></div>
    </aside>
    <main id="main"><div class="empty">Loading...</div></main>
  </div>
<script>
const state = { posts: [], active: null, type: 'all', character: 'all', folder: 'all', search: '', sort: 'newest', selected: new Set() };
const list = document.querySelector('#list');
const main = document.querySelector('#main');
const stats = document.querySelector('#stats');
const search = document.querySelector('#search');
const typeFilter = document.querySelector('#typeFilter');
const characterFilter = document.querySelector('#characterFilter');
const folderFilter = document.querySelector('#folderFilter');
const sort = document.querySelector('#sort');
const bulkCharacter = document.querySelector('#bulkCharacter');
const bulkTarget = document.querySelector('#bulkTarget');
const bulkType = document.querySelector('#bulkType');
const bulkApply = document.querySelector('#bulkApply');

async function api(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function characterKeys(post) { return post.character.split(',').map(item => item.trim().toLowerCase()).filter(Boolean); }
function folderMatches(post) { if (state.folder === 'all') return true; if (state.folder === 'root') return !post.file.includes('/'); return post.file.startsWith(state.folder + '/'); }
function filteredPosts() {
  let posts = [...state.posts];
  if (state.type !== 'all') posts = posts.filter(post => post.type === state.type);
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
}

function renderList() {
  const fanart = state.posts.filter(post => post.type === 'fanart').length;
  const visible = filteredPosts();
  stats.innerHTML = '<span class="pill">all ' + state.posts.length + '</span><span class="pill">visible ' + visible.length + '</span><span class="pill">fanart ' + fanart + '</span><span class="pill">selected ' + state.selected.size + '</span>';
  list.innerHTML = visible.map(post => '<button class="row ' + (state.active?.file === post.file ? 'is-active' : '') + '" data-file="' + escapeHtml(post.file) + '"><input type="checkbox" data-select="' + escapeHtml(post.file) + '" ' + (state.selected.has(post.file) ? 'checked' : '') + ' /><span><span class="row-title">' + escapeHtml(post.title) + '</span><span class="row-meta"><span>' + escapeHtml(post.character) + '</span><span>' + escapeHtml(post.type) + ' / ' + mediaCount(post) + '</span></span></span></button>').join('') || '<div class="empty">No matches</div>';
}

function renderEditor(post) {
  if (!post) { main.innerHTML = '<div class="empty">Pick a post from the list.</div>'; return; }
  const mediaHtml = [post.video ? '<video src="' + escapeHtml(post.video) + '" ' + (post.images[0] ? 'poster="' + escapeHtml(post.images[0]) + '" ' : '') + 'controls muted playsinline preload="metadata"></video>' : '', ...post.images.map(src => '<img src="' + escapeHtml(src) + '" alt="" />')].filter(Boolean).join('');
  main.innerHTML = '<div class="editor">' +
    '<section class="media">' + (mediaHtml || '<div class="empty">No media</div>') + '</section>' +
    '<section class="fields">' +
      '<label>Title<input id="title" value="' + escapeAttr(post.title) + '" /></label>' +
      '<div class="two"><label>Author<input id="author" value="' + escapeAttr(post.author) + '" /></label><label>Type<select id="type"><option value="image">image</option><option value="text">text</option><option value="video">video</option><option value="fanart">fanart</option></select></label></div>' +
      '<label>Character<input id="character" value="' + escapeAttr(post.character) + '" placeholder="Blues, Fizz" /></label>' +
      '<label>Date<input id="date" value="' + escapeAttr(post.date) + '" /></label>' +
      '<label>Images<textarea id="imageText">' + escapeHtml(post.imageText) + '</textarea></label>' +
      '<label>Video<input id="video" value="' + escapeAttr(post.video) + '" /></label>' +
      '<label>Excerpt<textarea id="excerpt">' + escapeHtml(post.excerpt) + '</textarea></label>' +
      '<div class="two"><label>Artist<input id="fanartArtist" value="' + escapeAttr(post.fanartArtist) + '" /></label><label>Artist URL<input id="fanartArtistUrl" value="' + escapeAttr(post.fanartArtistUrl) + '" /></label></div>' +
      '<label>Source URL<input id="fanartSourceUrl" value="' + escapeAttr(post.fanartSourceUrl) + '" /></label>' +
      '<label class="draft-row"><input id="draft" type="checkbox" ' + (post.draft ? 'checked' : '') + ' /> draft</label>' +
      '<div class="actions"><button class="save" id="save">Save</button><button class="wide" id="saveNext">Save & next</button></div>' +
      '<div class="status" id="status"></div><small>' + escapeHtml(post.file) + '</small>' +
    '</section>' +
    '<section class="body-panel"><label>Body<textarea id="body">' + escapeHtml(post.body) + '</textarea></label></section>' +
  '</div>';
  document.querySelector('#type').value = post.type;
  document.querySelector('#save').addEventListener('click', () => save(false));
  document.querySelector('#saveNext').addEventListener('click', () => save(true));
}

async function selectPost(file) {
  state.active = await api('/api/post?file=' + encodeURIComponent(file));
  renderList();
  renderEditor(state.active);
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
    video: document.querySelector('#video').value,
    excerpt: document.querySelector('#excerpt').value,
    fanartArtist: document.querySelector('#fanartArtist').value,
    fanartArtistUrl: document.querySelector('#fanartArtistUrl').value,
    fanartSourceUrl: document.querySelector('#fanartSourceUrl').value,
    draft: document.querySelector('#draft').checked,
    body: document.querySelector('#body').value
  };
}

async function save(goNext) {
  if (!state.active) return;
  const saved = await api('/api/post', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payloadFromForm()) });
  const index = state.posts.findIndex(post => post.file === saved.file);
  if (index !== -1) state.posts[index] = saved;
  state.active = saved;
  renderFilters();
  renderList();
  document.querySelector('#status').textContent = 'Saved.';
  if (goNext) {
    const posts = filteredPosts();
    const current = posts.findIndex(post => post.file === saved.file);
    const next = posts[current + 1] || posts[0];
    if (next) selectPost(next.file);
  }
}

async function applyBulk() {
  const visible = filteredPosts().map(post => post.file);
  const files = bulkTarget.value === 'visible' ? visible : [...state.selected];
  if (!files.length) return alert('No posts selected.');
  const changes = {};
  if (bulkCharacter.value.trim()) changes.character = bulkCharacter.value.trim();
  if (bulkType.value) changes.type = bulkType.value;
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
function mediaCount(post) { return post.images.length + (post.video ? 1 : 0); }

list.addEventListener('click', event => {
  const checkbox = event.target.closest('[data-select]');
  if (checkbox) { event.stopPropagation(); checkbox.checked ? state.selected.add(checkbox.dataset.select) : state.selected.delete(checkbox.dataset.select); renderList(); return; }
  const button = event.target.closest('[data-file]');
  if (button) selectPost(button.dataset.file);
});
search.addEventListener('input', () => { state.search = search.value; renderList(); });
typeFilter.addEventListener('change', () => { state.type = typeFilter.value; renderList(); });
characterFilter.addEventListener('change', () => { state.character = characterFilter.value; renderList(); });
folderFilter.addEventListener('change', () => { state.folder = folderFilter.value; renderList(); });
sort.addEventListener('change', () => { state.sort = sort.value; renderList(); });
bulkApply.addEventListener('click', applyBulk);
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(false); } });

api('/api/posts').then(posts => { state.posts = posts; renderFilters(); renderList(); const firstFanart = posts.find(post => post.type === 'fanart' && post.character.toLowerCase() === 'blues'); selectPost(firstFanart?.file || filteredPosts()[0]?.file); }).catch(error => { main.innerHTML = '<div class="empty">' + escapeHtml(error.message) + '</div>'; });
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
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, pageHtml(), "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/api/posts") return sendJson(res, await listPosts());
    if (req.method === "GET" && url.pathname === "/api/post") return sendJson(res, await readPost(url.searchParams.get("file")));
    if (req.method === "POST" && url.pathname === "/api/post") return sendJson(res, await savePost(JSON.parse(await readBody(req))));
    if (req.method === "POST" && url.pathname === "/api/bulk") return sendJson(res, await bulkUpdate(JSON.parse(await readBody(req))));
    if (req.method === "GET" && (url.pathname.startsWith("/img/") || url.pathname.startsWith("/fonts/"))) return serveStatic(req, res, url.pathname);
    send(res, 404, "Not found", "text/plain; charset=utf-8");
  } catch (error) {
    sendJson(res, { error: error.message }, 500);
  }
});

function listen(port) {
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && port < preferredPort + 20) listen(port + 1);
    else throw error;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Post manager: http://127.0.0.1:${port}/`);
  });
}

listen(preferredPort);
