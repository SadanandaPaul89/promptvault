import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { TLSSocket } from "node:tls";
import { ACCESS_COOKIE, AuthError, REFRESH_COOKIE, cookie, parseCookies, type Auth, type Tokens } from "./auth.ts";
import { HttpError, type Service } from "./api.ts";
import type { Analyzer } from "./analyze.ts";
import { ALL, type AnalysisStatus, type SubmissionStatus, type UserDTO } from "./types.ts";

export type AppOptions = {
  service: Service;
  /** Accounts + JWT sessions. */
  auth: Auth;
  /** Post analyzer (browser extension backend). Routes 404 when omitted. */
  analyzer?: Analyzer;
  /** Bearer token for /api/admin/* moderation routes. Disabled when unset. */
  adminToken?: string;
  /** Built client directory (vite build output). Optional in dev/tests. */
  staticDir?: string;
  /** Trust X-Forwarded-For (set when behind a reverse proxy / PaaS). */
  trustProxy?: boolean;
  /** Extra exact origins allowed to make state-changing requests (e.g. "https://app.example.com"). */
  allowedOrigins?: string[];
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
};

const VISITOR_RE = /^[A-Za-z0-9-]{16,64}$/;
const MAX_BODY = 16 * 1024;
/** Analyze requests carry post text, OCR text and up to ~90 s of base64 audio. */
const MAX_ANALYZE_BODY = 8 * 1024 * 1024;
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const AUDIO_MIME = /^audio\/(webm|ogg|mp4|mpeg|wav)(;.*)?$/;
const SUBMISSION_STATUSES = new Set<SubmissionStatus>(["pending", "added", "rejected"]);
const STATUSES = new Set<AnalysisStatus>(["pending", "approved", "rejected", "no_prompt", "dm_gated"]);

// --- tiny fixed-window rate limiter (per IP, per bucket) --------------------
class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  check(key: string, max: number, windowMs: number): boolean {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.reset < now) {
      this.hits.set(key, { n: 1, reset: now + windowMs });
      if (this.hits.size > 50_000) this.sweep(now);
      return true;
    }
    h.n++;
    return h.n <= max;
  }
  private sweep(now: number) {
    for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
  }
}

