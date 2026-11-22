import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.ts";
import { detectVariables } from "../src/admin-prompts.ts";
import type { ImportResult, VaultResponse } from "../src/types.ts";

import { Client, startServer } from "./helpers.ts";

const db = await openDatabase(":memory:");
let srv: Awaited<ReturnType<typeof startServer>>;
let admin: Client;
let user: Client;

before(async () => {
  srv = await startServer(db, { authOptions: { adminEmails: ["admin@example.com"] } });
  admin = new Client(srv.base, "aaaaaaaa-0000-0000-0000-000000000001");
  user = new Client(srv.base, "bbbbbbbb-0000-0000-0000-000000000002");
  await admin.register("admin@example.com");
  await user.register("user@example.com");
});
after(async () => { await srv.close(); db.close(); });

const imp = (c: Client, prompts: unknown, opts: { dryRun?: boolean; defaults?: Record<string, string> } = {}) =>
  c.call<ImportResult & { error?: string }>("/api/admin/prompts", { body: { prompts, dryRun: opts.dryRun ?? false, defaults: opts.defaults ?? {} } });

test("variables are detected from [brackets] the same way the UI fills them", () => {
  assert.deepEqual(detectVariables("Write about [product name] for [TARGET_AUDIENCE], then [product name] again"), ["PRODUCT_NAME", "TARGET_AUDIENCE"]);
  assert.deepEqual(detectVariables("no placeholders here"), []);
});

test("only admins can add prompts", async () => {
  assert.equal((await imp(new Client(srv.base), [{}])).status, 401);
  assert.equal((await imp(user, [{}])).status, 403);
});

