import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { openDatabase } from "../src/db.ts";
import { hashPassword, signJwt, verifyJwt, verifyPassword, AuthError } from "../src/auth.ts";
import type { AdminSubmissionsResponse, UserDTO } from "../src/types.ts";
import { Client, TEST_SECRET, startServer } from "./helpers.ts";

const db = await openDatabase(":memory:");
const ADMIN_TOKEN = "script-admin-token";
let srv: Awaited<ReturnType<typeof startServer>>;

before(async () => {
  // rotationGraceMs -1: any reuse counts as theft (0 would race within a single millisecond).
  srv = await startServer(db, { adminToken: ADMIN_TOKEN, authOptions: { adminEmails: ["Boss@Example.com"], rotationGraceMs: -1 } });
});
after(async () => { await srv.close(); db.close(); });

// --- primitives -------------------------------------------------------------------

test("passwords: scrypt hash verifies, wrong password fails, hashes are salted", async () => {
  const h = await hashPassword("hunter2hunter2");
  assert.match(h, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword("hunter2hunter2", h), true);
  assert.equal(await verifyPassword("hunter2hunter3", h), false);
  assert.notEqual(h, await hashPassword("hunter2hunter2"));
});

test("JWT: valid token verifies; tampering, alg:none, wrong secret, expiry all rejected", () => {
  const now = Math.floor(Date.now() / 1000);
  const t = signJwt({ sub: "1", role: "user", sid: 1, iat: now, exp: now + 60 }, TEST_SECRET);
  assert.equal(verifyJwt(t, TEST_SECRET).sub, "1");

  const [h, p, s] = t.split(".") as [string, string, string];
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), role: "admin" })).toString("base64url");
  const codeOf = (fn: () => unknown) => { try { fn(); return "ok"; } catch (e) { return (e as AuthError).code; } };
  assert.equal(codeOf(() => verifyJwt(`${h}.${forged}.${s}`, TEST_SECRET)), "invalid_token");

  const none = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  assert.equal(codeOf(() => verifyJwt(`${none}.${p}.`, TEST_SECRET)), "invalid_token");
  // alg confusion: a validly-HMACed token with a different header is still rejected.
  const hs512 = Buffer.from(JSON.stringify({ alg: "HS512", typ: "JWT" })).toString("base64url");
  const sig512 = createHmac("sha256", TEST_SECRET).update(`${hs512}.${p}`).digest("base64url");
  assert.equal(codeOf(() => verifyJwt(`${hs512}.${p}.${sig512}`, TEST_SECRET)), "invalid_token");

  assert.equal(codeOf(() => verifyJwt(t, "another-secret-another-secret-another-secret")), "invalid_token");
  assert.equal(codeOf(() => verifyJwt(t, TEST_SECRET, now + 61)), "token_expired");
  assert.equal(codeOf(() => verifyJwt("a.b", TEST_SECRET)), "invalid_token");
});

// --- HTTP flows ------------------------------------------------------------------------

test("register sets HttpOnly SameSite=Strict cookies scoped by path; no token in the body", async () => {
  const c = new Client(srv.base);
  const r = await c.register("carol@example.com");
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.body), ["user"]);
  assert.equal(r.body.user.email, "carol@example.com");
  const set = r.headers.getSetCookie();
  const at = set.find((x) => x.startsWith("pv_at="))!;
  const rt = set.find((x) => x.startsWith("pv_rt="))!;
  for (const x of [at, rt]) { assert.match(x, /HttpOnly/); assert.match(x, /SameSite=Strict/); assert.doesNotMatch(x, /Secure/); }
  assert.match(at, /Path=\/api;/);
  assert.match(rt, /Path=\/api\/auth;/);
  assert.equal((await c.call<{ user: UserDTO }>("/api/auth/me")).body.user.email, "carol@example.com");
});

test("cookies are Secure behind an HTTPS proxy", async () => {
  const s2 = await startServer(db, { trustProxy: true });
  const c = new Client(s2.base);
  const r = await c.call("/api/auth/register", { body: { email: "secure@example.com", password: "long enough pw" }, headers: { "X-Forwarded-Proto": "https" } });
  assert.ok(r.headers.getSetCookie().every((x) => x.includes("Secure")));
  await s2.close();
});

