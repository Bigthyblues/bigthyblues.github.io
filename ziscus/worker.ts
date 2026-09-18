import ziscusWorker from "ziscus/worker";

interface Env {
  DB: D1Database;
  ADMIN_SECRET?: string;
  ALLOWED_ORIGINS: string;
  MODERATION: string;
  RATE_LIMIT?: string;
  MAX_BODY_LENGTH?: string;
  MIN_BODY_LENGTH?: string;
  MAX_AUTHOR_LENGTH?: string;
  MAX_URLS_IN_BODY?: string;
  MAX_SLUG_LENGTH?: string;
  GITHUB_REPO?: string;
  GITHUB_TOKEN?: string;
  AI_MOD?: Ai;
  ASSETS?: Fetcher;
}

const home = "https://www.bigthyblues.xyz/";
const askSlug = "about-ask";

const privateQuestions = async (request: Request, env: Env) => {
  if (request.headers.get("Authorization") !== `Bearer ${env.ADMIN_SECRET}`) return new Response("Unauthorized", { status: 401 });
  const result = await env.DB.prepare("SELECT author, body, created_at FROM comments WHERE slug = ? AND status = 'approved' ORDER BY created_at DESC").bind(askSlug).all();
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const questions = (result.results ?? []) as Array<{ author: string; body: string; created_at: string }>;
  const rows = questions.map((q) => `<article><b>${esc(q.author)}</b> <small>${esc(q.created_at.slice(0, 10))}</small><p>${esc(q.body)}</p></article>`).join("") || "<p>No approved questions yet.</p>";
  return new Response(`<!doctype html><meta name="robots" content="noindex,nofollow"><title>Approved questions</title><style>body{max-width:760px;margin:2rem auto;font:16px system-ui}article{border:1px solid #ccc;padding:1rem;margin:1rem 0}p{white-space:pre-wrap}</style><p><a href="/admin/dashboard">← Dashboard</a></p><h1>Approved questions</h1>${rows}`, { headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" } });
};

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/") return Response.redirect(home, 302);
    if (path === "/about-ask") return privateQuestions(request, env);
    return ziscusWorker.fetch(request, env);
  }
} satisfies ExportedHandler<Env>;