test("dry run validates every row and writes nothing", async () => {
  const before = (await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM prompts"))!.n;
  const r = await imp(admin, [
    { title: "Cold email opener", masterPrompt: "Write a cold email to [PROSPECT] about [OFFER]. Keep it under 90 words.", category: "Sales", collection: "Sales Kit" },
    { title: "", masterPrompt: "short", category: "" },
    { title: "Has extra column", prompt: "Summarise [ARTICLE] in five bullet points for a busy founder.", category: "Writing", collection: "Sales Kit", colour: "blue" },
  ], { dryRun: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.dryRun, true);
  assert.deepEqual(r.body.rows.map((x) => x.status), ["new", "invalid", "new"]);
  assert.deepEqual(r.body.rows[0]!.variables, ["PROSPECT", "OFFER"]);
  const bad = r.body.rows[1]!.errors.join(" ");
  assert.match(bad, /title is required/);
  assert.match(bad, /too short/);
  assert.match(bad, /category is required/);
  assert.match(bad, /collection is required/);
  assert.match(r.body.rows[2]!.warnings.join(" "), /Ignored unknown column: colour/);
  assert.equal(r.body.summary.imported, 0);
  assert.equal((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM prompts"))!.n, before);
});

test("import inserts new rows, skips invalid and duplicates, and shows up in the vault right away", async () => {
  const existing = (await db.get<{ master_prompt: string }>("SELECT master_prompt FROM prompts WHERE source = 'seed' LIMIT 1"))!;
  const r = await imp(admin, [
    // CSV-style row: aliases, list as "a | b", score as text, defaults fill the rest.
    { Title: "LinkedIn hook writer", "Master Prompt": "Write 5 scroll-stopping LinkedIn hooks about [TOPIC] for [AUDIENCE].", Tags: "linkedin | hooks | Writing", "Viral Score": "40" },
    { title: "Already exists", masterPrompt: existing.master_prompt, category: "Writing" },
    { title: "Twice in file A", masterPrompt: "Explain [CONCEPT] like I'm twelve, with one everyday analogy.", category: "Study" },
    { title: "Twice in file B", masterPrompt: "Explain  [CONCEPT] like I'm twelve, with one everyday analogy. ", category: "Study" },
    { title: "Bad score", masterPrompt: "Plan a week of meals for [DIET] on a budget of [AMOUNT].", category: "Life", viralScore: 400 },
  ], { defaults: { collection: "Creator Toolkit", category: "Writing", tool: "ChatGPT" } });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.rows.map((x) => x.status), ["new", "duplicate", "new", "duplicate", "invalid"]);
  assert.match(r.body.rows[1]!.errors[0]!, /Already in the vault as #/);
  assert.match(r.body.rows[3]!.errors[0]!, /Same prompt as row 3/);
  assert.equal(r.body.summary.imported, 2);
  assert.ok(r.body.rows[0]!.id);

  const row = (await db.get<Record<string, unknown>>("SELECT * FROM prompts WHERE id = ?", r.body.rows[0]!.id))!;
  assert.equal(row.collection, "Creator Toolkit");
  assert.equal(row.category, "Writing");
  assert.equal(row.tool, "ChatGPT");
  assert.equal(row.viral_score, 40);
  assert.equal(row.source, "admin");
  assert.equal(row.added_by, "admin@example.com");
  assert.deepEqual(JSON.parse(String(row.use_cases)), ["linkedin", "hooks", "writing"]);
  assert.deepEqual(JSON.parse(String(row.variables)), ["TOPIC", "AUDIENCE"]);

  // Cache invalidated: anyone browsing sees it immediately.
  const v = await new Client(srv.base).call<VaultResponse>("/api/vault?q=linkedin%20hooks&limit=5");
  assert.equal(v.body.prompts[0]?.title, "LinkedIn hook writer");
  assert.ok(v.body.collections.some((c) => c.name === "Creator Toolkit"));

  // Re-importing the same file adds nothing.
  const again = await imp(admin, [{ title: "LinkedIn hook writer", masterPrompt: "Write 5 scroll-stopping LinkedIn hooks about [TOPIC] for [AUDIENCE].", category: "Writing", collection: "Creator Toolkit" }]);
  assert.equal(again.body.summary.imported, 0);
  assert.equal(again.body.rows[0]!.status, "duplicate");
});

test("request-level limits", async () => {
  assert.equal((await imp(admin, [])).status, 400);
  assert.equal((await imp(admin, "not an array")).status, 400);
  const many = Array.from({ length: 1001 }, (_, i) => ({ title: `T${i}`, masterPrompt: `Prompt number ${i} about [X]`, category: "C", collection: "K" }));
  assert.equal((await imp(admin, many, { dryRun: true })).status, 413);
});

test("recently added list, and delete removes the prompt with its saves; built-ins are protected", async () => {
  const added = await admin.call<{ prompts: { id: number; title: string }[] }>("/api/admin/prompts");
  const hook = added.body.prompts.find((p) => p.title === "LinkedIn hook writer")!;
  assert.ok(hook);
  assert.equal((await user.call("/api/admin/prompts")).status, 403);

  await user.call(`/api/prompts/${hook.id}/save`, { method: "POST" });
  assert.equal((await user.call(`/api/admin/prompts/${hook.id}`, { method: "DELETE" })).status, 403);
  const del = await admin.call(`/api/admin/prompts/${hook.id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.equal(await db.get("SELECT 1 AS x FROM prompts WHERE id = ?", hook.id), undefined);
  assert.equal(await db.get("SELECT 1 AS x FROM saves WHERE prompt_id = ?", hook.id), undefined);
  assert.equal((await user.call<VaultResponse>("/api/vault?saved=1")).body.prompts.length, 0);

  const seed = (await db.get<{ id: number }>("SELECT id FROM prompts WHERE source = 'seed' LIMIT 1"))!;
  assert.equal((await admin.call(`/api/admin/prompts/${seed.id}`, { method: "DELETE" })).status, 409);
  assert.equal((await admin.call(`/api/admin/prompts/999999`, { method: "DELETE" })).status, 404);
});
