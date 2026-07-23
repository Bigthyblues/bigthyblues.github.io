import { createServer } from "node:http";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, normalize, resolve, sep } from "node:path";

const root = process.cwd();
const postsDir = resolve(root, "src/content/posts/imported-drafts");
const publicDir = resolve(root, "public");
const preferredPort = Number(process.env.PORT ?? 4350);

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
  [".mp4", "video/mp4"]
]);

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function sendJson(res, value, status = 200) {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function safePostPath(file) {
  if (!file || file.includes("/") || file.includes("\\") || !file.endsWith(".md")) return null;
  const target = resolve(postsDir, file);
  return target.startsWith(postsDir + sep) ? target : null;
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

function yamlString(value) {
  return `"${String(value ?? "").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
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

function getImages(data) {
  const images = [];
  if (typeof data.image === "string" && data.image) images.push(data.image);
  if (Array.isArray(data.images)) images.push(...data.images.filter(Boolean));
  return [...new Set(images)];
}

function formatPost(data, body) {
  const lines = [];
  lines.push("---");
  lines.push(`title: ${yamlString(data.title)}`);
  lines.push(`author: ${yamlString(data.author || "blues")}`);
  if (Array.isArray(data.character)) {
    lines.push(`character: [${data.character.map(yamlString).join(", ")}]`);
  } else {
    lines.push(`character: ${yamlString(data.character || "Blues")}`);
  }
  lines.push(`type: ${yamlString(data.type || "image")}`);
  lines.push(`date: ${data.date}`);
  const images = getImages(data);
  if (images.length === 1) lines.push(`image: ${yamlString(images[0])}`);
  if (images.length > 1) lines.push(`images: [${images.map(yamlString).join(", ")}]`);
  if (data.video) lines.push(`video: ${yamlString(data.video)}`);
  if (data.excerpt) lines.push(`excerpt: ${yamlString(data.excerpt)}`);
  if (data.fanartSourceUrl) lines.push(`fanartSourceUrl: ${yamlString(data.fanartSourceUrl)}`);
  if (data.fanartArtist) lines.push(`fanartArtist: ${yamlString(data.fanartArtist)}`);
  if (data.fanartArtistUrl) lines.push(`fanartArtistUrl: ${yamlString(data.fanartArtistUrl)}`);
  lines.push(`draft: ${data.draft === false ? "false" : "true"}`);
  lines.push("---");
  lines.push("");
  lines.push(String(body ?? "").trimEnd());
  lines.push("");
  return lines.join("\n");
}

async function readPost(file) {
  const target = safePostPath(file);
  if (!target) throw new Error("Invalid post file");
  const source = await readFile(target, "utf8");
  const parsed = parsePost(source);
  const stats = await stat(target);
  return {
    file,
    title: String(parsed.data.title ?? "Untitled"),
    date: String(parsed.data.date ?? ""),
    draft: parsed.data.draft !== false,
    character: Array.isArray(parsed.data.character) ? parsed.data.character.join(", ") : String(parsed.data.character ?? "Blues"),
    type: String(parsed.data.type ?? "image"),
    excerpt: String(parsed.data.excerpt ?? ""),
    images: getImages(parsed.data),
    video: typeof parsed.data.video === "string" ? parsed.data.video : "",
    body: parsed.body,
    modified: stats.mtimeMs
  };
}

async function listPosts() {
  const files = (await readdir(postsDir)).filter((file) => file.endsWith(".md"));
  const posts = await Promise.all(files.map(readPost));
  posts.sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.file.localeCompare(b.file));
  return posts;
}

async function savePost(payload) {
  const target = safePostPath(payload.file);
  if (!target) throw new Error("Invalid post file");
  const source = await readFile(target, "utf8");
  const parsed = parsePost(source);
  const data = { ...parsed.data };
  data.title = String(payload.title ?? data.title ?? "Untitled").trim() || "Untitled";
  data.character = String(payload.character ?? data.character ?? "Blues").trim() || "Blues";
  data.type = String(payload.type ?? data.type ?? "image");
  data.excerpt = String(payload.excerpt ?? data.excerpt ?? "").trim();
  data.draft = Boolean(payload.draft);
  const body = payload.body === undefined ? parsed.body : String(payload.body);
  await writeFile(target, formatPost(data, body), "utf8");
  return readPost(payload.file);
}

function pageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Twitter Draft Review</title>
  <style>
    @font-face { font-family: Tenacity; src: url('/fonts/Tenacity.woff2') format('woff2'); }
    :root { --bg:#96b5ff; --panel:#fbf8ff; --ink:#2d1f2e; --line:#3d2a3e; --mint:#dff8ee; --pink:#ffd5e7; --blue:#dbeaff; }
    * { box-sizing:border-box; }
    body { margin:0; font-family: Tenacity, ui-monospace, monospace; color:var(--ink); background:var(--bg); font-size:20px; }
    button, input, textarea, select { font:inherit; color:inherit; }
    .app { display:grid; grid-template-columns: 380px minmax(0, 1fr); height:100vh; }
    aside { border-right:4px solid var(--line); background:rgba(251,248,255,.92); overflow:hidden; display:grid; grid-template-rows:auto auto minmax(0,1fr); }
    header { padding:14px; border-bottom:4px solid var(--line); display:grid; gap:10px; }
    h1 { margin:0; font-size:30px; }
    .stats { display:flex; gap:8px; flex-wrap:wrap; font-size:16px; }
    .pill { border:3px solid var(--line); padding:4px 8px; background:white; }
    .filters { display:grid; grid-template-columns:1fr 1fr; gap:8px; padding:12px 14px; border-bottom:4px solid var(--line); }
    .filters input { grid-column:1 / -1; }
    input, textarea, select { width:100%; border:3px solid var(--line); background:white; padding:8px; }
    .list { overflow:auto; }
    .row { width:100%; text-align:left; border:0; border-bottom:2px solid rgba(61,42,62,.25); background:transparent; padding:10px 14px; display:grid; gap:4px; cursor:pointer; }
    .row:hover, .row.is-active { background:var(--blue); }
    .row-title { font-size:18px; line-height:1.15; }
    .row-meta { font-size:14px; color:#6f6170; display:flex; justify-content:space-between; gap:8px; }
    main { overflow:auto; padding:22px; }
    .editor { max-width:1180px; margin:0 auto; display:grid; grid-template-columns:minmax(0, 1fr) 360px; gap:18px; align-items:start; }
    .media, .fields, .body-panel { border:4px solid var(--line); background:var(--panel); box-shadow:8px 8px 0 rgba(61,42,62,.2); }
    .media { padding:16px; display:grid; gap:16px; }
    .media img, .media video { width:100%; max-height:72vh; object-fit:contain; background:white; border:3px solid var(--line); }
    .fields { padding:16px; display:grid; gap:12px; position:sticky; top:18px; }
    .title-row { display:grid; grid-template-columns:minmax(0, 1fr) 150px; gap:10px; align-items:end; }
    .draft-row { display:flex; align-items:center; gap:10px; }
    .draft-row input { width:auto; }
    label { display:grid; gap:6px; }
    .actions { display:grid; grid-template-columns:1fr; gap:8px; }
    .actions button, .wide, .title-row button { border:3px solid var(--line); background:white; padding:9px; cursor:pointer; }
    .publish { background:var(--mint) !important; }
    .draft { background:var(--pink) !important; }
    .body-panel { grid-column:1 / -1; padding:16px; display:grid; gap:10px; }
    textarea { min-height:180px; resize:vertical; line-height:1.25; }
    .empty { border:4px solid var(--line); background:var(--panel); padding:24px; text-align:center; }
    .status { min-height:24px; font-size:16px; color:#4d7a59; }
    @media (max-width: 980px) { .app { grid-template-columns:1fr; height:auto; } aside { height:55vh; border-right:0; border-bottom:4px solid var(--line); } .editor { grid-template-columns:1fr; } .fields { position:static; } .title-row { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <div class="app">
    <aside>
      <header>
        <h1>Draft Review</h1>
        <div class="stats" id="stats"></div>
      </header>
      <div class="filters">
        <input id="search" type="search" placeholder="search title/body/file" />
        <select id="filter"><option value="all">all</option><option value="draft">draft</option><option value="published">published</option></select>
        <select id="sort"><option value="newest">newest</option><option value="oldest">oldest</option><option value="file">file</option></select>
      </div>
      <div class="list" id="list"></div>
    </aside>
    <main id="main"><div class="empty">Loading...</div></main>
  </div>
<script>
const state = { posts: [], active: null, filter: 'all', search: '', sort: 'newest' };
const list = document.querySelector('#list');
const main = document.querySelector('#main');
const stats = document.querySelector('#stats');
const search = document.querySelector('#search');
const filter = document.querySelector('#filter');
const sort = document.querySelector('#sort');

async function api(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function filteredPosts() {
  let posts = [...state.posts];
  if (state.filter === 'draft') posts = posts.filter(post => post.draft);
  if (state.filter === 'published') posts = posts.filter(post => !post.draft);
  const q = state.search.trim().toLowerCase();
  if (q) posts = posts.filter(post => [post.title, post.file, post.body, post.excerpt].join(' ').toLowerCase().includes(q));
  if (state.sort === 'oldest') posts.sort((a,b) => String(a.date).localeCompare(String(b.date)) || a.file.localeCompare(b.file));
  if (state.sort === 'newest') posts.sort((a,b) => String(b.date).localeCompare(String(a.date)) || a.file.localeCompare(b.file));
  if (state.sort === 'file') posts.sort((a,b) => a.file.localeCompare(b.file));
  return posts;
}

function renderList() {
  const draft = state.posts.filter(post => post.draft).length;
  const published = state.posts.length - draft;
  stats.innerHTML = '<span class="pill">all ' + state.posts.length + '</span><span class="pill">draft ' + draft + '</span><span class="pill">published ' + published + '</span>';
  const posts = filteredPosts();
  list.innerHTML = posts.map(post => '<button class="row ' + (state.active?.file === post.file ? 'is-active' : '') + '" data-file="' + escapeHtml(post.file) + '"><span class="row-title">' + escapeHtml(post.title) + '</span><span class="row-meta"><span>' + escapeHtml(formatDate(post.date)) + '</span><span>' + (post.draft ? 'draft' : 'live') + ' / ' + mediaCount(post) + '</span></span></button>').join('') || '<div class="empty">No matches</div>';
}

function renderEditor(post) {
  if (!post) { main.innerHTML = '<div class="empty">Pick a draft from the list.</div>'; return; }
  const mediaHtml = [
    post.video ? '<video src="' + escapeHtml(post.video) + '" ' + (post.images[0] ? 'poster="' + escapeHtml(post.images[0]) + '" ' : '') + 'controls muted playsinline preload="metadata"></video>' : '',
    ...post.images.map(src => '<img src="' + escapeHtml(src) + '" alt="" />')
  ].filter(Boolean).join('');
  main.innerHTML = '<div class="editor">' +
    '<section class="media">' + (mediaHtml || '<div class="empty">No media</div>') + '</section>' +
    '<section class="fields">' +
      '<div class="title-row"><label>Title<input id="title" value="' + escapeAttr(post.title) + '" /></label><button class="publish" id="publish">Publish</button></div>' +
      '<label>Character<input id="character" value="' + escapeAttr(post.character) + '" /></label>' +
      '<label>Type<select id="type"><option value="image">image</option><option value="text">text</option><option value="video">video</option><option value="fanart">fanart</option></select></label>' +
      '<label>Excerpt<textarea id="excerpt">' + escapeHtml(post.excerpt) + '</textarea></label>' +
      '<label class="draft-row"><input id="draft" type="checkbox" ' + (post.draft ? 'checked' : '') + ' /> draft</label>' +
      '<div class="actions"><button class="draft" id="keepDraft">Keep draft</button></div>' +
      '<button class="wide" id="save">Save</button><button class="wide" id="saveNext">Save & next</button>' +
      '<div class="status" id="status"></div>' +
      '<small>' + escapeHtml(post.file) + '</small>' +
    '</section>' +
    '<section class="body-panel"><label>Body<textarea id="body">' + escapeHtml(post.body) + '</textarea></label></section>' +
  '</div>';
  document.querySelector('#type').value = post.type;
  document.querySelector('#publish').addEventListener('click', () => { document.querySelector('#draft').checked = false; save(true); });
  document.querySelector('#keepDraft').addEventListener('click', () => { document.querySelector('#draft').checked = true; save(false); });
  document.querySelector('#save').addEventListener('click', () => save(false));
  document.querySelector('#saveNext').addEventListener('click', () => save(true));
}

async function selectPost(file) {
  state.active = await api('/api/post?file=' + encodeURIComponent(file));
  renderList();
  renderEditor(state.active);
}

async function save(goNext) {
  if (!state.active) return;
  const payload = {
    file: state.active.file,
    title: document.querySelector('#title').value,
    character: document.querySelector('#character').value,
    type: document.querySelector('#type').value,
    excerpt: document.querySelector('#excerpt').value,
    draft: document.querySelector('#draft').checked,
    body: document.querySelector('#body').value
  };
  const saved = await api('/api/post', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  const index = state.posts.findIndex(post => post.file === saved.file);
  if (index !== -1) state.posts[index] = saved;
  state.active = saved;
  renderList();
  document.querySelector('#status').textContent = 'Saved.';
  if (goNext) {
    const posts = filteredPosts();
    const current = posts.findIndex(post => post.file === saved.file);
    const next = posts[current + 1] || posts[0];
    if (next) selectPost(next.file);
  }
}

function escapeHtml(value) { return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'); }
function escapeAttr(value) { return escapeHtml(value).replaceAll("'", '&#39;'); }
function formatDate(value) { return String(value || '').replace('T', ' ').replace(/:00.*$/, ''); }
function mediaCount(post) { const count = post.images.length + (post.video ? 1 : 0); return count + (post.video ? ' media' : ' img'); }

list.addEventListener('click', event => {
  const button = event.target.closest('[data-file]');
  if (button) selectPost(button.dataset.file);
});
search.addEventListener('input', () => { state.search = search.value; renderList(); });
filter.addEventListener('change', () => { state.filter = filter.value; renderList(); });
sort.addEventListener('change', () => { state.sort = sort.value; renderList(); });
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(false); }
});

api('/api/posts').then(posts => { state.posts = posts; renderList(); selectPost(filteredPosts()[0]?.file); }).catch(error => { main.innerHTML = '<div class="empty">' + escapeHtml(error.message) + '</div>'; });
</script>
</body>
</html>`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function serveStatic(_req, res, pathname) {
  const target = normalize(resolve(publicDir, '.' + decodeURIComponent(pathname)));
  if (!target.startsWith(publicDir + sep)) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
  try {
    await stat(target);
    res.writeHead(200, { 'Content-Type': mime.get(extname(target).toLowerCase()) ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(target).pipe(res);
  } catch {
    send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, pageHtml(), 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/posts') return sendJson(res, await listPosts());
    if (req.method === 'GET' && url.pathname === '/api/post') return sendJson(res, await readPost(url.searchParams.get('file')));
    if (req.method === 'POST' && url.pathname === '/api/post') return sendJson(res, await savePost(JSON.parse(await readBody(req))));
    if (req.method === 'GET' && (url.pathname.startsWith('/img/') || url.pathname.startsWith('/fonts/'))) return serveStatic(req, res, url.pathname);
    send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  } catch (error) {
    sendJson(res, { error: error.message }, 500);
  }
});

function listen(port) {
  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE' && port < preferredPort + 20) listen(port + 1);
    else throw error;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Twitter draft review: http://127.0.0.1:${port}/`);
  });
}

listen(preferredPort);


