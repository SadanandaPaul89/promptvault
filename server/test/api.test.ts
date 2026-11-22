import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, seed } from "../src/db.ts";
import type { VaultResponse } from "../src/types.ts";
import { Client, startServer } from "./helpers.ts";

const db = await openDatabase(":memory:");
let srv: Awaited<ReturnType<typeof startServer>>;
let anon: Client;
let alice: Client;
let bob: Client;

before(async () => {
  srv = await startServer(db);
  anon = new Client(srv.base);
  alice = new Client(srv.base, "aaaaaaaa-1111-1111-1111-111111111111");
  bob = new Client(srv.base, "bbbbbbbb-2222-2222-2222-222222222222");
  await alice.register("alice@example.com");
  await bob.register("bob@example.com");
});
after(async () => { await srv.close(); db.close(); });

test("seeds both collections (524 prompts) and re-seeding is idempotent", async () => {
  assert.equal(await seed(db), 0); // unchanged seed files: skipped without touching prompts
  await db.run("DELETE FROM meta WHERE key = 'seed_hash'");
  assert.equal(await seed(db), 0); // forced re-run: every row already present
  assert.ok(await db.get("SELECT value FROM meta WHERE key = 'seed_hash'"));
  const n = ((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM prompts"))!).n;
  assert.equal(n, 524);
  const pm = ((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM prompts WHERE collection = 'Product Management'"))!).n;
  assert.equal(pm, 500);
});

test("search keeps the original ranking guarantees (public, no login)", async () => {
  const cases: [string, string][] = [
    ["Diwali product photo for my saree shop", "Diwali Product Photo for Your Shop"],
    ["birthday photo edit", "Birthday Photo — Cake, Balloons & Confetti"],
    ["Veo 3 product ad", "8-Second Product Ad — Veo 3"],
  ];
  for (const [q, title] of cases) {
    const { body } = await anon.call<VaultResponse>(`/api/vault?q=${encodeURIComponent(q)}`);
    assert.equal(body.prompts[0]?.title, title, q);
  }
});

test("PM queries surface the right category", async () => {
  const cases: [string, string][] = [
    ["write a PRD for a new feature", "Requirements & Documentation"],
    ["prioritize my roadmap", "Roadmap & Prioritization"],
    ["competitor analysis", "Market Research & Competitive Analysis"],
    ["user interview questions", "User Research & Customer Insights"],
  ];
  for (const [q, cat] of cases) {
    const { body } = await anon.call<VaultResponse>(`/api/vault?q=${encodeURIComponent(q)}`);
    assert.equal(body.prompts[0]?.category, cat, q);
  }
});

test("filters and pagination", async () => {
  const { body } = await anon.call<VaultResponse>(`/api/vault?collection=${encodeURIComponent("Product Management")}&limit=10&offset=10`);
  assert.equal(body.matched, 500);
  assert.equal(body.prompts.length, 10);
  assert.ok(body.prompts.every((p) => p.collection === "Product Management"));
  assert.equal((await anon.call("/api/vault?limit=1000")).status, 400);
});

test("saves are per account and invisible to other accounts and anonymous users", async () => {
  assert.equal((await anon.call("/api/prompts/1/save", { method: "POST" })).status, 401);
  assert.equal((await alice.call<{ saved: boolean }>("/api/prompts/1/save", { method: "POST" })).body.saved, true);

  const mine = await alice.call<VaultResponse>("/api/vault?saved=1");
  assert.deepEqual(mine.body.prompts.map((p) => p.id), [1]);
  const bobs = await bob.call<VaultResponse>("/api/vault?saved=1");
  assert.equal(bobs.body.matched, 0);
  assert.equal((await anon.call("/api/vault?saved=1")).status, 401);
  // The public listing never carries another account's saved flag.
  const pub = await bob.call<VaultResponse>("/api/vault?limit=60");
  assert.ok(pub.body.prompts.every((p) => !p.saved));
  const anonList = await anon.call<VaultResponse>("/api/vault?limit=60");
  assert.ok(anonList.body.prompts.every((p) => !p.saved && p.myVote === null));
});

test("one vote per account; changing it moves the vote; anonymous can't vote", async () => {
  const before = (await db.get<{ w: number; t: number }>("SELECT worked_votes w, total_votes t FROM prompts WHERE id = 2"))!;
  assert.equal((await anon.call("/api/prompts/2/vote", { body: { worked: true } })).status, 401);
  await alice.call("/api/prompts/2/vote", { body: { worked: true } });
  await alice.call("/api/prompts/2/vote", { body: { worked: true } });
  await alice.call("/api/prompts/2/vote", { body: { worked: false } });
  const after = (await db.get<{ w: number; t: number }>("SELECT worked_votes w, total_votes t FROM prompts WHERE id = 2"))!;
  assert.deepEqual({ ...after }, { w: before.w, t: before.t + 1 });
  assert.equal((await alice.call("/api/prompts/2/vote", { body: { worked: "yes" } })).status, 400);
});

test("submissions: login required, validated, and private to the submitter", async () => {
  assert.equal((await anon.call("/api/submissions", { body: { url: "https://www.instagram.com/reel/abc" } })).status, 401);
  assert.equal((await anon.call("/api/submissions")).status, 401);
  assert.equal((await alice.call("/api/submissions", { body: { url: "javascript:alert(1)" } })).status, 400);
  const ok = await alice.call<{ id: number }>("/api/submissions", { body: { url: "https://www.instagram.com/reel/abc", note: "test", category: "AI Photo" } });
  assert.equal(ok.status, 201);
  assert.equal((await alice.call<{ submissions: unknown[] }>("/api/submissions")).body.submissions.length, 1);
  assert.equal((await bob.call<{ submissions: unknown[] }>("/api/submissions")).body.submissions.length, 0);
});

test("unknown prompt is a 404; copy counting stays public", async () => {
  assert.equal((await anon.call("/api/prompts/999999/copy", { method: "POST" })).status, 404);
  assert.equal((await anon.call("/api/prompts/1/copy", { method: "POST" })).status, 200);
});

test("security and cache headers are set on API responses", async () => {
  const r = await anon.call("/api/health");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.ok(r.headers.get("content-security-policy")?.includes("default-src 'self'"));
  const v = await alice.call("/api/vault?saved=1");
  assert.equal(v.headers.get("cache-control"), "no-store, private");
  assert.equal(v.headers.get("vary"), "Cookie");
});
