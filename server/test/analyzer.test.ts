import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openDatabase } from "../src/db.ts";
import { createService } from "../src/api.ts";
import { createAnalyzer, ANALYZED_COLLECTION } from "../src/analyze.ts";
import { createApp } from "../src/app.ts";
import { createAuth } from "../src/auth.ts";
import { TEST_SECRET } from "./helpers.ts";
import { canonicalize } from "../src/canonical.ts";
import { extractCandidates, isDmGated } from "../src/extract.ts";
import type { AnalysisDTO, AnalysisLookup } from "../src/types.ts";

// --- canonical URLs -----------------------------------------------------------

test("canonicalize: Instagram variants map to one key", () => {
  const urls = [
    "https://www.instagram.com/reel/C9xYz12AbCd/",
    "https://instagram.com/reels/C9xYz12AbCd/?igsh=MWQ1ZGUxMzBkMA==",
    "https://www.instagram.com/some.creator/reel/C9xYz12AbCd/?utm_source=ig_web_copy_link",
    "http://m.instagram.com/tv/C9xYz12AbCd",
  ];
  for (const u of urls) assert.equal(canonicalize(u)?.key, "ig:C9xYz12AbCd", u);
  assert.equal(canonicalize("https://www.instagram.com/p/DAbc123xyz/")?.url, "https://www.instagram.com/p/DAbc123xyz/");
  assert.equal(canonicalize("https://www.instagram.com/some.creator/"), null);
  assert.equal(canonicalize("https://www.instagram.com/explore/"), null);
});

test("canonicalize: LinkedIn feed URNs and vanity /posts/ URLs", () => {
  const id = "7251234567890123456";
  assert.equal(canonicalize(`https://www.linkedin.com/feed/update/urn:li:activity:${id}/`)?.key, `li:activity:${id}`);
  assert.equal(canonicalize(`https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A${id}?utm_source=share`)?.key, `li:activity:${id}`);
  assert.equal(canonicalize(`https://www.linkedin.com/posts/jane-doe_ai-prompts-activity-${id}-AbCd?utm_source=share`)?.key, `li:activity:${id}`);
  assert.equal(canonicalize(`https://in.linkedin.com/posts/jane_x-ugcPost-${id}-zz`)?.key, `li:ugcPost:${id}`);
  assert.equal(canonicalize("https://www.linkedin.com/in/jane-doe/"), null);
  assert.equal(canonicalize("https://evil.com/reel/C9xYz12AbCd/"), null);
  assert.equal(canonicalize("javascript:alert(1)"), null);
});

// --- extraction -----------------------------------------------------------------

test("extract: prompt after a marker in a caption, with variables + tool", () => {
  const caption = `Turn your selfie into a 90s Bollywood poster 🔥

Prompt 👇
Create a retro 90s Bollywood movie poster using the uploaded {photo}. Keep the face identical. Add the title [MOVIE NAME] in bold hand-painted letters, film grain, warm cinematic lighting, 4k.

Try it on Gemini and tag me! #aiart #gemini #bollywood`;
  const { candidates, dmGated } = extractCandidates({ text: caption });
  assert.equal(dmGated, false);
  assert.equal(candidates.length, 1);
  const c = candidates[0]!;
  assert.match(c.masterPrompt, /^Create a retro 90s Bollywood movie poster/);
  assert.ok(!c.masterPrompt.includes("#"));
  assert.deepEqual(c.variables.sort(), ["MOVIE_NAME", "PHOTO"]);
  assert.equal(c.tool, "Gemini");
  assert.equal(c.category, "AI Photo");
  assert.equal(c.title, "Turn your selfie into a 90s Bollywood poster");
});

test("extract: LinkedIn post with a quoted prompt", () => {
  const post = `I've used this ChatGPT prompt to rewrite my resume for every application:

"Act as a senior recruiter. Rewrite my resume bullet points for the [JOB TITLE] role so they are ATS-friendly, quantified and start with strong action verbs. Here is my resume: [RESUME]"

It got me 3 interviews in a week.`;
  const { candidates } = extractCandidates({ text: post });
  assert.equal(candidates.length, 1);
  assert.match(candidates[0]!.masterPrompt, /^Act as a senior recruiter/);
  assert.equal(candidates[0]!.tool, "ChatGPT");
  assert.equal(candidates[0]!.category, "Resume");
});