test("register/login validation and uniform login errors", async () => {
  const c = new Client(srv.base);
  assert.equal((await c.call("/api/auth/register", { body: { email: "not-an-email", password: "longpassword" } })).status, 400);
  assert.equal((await c.call("/api/auth/register", { body: { email: "dave@example.com", password: "short" } })).status, 400);
  await c.register("dave@example.com");
  assert.equal((await new Client(srv.base).register("DAVE@example.com")).status, 409);
  const wrongPw = await new Client(srv.base).call<{ error: string }>("/api/auth/login", { body: { email: "dave@example.com", password: "wrong password" } });
  const noUser = await new Client(srv.base).call<{ error: string }>("/api/auth/login", { body: { email: "nobody@example.com", password: "wrong password" } });
  assert.equal(wrongPw.status, 401);
  assert.equal(noUser.status, 401);
  assert.equal(wrongPw.body.error, noUser.body.error);
  const ok = await new Client(srv.base).call<{ user: UserDTO }>("/api/auth/login", { body: { email: " Dave@Example.com ", password: "correct horse battery" } });
  assert.equal(ok.body.user.email, "dave@example.com");
});

test("expired access token → 401 token_expired; refresh rotates; /me refreshes on its own", async () => {
  const c = new Client(srv.base);
  const { body } = await c.register("erin@example.com");
  const sid = ((await db.get<{ id: number }>("SELECT id FROM sessions WHERE user_id = ? ORDER BY id DESC", body.user.id))!).id;
  const past = Math.floor(Date.now() / 1000) - 3600;
  c.jar.set("pv_at", { value: signJwt({ sub: String(body.user.id), role: "user", sid, iat: past, exp: past + 900 }, TEST_SECRET), path: "/api" });

  const denied = await c.call<{ code: string }>("/api/prompts/1/save", { method: "POST" });
  assert.equal(denied.status, 401);
  assert.equal(denied.body.code, "token_expired");

  const oldRefresh = c.jar.get("pv_rt")!.value;
  assert.equal((await c.call("/api/auth/refresh", { method: "POST" })).status, 200);
  assert.notEqual(c.jar.get("pv_rt")!.value, oldRefresh);
  assert.equal((await c.call("/api/prompts/1/save", { method: "POST" })).status, 200);

  c.jar.delete("pv_at");
  assert.equal((await c.call<{ user: UserDTO }>("/api/auth/me")).body.user.email, "erin@example.com");
  assert.ok(c.jar.has("pv_at"));
});

test("refresh-token reuse (theft) revokes the whole session family", async () => {
  const victim = new Client(srv.base);
  await victim.register("frank@example.com");
  const stolen = victim.jar.get("pv_rt")!.value;
  assert.equal((await victim.call("/api/auth/refresh", { method: "POST" })).status, 200); // rotates

  const attacker = new Client(srv.base);
  attacker.jar.set("pv_rt", { value: stolen, path: "/api/auth" });
  const r = await attacker.call<{ code: string }>("/api/auth/refresh", { method: "POST" });
  assert.equal(r.status, 401);
  assert.equal(r.body.code, "session_revoked");
  // The victim's current tokens are dead too — they must sign in again.
  assert.equal((await victim.call("/api/auth/refresh", { method: "POST" })).status, 401);
  assert.equal((await victim.call("/api/prompts/1/save", { method: "POST" })).status, 401);
});

test("logout kills the session server-side, not just the cookie", async () => {
  const c = new Client(srv.base);
  await c.register("gina@example.com");
  const copiedAccess = c.jar.get("pv_at")!.value;
  await c.call("/api/auth/logout", { body: {} });
  assert.equal(c.jar.size, 0);
  assert.equal((await c.call<{ user: null }>("/api/auth/me")).body.user, null);
  const replay = new Client(srv.base);
  replay.jar.set("pv_at", { value: copiedAccess, path: "/api" });
  assert.equal((await replay.call("/api/prompts/1/save", { method: "POST" })).status, 401);
});

test("sign out everywhere ends other devices' sessions", async () => {
  const laptop = new Client(srv.base);
  await laptop.register("hank@example.com");
  const phone = new Client(srv.base);
  await phone.call("/api/auth/login", { body: { email: "hank@example.com", password: "correct horse battery" } });
  await laptop.call("/api/auth/logout", { body: { everywhere: true } });
  assert.equal((await phone.call("/api/auth/refresh", { method: "POST" })).status, 401);
  assert.equal((await phone.call("/api/prompts/1/save", { method: "POST" })).status, 401);
});

test("signing in claims this browser's anonymous saves", async () => {
  const visitor = "cccccccc-3333-3333-3333-333333333333";
  await db.run("INSERT INTO saves (visitor_id, prompt_id, created_at) VALUES (?, 3, 0)", visitor);
  const c = new Client(srv.base, visitor);
  await c.register("ivy@example.com");
  const saved = await c.call<{ prompts: { id: number }[] }>("/api/vault?saved=1");
  assert.deepEqual(saved.body.prompts.map((p) => p.id), [3]);
  assert.equal(((await db.get<{ n: number }>("SELECT COUNT(*) n FROM saves WHERE visitor_id = ?", visitor))!).n, 0);
});