export function createApp({ service, auth, analyzer, adminToken, staticDir, trustProxy = false, allowedOrigins: extraOrigins = [] }: AppOptions) {
  const allowedOrigins = new Set(extraOrigins);
  const limiter = new RateLimiter();
  const root = staticDir ? resolve(staticDir) : undefined;

  function clientIp(req: IncomingMessage): string {
    if (trustProxy) {
      const fwd = req.headers["x-forwarded-for"];
      const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  function visitorId(req: IncomingMessage): string {
    const v = req.headers["x-visitor-id"];
    const id = Array.isArray(v) ? v[0] : v;
    if (!id || !VISITOR_RE.test(id)) throw new HttpError(400, "Missing or invalid visitor id");
    return id;
  }

  // --- auth ----------------------------------------------------------------
  function isSecure(req: IncomingMessage): boolean {
    if (trustProxy) return String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim() === "https";
    return !!(req.socket as TLSSocket).encrypted;
  }

  function setSession(req: IncomingMessage, res: ServerResponse, t: Tokens) {
    const secure = isSecure(req);
    res.setHeader("Set-Cookie", [
      cookie(ACCESS_COOKIE, t.access, { maxAgeSec: t.accessTtlSec, path: "/api", secure }),
      cookie(REFRESH_COOKIE, t.refresh, { maxAgeSec: t.refreshTtlSec, path: "/api/auth", secure }),
    ]);
  }

  function clearSession(req: IncomingMessage, res: ServerResponse) {
    const secure = isSecure(req);
    res.setHeader("Set-Cookie", [
      cookie(ACCESS_COOKIE, "", { maxAgeSec: 0, path: "/api", secure }),
      cookie(REFRESH_COOKIE, "", { maxAgeSec: 0, path: "/api/auth", secure }),
    ]);
  }

  /** Signed-in user, or null when anonymous. An expired token is a 401 so the client refreshes. */
  function currentUser(req: IncomingMessage): UserDTO | null {
    const token = parseCookies(req.headers.cookie)[ACCESS_COOKIE];
    if (!token) return null;
    return auth.userFromAccess(token);
  }

  function requireUser(req: IncomingMessage): UserDTO {
    const u = currentUser(req);
    if (!u) throw new AuthError(401, "auth_required", "Sign in to do that.");
    return u;
  }

  const owner = (u: UserDTO) => `u:${u.id}`;

  /** Admins (by role), or the ADMIN_TOKEN bearer token for scripts. */
  function requireAdmin(req: IncomingMessage) {
    const header = String(req.headers.authorization ?? "");
    if (adminToken && header) {
      const got = Buffer.from(header);
      const want = Buffer.from(`Bearer ${adminToken}`);
      if (got.length === want.length && timingSafeEqual(got, want)) return;
      throw new HttpError(401, "Unauthorized");
    }
    const u = requireUser(req);
    if (u.role !== "admin") throw new AuthError(403, "forbidden", "Admins only.");
  }

  /** CSRF defence in depth (cookies are already SameSite=Strict): state changes must come from this origin. */
  function checkOrigin(req: IncomingMessage, path: string) {
    const origin = req.headers.origin;
    const fetchSite = req.headers["sec-fetch-site"];
    if (origin) {
      // Set by the browser itself (pages can't forge it); also survives dev/reverse proxies
      // that rewrite Host, e.g. Vite on :5173 forwarding to :3000.
      if (fetchSite === "same-origin") return;
      let host = "";
      try { host = new URL(origin).host; } catch { /* invalid */ }
      const forwarded = trustProxy ? String(req.headers["x-forwarded-host"] ?? "").split(",")[0]?.trim() : "";
      const sameHost = host !== "" && (host === req.headers.host || host === forwarded || allowedOrigins.has(origin));
      // The browser extension calls the analyze API without cookies.
      const extension = origin.startsWith("chrome-extension://") && path.startsWith("/api/analyze");
      if (!sameHost && !extension) throw new AuthError(403, "bad_origin", "Cross-site request blocked.");
    } else if (fetchSite === "cross-site") {
      throw new AuthError(403, "bad_origin", "Cross-site request blocked.");
    }
  }

  async function readJson(req: IncomingMessage, maxBody = MAX_BODY): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > maxBody) throw new HttpError(413, "Request body too large");
      chunks.push(chunk as Buffer);
    }
    if (size === 0) return {};
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      return parsed as Record<string, unknown>;
    } catch {
      throw new HttpError(400, "Body must be a JSON object");
    }
  }

  function send(res: ServerResponse, status: number, body: unknown) {
    const json = JSON.stringify(body);
    // Responses can be personal (saves, votes, account): never store them in any
    // browser or shared cache, and never let a cache key them without the cookie.
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, private",
      Pragma: "no-cache",
      Vary: "Cookie",
    });
    res.end(json);
  }

  function str(v: unknown, max: number, fallback = ""): string {
    if (v === undefined || v === null) return fallback;
    if (typeof v !== "string") throw new HttpError(400, "Expected a string");
    const s = v.trim();
    if (s.length > max) throw new HttpError(400, `Value too long (max ${max} characters)`);
    return s;
  }

  function int(v: string | null, def: number, min: number, max: number): number {
    if (v === null || v === "") return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, "Invalid number parameter");
    return n;
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    const path = url.pathname;
    const method = req.method ?? "GET";
    const ip = clientIp(req);

    if (method !== "GET" && !limiter.check(`w:${ip}`, 120, 60_000)) throw new HttpError(429, "Too many requests — slow down a little.");
    if (method === "GET" && !limiter.check(`r:${ip}`, 600, 60_000)) throw new HttpError(429, "Too many requests — slow down a little.");

    if (path === "/api/health" && method === "GET") return send(res, 200, { ok: true });
    if (method !== "GET" && method !== "HEAD") checkOrigin(req, path);

    // --- accounts ----------------------------------------------------------------
    if (path.startsWith("/api/auth/")) {
      const ua = String(req.headers["user-agent"] ?? "");
      if (method === "POST" && (path === "/api/auth/login" || path === "/api/auth/register")) {
        if (!limiter.check(`auth:${ip}`, 20, 15 * 60_000)) throw new HttpError(429, "Too many attempts. Try again in 15 minutes.");
        const body = await readJson(req);
        const email = str(body.email, 254);
        const password = typeof body.password === "string" ? body.password : "";
        if (!limiter.check(`auth-email:${email.toLowerCase()}`, 10, 15 * 60_000)) throw new HttpError(429, "Too many attempts. Try again in 15 minutes.");
        const visitor = typeof body.visitorId === "string" ? body.visitorId : undefined;
        const r = path === "/api/auth/register"
          ? await auth.register({ email, password, name: str(body.name, 80), visitorId: visitor, userAgent: ua })
          : await auth.login({ email, password, visitorId: visitor, userAgent: ua });
        setSession(req, res, r.tokens);
        return send(res, path === "/api/auth/register" ? 201 : 200, { user: r.user });
      }
      if (method === "POST" && path === "/api/auth/refresh") {
        try {
          const r = auth.refresh(parseCookies(req.headers.cookie)[REFRESH_COOKIE], ua);
          setSession(req, res, r.tokens);
          return send(res, 200, { user: r.user });
        } catch (e) {
          clearSession(req, res);
          throw e;
        }
      }
      if (method === "POST" && path === "/api/auth/logout") {
        const body = await readJson(req);
        let user: UserDTO | null = null;
        try { user = currentUser(req); } catch { /* expired is fine for logout */ }
        auth.logout(parseCookies(req.headers.cookie)[REFRESH_COOKIE], body.everywhere === true, user?.id);
        clearSession(req, res);
        return send(res, 200, { ok: true });
      }
      if (method === "GET" && path === "/api/auth/me") {
        // One call on page load: valid access token → user; otherwise try the refresh cookie.
        try {
          const u = currentUser(req);
          if (u) return send(res, 200, { user: u });
        } catch (e) {
          if (!(e instanceof AuthError)) throw e;
        }
        const rt = parseCookies(req.headers.cookie)[REFRESH_COOKIE];
        if (!rt) return send(res, 200, { user: null });
        try {
          const r = auth.refresh(rt, ua);
          setSession(req, res, r.tokens);
          return send(res, 200, { user: r.user });
        } catch {
          clearSession(req, res);
          return send(res, 200, { user: null });
        }
      }
      throw new HttpError(404, "Not found");
    }

    if (path === "/api/vault" && method === "GET") {
      const p = url.searchParams;
      const user = currentUser(req);
      if (p.get("saved") === "1" && !user) throw new AuthError(401, "auth_required", "Sign in to see your saved prompts.");
      return send(res, 200, service.vault(user ? owner(user) : "", {
        q: (p.get("q") ?? "").slice(0, 200),
        collection: (p.get("collection") ?? ALL).slice(0, 80),
        category: (p.get("category") ?? ALL).slice(0, 80),
        savedOnly: p.get("saved") === "1",
        offset: int(p.get("offset"), 0, 0, 100_000),
        limit: int(p.get("limit"), 24, 1, 60),
      }));
    }

    const m = path.match(/^\/api\/prompts\/(\d{1,9})\/(copy|save|vote)$/);
    if (m && method === "POST") {
      const id = Number(m[1]);
      const action = m[2];
      if (action === "copy") return send(res, 200, service.recordCopy(id));
      if (action === "save") return send(res, 200, service.toggleSave(owner(requireUser(req)), id));
      const body = await readJson(req);
      if (typeof body.worked !== "boolean") throw new HttpError(400, "`worked` must be true or false");
      return send(res, 200, service.vote(owner(requireUser(req)), id, body.worked));
    }

    if (path === "/api/submissions" && method === "GET") {
      return send(res, 200, service.mySubmissions(owner(requireUser(req)), int(url.searchParams.get("limit"), 10, 1, 50)));
    }

    if (path === "/api/submissions" && method === "POST") {
      const visitor = owner(requireUser(req));
      if (!limiter.check(`s:${ip}`, 20, 60 * 60_000)) throw new HttpError(429, "Submission limit reached — try again in an hour.");
      const body = await readJson(req);
      const rawUrl = str(body.url, 500);
      let parsed: URL;
      try { parsed = new URL(rawUrl); } catch { throw new HttpError(400, "Paste a full link starting with https://"); }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new HttpError(400, "Only http(s) links are accepted");
      const category = str(body.category, 80, "Other");
      if (category !== "Other" && !service.categories().has(category)) throw new HttpError(400, "Unknown category");
      return send(res, 201, service.submit(visitor, parsed.toString(), str(body.note, 300), category));
    }

    // --- post analyzer (called by the browser extension) -------------------------
    if (analyzer && path === "/api/analyze" && method === "GET") {
      return send(res, 200, analyzer.lookup(visitorId(req), str(url.searchParams.get("url"), 2000)));
    }

    if (analyzer && path === "/api/analyze" && method === "POST") {
      const visitor = visitorId(req);
      const body = await readJson(req, MAX_ANALYZE_BODY);
      const postUrl = str(body.url, 2000);
      // Cache hits are cheap; only count requests that may run extraction/STT.
      const cachedOnly = analyzer.lookup(visitor, postUrl);
      if (cachedOnly.found) return send(res, 200, cachedOnly);
      if (!limiter.check(`a:${ip}`, 30, 60 * 60_000)) throw new HttpError(429, "Analysis limit reached — try again in an hour.");
      let audio: Buffer | undefined;
      if (body.audio !== undefined && body.audio !== null) {
        const a = body.audio as { mime?: unknown; data?: unknown };
        if (typeof a !== "object" || typeof a.mime !== "string" || typeof a.data !== "string" || !AUDIO_MIME.test(a.mime)) {
          throw new HttpError(400, "audio must be { mime: 'audio/webm' | …, data: base64 }");
        }
        audio = Buffer.from(a.data, "base64");
        if (audio.length > MAX_AUDIO_BYTES) throw new HttpError(413, "Audio too long — reels up to ~90 seconds are supported");
      }
      const result = await analyzer.analyze(visitor, {
        url: postUrl,
        creator: str(body.creator, 100),
        text: str(body.text, 20_000),
        ocrText: str(body.ocrText, 50_000),
        audio,
      });
      return send(res, result.cached ? 200 : 201, result);
    }

    // --- admin: submitted links ------------------------------------------------------
    if (path === "/api/admin/submissions" && method === "GET") {
      requireAdmin(req);
      const status = (url.searchParams.get("status") ?? "pending") as SubmissionStatus | "all";
      if (status !== "all" && !SUBMISSION_STATUSES.has(status)) throw new HttpError(400, "Unknown status");
      return send(res, 200, service.adminSubmissions(status, int(url.searchParams.get("limit"), 50, 1, 200), int(url.searchParams.get("offset"), 0, 0, 1_000_000)));
    }
    const sm = path.match(/^\/api\/admin\/submissions\/(\d{1,9})$/);
    if (sm && method === "POST") {
      requireAdmin(req);
      const body = await readJson(req);
      if (typeof body.status !== "string" || !SUBMISSION_STATUSES.has(body.status as SubmissionStatus)) throw new HttpError(400, "status must be pending, added or rejected");
      return send(res, 200, service.setSubmissionStatus(Number(sm[1]), body.status as SubmissionStatus));
    }

    // --- admin: post analyses (role admin or ADMIN_TOKEN) ------------------------
    if (analyzer && path === "/api/admin/analyses" && method === "GET") {
      requireAdmin(req);
      const status = (url.searchParams.get("status") ?? "pending") as AnalysisStatus;
      if (!STATUSES.has(status)) throw new HttpError(400, "Unknown status");
      return send(res, 200, { analyses: analyzer.list(status, int(url.searchParams.get("limit"), 20, 1, 100)) });
    }

    const am = path.match(/^\/api\/admin\/analyses\/(\d{1,9})\/(approve|reject)$/);
    if (analyzer && am && method === "POST") {
      requireAdmin(req);
      const id = Number(am[1]);
      if (am[2] === "reject") return send(res, 200, analyzer.reject(id));
      const body = await readJson(req);
      let keep: number[] | undefined;
      if (body.keep !== undefined) {
        if (!Array.isArray(body.keep) || !body.keep.every((n) => Number.isInteger(n) && n >= 0 && n < 20)) {
          throw new HttpError(400, "`keep` must be an array of candidate indexes");
        }
        keep = body.keep as number[];
      }
      return send(res, 200, analyzer.approve(id, keep));
    }

    throw new HttpError(404, "Not found");
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!root || (req.method !== "GET" && req.method !== "HEAD")) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    let rel: string;
    try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end(); return; }
    let file = normalize(join(root, rel));
    if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      // SPA fallback — unknown paths without an extension load the app shell.
      if (extname(rel)) { res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found"); return; }
      file = join(root, "index.html");
      if (!existsSync(file)) { res.writeHead(503, { "Content-Type": "text/plain" }).end("Client not built — run `npm run build`."); return; }
    }
    const isAsset = file.startsWith(join(root, "assets") + sep);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": isAsset ? "public, max-age=31536000, immutable" : "no-cache",
    });
    if (req.method === "HEAD") { res.end(); return; }
    createReadStream(file).pipe(res);
  }

  return async function handler(req: IncomingMessage, res: ServerResponse) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
      else serveStatic(req, res, url);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      if (e instanceof AuthError) return send(res, e.status, { error: e.message, code: e.code });
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: "Something went wrong on our side." });
      else res.end();
    }
  };
}