test("extract: prompt only in OCR and transcript; captions without prompts find nothing", () => {
  const ocr = `SAVE THIS\n\nPROMPT:\nGenerate an 8 second cinematic video of a steaming chai cup on a rainy Mumbai balcony, slow camera push in, shallow depth of field, moody lighting`;
  const r1 = extractCandidates({ text: "Rainy day vibes ☔ #chai", ocrText: ocr });
  assert.equal(r1.candidates.length, 1);
  assert.equal(r1.candidates[0]!.source, "ocr");
  assert.equal(r1.candidates[0]!.category, "AI Video");

  const transcript = "okay so open chatgpt and type this prompt: act as my study coach and create a seven day revision plan for my biology exam with daily quizzes and short notes. that's it, follow for more";
  const r2 = extractCandidates({ transcript });
  assert.equal(r2.candidates.length, 1);
  assert.match(r2.candidates[0]!.masterPrompt, /^Act as my study coach.*short notes\.?$/);
  assert.equal(r2.candidates[0]!.category, "Study");

  // Verbatim whisper.cpp (large-v3) output for a spoken reel — note the comma after "prompt".
  const whisper = "Okay so open chat GPT and type this prompt, act as my study coach and create a 7 day revision plan for my biology exam with daily quizzes. That's it, follow for more.";
  const r3 = extractCandidates({ transcript: whisper });
  assert.equal(r3.candidates.length, 1);
  assert.match(r3.candidates[0]!.masterPrompt, /^Act as my study coach.*daily quizzes\.?$/);
  assert.equal(r3.candidates[0]!.tool, "ChatGPT");

  assert.equal(extractCandidates({ text: "Had a great time at the conference! Thanks to everyone who came by. #networking" }).candidates.length, 0);
});

test("extract: detects comment-for-DM gating", () => {
  assert.equal(isDmGated("Comment 'PROMPT' and I'll send it to your DMs"), true);
  assert.equal(isDmGated("Full prompt in my bio 🔗"), true);
  assert.equal(isDmGated("Here is the prompt, enjoy"), false);
  const r = extractCandidates({ text: "This AI trend is crazy 😱 Comment AI and I'll DM you the prompt" });
  assert.deepEqual(r, { candidates: [], dmGated: true });
});

// --- HTTP flow --------------------------------------------------------------------

const V1 = "aaaaaaaa-1111-1111-1111-111111111111";
const V2 = "bbbbbbbb-2222-2222-2222-222222222222";
const TOKEN = "test-admin-token";
let server: Server;
let base = "";
const db = await openDatabase(":memory:");
const heard: number[] = [];