test("cross-site requests are blocked; the extension origin only reaches /api/analyze", async () => {
  const c = new Client(srv.base);
  await c.register("jack@example.com");
  assert.equal((await c.call("/api/prompts/1/save", { method: "POST", headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await c.call("/api/prompts/1/save", { method: "POST", headers: { Origin: "chrome-extension://abcdef" } })).status, 403);
  assert.equal((await c.call("/api/prompts/1/save", { method: "POST" })).status, 200);
});

test("dev proxy (Vite :5173 -> :3000 rewrites Host) can sign in; cross-site still blocked", async () => {
  const dev = { Origin: "http://localhost:5173" };
  const creds = { email: "vite@example.com", password: "hunter2hunter2" };
  const reg = await new Client(srv.base).call("/api/auth/register", { body: creds, headers: { ...dev, "Sec-Fetch-Site": "same-origin" } });
  assert.ok(reg.status < 300, `register via dev proxy: ${reg.status}`);
  const login = await new Client(srv.base).call("/api/auth/login", { body: creds, headers: { ...dev, "Sec-Fetch-Site": "same-origin" } });
  assert.equal(login.status, 200);
  const bad = await new Client(srv.base).call("/api/auth/login", { body: creds, headers: { ...dev, "Sec-Fetch-Site": "cross-site" } });
  assert.equal(bad.status, 403);
});

test("admin: role from ADMIN_EMAILS; users get 403, anonymous 401; admins see every submission", async () => {
  const user = new Client(srv.base);
  await user.register("kim@example.com");
  await user.call("/api/submissions", { body: { url: "https://www.instagram.com/reel/KimReel01/", note: "ghibli", category: "Other" } });

  assert.equal((await new Client(srv.base).call("/api/admin/submissions")).status, 401);
  assert.equal((await user.call("/api/admin/submissions")).status, 403);

  const boss = new Client(srv.base);
  assert.equal((await boss.register("boss@example.com")).body.user.role, "admin");
  const list = await boss.call<AdminSubmissionsResponse>("/api/admin/submissions?status=all");
  const kim = list.body.submissions.find((s) => s.submittedBy === "kim@example.com")!;
  assert.equal(kim.url, "https://www.instagram.com/reel/KimReel01/");
  assert.ok(list.body.counts.pending >= 1);

  const upd = await boss.call<{ status: string }>(`/api/admin/submissions/${kim.id}`, { body: { status: "added" } });
  assert.equal(upd.body.status, "added");
  assert.equal((await user.call(`/api/admin/submissions/${kim.id}`, { body: { status: "rejected" } })).status, 403);
  assert.equal((await user.call<{ submissions: { status: string }[] }>("/api/submissions")).body.submissions[0]!.status, "added");

  // Scripts can still use the ADMIN_TOKEN bearer; a wrong token is refused.
  assert.equal((await new Client(srv.base).call("/api/admin/submissions", { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } })).status, 200);
  assert.equal((await new Client(srv.base).call("/api/admin/submissions", { headers: { Authorization: "Bearer nope" } })).status, 401);
});

test("role changes apply immediately, without waiting for the token to expire", async () => {
  const c = new Client(srv.base);
  const { body } = await c.register("lee@example.com");
  await db.run("UPDATE users SET role = 'admin' WHERE id = ?", body.user.id);
  assert.equal((await c.call("/api/admin/submissions")).status, 200);
  await db.run("UPDATE users SET role = 'user' WHERE id = ?", body.user.id);
  assert.equal((await c.call("/api/admin/submissions")).status, 403);
});

test("adding an email to ADMIN_EMAILS later makes an existing session admin without signing in again", async () => {
  // Own server instance: the shared one has used up this IP's sign-up rate limit.
  const before = await startServer(db);
  const c = new Client(before.base);
  const { body } = await c.register("late@example.com");
  await before.close();
  assert.equal(body.user.role, "user");
  // Redeploy with the email added: same database and signing key, new admin list.
  const redeployed = await startServer(db, { authOptions: { adminEmails: ["late@example.com"] } });
  try {
    const moved = new Client(redeployed.base);
    for (const [k, v] of c.jar) moved.jar.set(k, v); // same browser cookies
    assert.equal((await moved.call<{ user: UserDTO }>("/api/auth/me")).body.user.role, "admin");
    assert.equal((await moved.call("/api/admin/submissions")).status, 200);
  } finally {
    await redeployed.close();
  }
});