async function call<T>(path: string, opts: { method?: string; body?: unknown; visitor?: string; token?: string } = {}) {
  const headers: Record<string, string> = { "X-Visitor-Id": opts.visitor ?? V1 };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(base + path, { method: opts.method ?? "GET", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  return { status: res.status, body: (await res.json()) as T };
}

before(async () => {
  const analyzer = createAnalyzer(db, {
    transcriber: async (audio) => {
      heard.push(audio.length);
      return "type this prompt: act as a youtube script writer and write a 30 second reel script with a strong hook about [TOPIC] for beginners. that's it";
    },
  });
  server = createServer(createApp({ service: createService(db), auth: createAuth(db, { jwtSecret: TEST_SECRET }), analyzer, adminToken: TOKEN }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); db.close(); });

const REEL = "https://www.instagram.com/reel/TestReel001/";
const CAPTION = "Prompt: Transform the uploaded [PHOTO] into a Studio Ghibli style watercolor scene with soft pastel lighting, keep the face recognizable, cinematic composition, 4k";

test("first analysis → pending; later requests (anyone, any URL variant) hit the cache", async () => {
  const miss = await call<AnalysisLookup>(`/api/analyze?url=${encodeURIComponent(REEL)}`);
  assert.deepEqual(miss.body, { found: false, key: "ig:TestReel001" });

  const first = await call<AnalysisDTO>("/api/analyze", { method: "POST", body: { url: REEL, creator: "@artsy", text: CAPTION } });
  assert.equal(first.status, 201);
  assert.equal(first.body.cached, false);
  assert.equal(first.body.status, "pending");
  assert.deepEqual(first.body.prompts, []);

  // Different visitor, tracking params, /reels/ path — still a hit, no re-extraction.
  const hit = await call<AnalysisDTO>("/api/analyze", { method: "POST", visitor: V2, body: { url: "https://instagram.com/reels/TestReel001/?igsh=xyz", text: "ignored" } });
  assert.equal(hit.status, 200);
  assert.equal(hit.body.cached, true);
  assert.equal(hit.body.id, first.body.id);
  assert.equal(hit.body.requestCount, 2);
});

test("moderation: approve publishes prompts; cache then serves them to everyone", async () => {
  assert.equal((await call("/api/admin/analyses")).status, 401);
  const list = await call<{ analyses: { id: number; candidates: unknown[] }[] }>("/api/admin/analyses?status=pending", { token: TOKEN });
  const item = list.body.analyses.find((a) => a.candidates.length > 0)!;
  const approved = await call<AnalysisDTO>(`/api/admin/analyses/${item.id}/approve`, { method: "POST", body: {}, token: TOKEN });
  assert.equal(approved.body.status, "approved");
  assert.equal(approved.body.prompts.length, 1);
  assert.deepEqual(approved.body.prompts[0]!.variables, ["PHOTO"]);

  const later = await call<AnalysisDTO>(`/api/analyze?url=${encodeURIComponent(REEL)}`, { visitor: "cccccccc-3333-3333-3333-333333333333" });
  assert.equal(later.body.status, "approved");
  assert.equal(later.body.prompts[0]!.title, approved.body.prompts[0]!.title);

  const vault = (await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM prompts WHERE collection = ?", ANALYZED_COLLECTION))!;
  assert.equal(vault.n, 1);
});

test("a post repeating a vault prompt is auto-approved and bumps its viral score", async () => {
  const seedPrompt = (await db.get<{ id: number; master_prompt: string; viral_score: number }>("SELECT id, master_prompt, viral_score FROM prompts WHERE seed_key IS NOT NULL AND collection = 'Viral Creator Prompts' LIMIT 1"))!;
  const r = await call<AnalysisDTO>("/api/analyze", { method: "POST", body: { url: "https://www.instagram.com/p/RepostAbc1/", text: `Prompt: ${seedPrompt.master_prompt}` } });
  assert.equal(r.body.status, "approved");
  assert.deepEqual(r.body.prompts.map((p) => p.id), [seedPrompt.id]);
  const after = (await db.get<{ viral_score: number }>("SELECT viral_score FROM prompts WHERE id = ?", seedPrompt.id))!;
  assert.equal(after.viral_score, Math.min(100, seedPrompt.viral_score + 1));
});

test("reel audio is transcribed and mined; LinkedIn text posts need no media", async () => {
  const audio = Buffer.from("fake-webm-bytes").toString("base64");
  const reel = await call<AnalysisDTO>("/api/analyze", { method: "POST", body: { url: "https://www.instagram.com/reel/AudioOnly01/", text: "Easy script hack 🎬", audio: { mime: "audio/webm;codecs=opus", data: audio } } });
  assert.equal(reel.body.status, "pending");
  assert.equal(heard.length, 1);
  const row = (await db.get<{ transcript: string; candidates: string }>("SELECT transcript, candidates FROM analyses WHERE id = ?", reel.body.id))!;
  assert.match(row.transcript, /youtube script writer/);
  assert.equal((JSON.parse(row.candidates) as { category: string }[])[0]!.category, "Reels Script");

  const li = await call<AnalysisDTO>("/api/analyze", { method: "POST", body: { url: "https://www.linkedin.com/posts/x_y-activity-7251234567890000001-ab", text: "Great week at work, grateful for the team!" } });
  assert.equal(li.body.status, "no_prompt");
  assert.equal(li.body.platform, "linkedin");

  const gated = await call<AnalysisDTO>("/api/analyze", { method: "POST", body: { url: "https://www.instagram.com/reel/Gated000001/", text: "Comment GHIBLI and I'll DM you the prompt!" } });
  assert.equal(gated.body.status, "dm_gated");
});

test("analyze validation", async () => {
  assert.equal((await call("/api/analyze", { method: "POST", body: { url: "https://www.instagram.com/someone/" } })).status, 400);
  assert.equal((await call("/api/analyze", { method: "POST", body: { url: "https://www.instagram.com/reel/BadAudio01/", audio: { mime: "video/mp4", data: "" } } })).status, 400);
  assert.equal((await call("/api/analyze?url=https://example.com/x")).status, 400);
  assert.equal((await call("/api/admin/analyses/1/approve", { method: "POST", body: {}, token: TOKEN })).status, 409);
});
