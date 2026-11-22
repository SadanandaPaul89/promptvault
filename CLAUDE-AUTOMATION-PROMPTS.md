# PromptVault — Claude Automation Prompt Series
# Use: Paste these ONE BY ONE into Claude Code / Claude, in order.
# After each prompt, let Claude finish + run the app, verify, THEN paste the next.
# Stack target for a standalone build: Next.js 15 (App Router) + TypeScript + Tailwind + Supabase (Postgres + pgvector)

---

## PROMPT 0 — MASTER CONTEXT (paste first, in a fresh project)

```
You are building PromptVault, a searchable database of prompts that went viral on Instagram Reels / YouTube Shorts / LinkedIn and usually get lost in saves.

Product promise: A user types their use case in plain language (e.g. "Diwali product photo for my saree shop", "birthday photo edit", "Veo 3 video for my cafe") and gets back curated MASTER PROMPTS — templates with [VARIABLES] they can fill and copy — ranked by a hybrid algorithm, not by date or random order.

Core rules for everything you build:
1. Search is by USE CASE, not just keywords.
2. Every prompt is a MASTER PROMPT: a template with [VARIABLES] in square brackets, a tool tag (ChatGPT / Gemini / Nano Banana / Veo 3 / Kling / Claude / Midjourney), a category, and a source link (the Reel/Post it came from).
3. Ranking formula is fixed: Final = 0.45*Semantic + 0.20*Keyword + 0.20*Success + 0.10*Viral + 0.05*Freshness. Show a "Why this rank?" breakdown on every card.
4. Free to search and copy. No pay-per-prompt.
5. India-first examples: Festival/Diwali, saree, small shops, Hinglish use cases are first-class.
6. Do not scrape Instagram/LinkedIn automatically (they block it). Ingestion is semi-automated: Submit-a-Link inbox + admin manual verification.

Confirm you understand, list the pages, data tables, and components you will build, then wait for Prompt 1.
```

## PROMPT 1 — SCAFFOLD

```
Scaffold PromptVault as a Next.js 15 App Router project with TypeScript, Tailwind CSS, and Supabase client setup (.env.example with NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY or GEMINI_API_KEY for embeddings).

Pages: / (home + search), /prompt/[id], /categories/[slug], /trending, /submit, /my-vault, /admin (protected).
Make it mobile-first, fast, no heavy UI library. Create the folder structure, layout, header/footer, and a placeholder home page. Run the dev server and show me it loads.
```

## PROMPT 2 — DATABASE SCHEMA

```
Create the Supabase SQL schema for PromptVault and give me the migration file:

Table prompts: id uuid pk, title text, slug text unique, master_prompt text, raw_prompt text, category text, tool text, use_cases text[], variables text[], example_output text, source_url text, source_platform text ('reel'|'shorts'|'linkedin'|'manual'), creator_name text, viral_score int (0-100), copy_count int default 0, success_votes int default 0, total_votes int default 0, created_at timestamptz, embedding vector(1536).

Table saves: id, user_id, prompt_id, created_at. Unique(user_id, prompt_id).
Table submissions: id, url text, platform text, user_note text, status text ('pending'|'extracting'|'needs_manual_research'|'draft'|'published'|'rejected'), extracted_caption text, extracted_transcript text, extracted_ocr text, draft_prompt_id uuid nullable, created_at.
Table search_logs: id, query text, clicked_prompt_id uuid, created_at.

Add pgvector extension, an index on embedding, and RLS: prompts are public-read, writes are admin/service-role only; saves are owner-only.
```

## PROMPT 3 — SEED THE 24 MASTER PROMPTS

```
Seed exactly 24 curated master prompts, 3 per category, across these 8 categories: AI Photo, AI Video, Reels Script, Business, Study, Coding, Resume, Festival.
Tools must cover: Nano Banana, Gemini, ChatGPT, Veo 3, Kling, Claude, Midjourney.
Every seed prompt MUST have: a title a normal user would search for, a master_prompt with 2-5 [VARIABLES], use_cases as 3-5 plain phrases users actually type (e.g. "diwali product photo", "saree shop photo", "birthday photo edit"), viral_score, copy_count, success_votes.
Include at minimum these proven test cases: (1) Diwali Product Photo for a saree shop, (2) Birthday Photo Edit portrait, (3) 90s Bollywood Saree portrait, (4) Veo 3 cafe promo video, (5) Resume/LinkedIn headline improver.
Write them as a seed SQL / seed.ts file, run it once only when the prompts table is empty, and list the 24 titles when done.
```

## PROMPT 4 — THE SEARCH ALGORITHM (core — do not simplify this)

```
Implement POST /api/search in Next.js that takes { query: string } and returns ranked prompts with a score breakdown per prompt.

Steps:
1. Intent parsing: detect boosts from the query — "for my shop / business / product" boosts Business; "photo / edit / portrait" boosts AI Photo; "video / reel" boosts AI Video; a festival name boosts Festival. Extract the detected intent and return it in the response.
2. Keyword score (0-100): BM25-style / Postgres full-text match on title + use_cases + category + tool. Exact tool name match (e.g. "veo 3") = strong boost.
3. Semantic score (0-100): embed the query (text-embedding-3-small or Gemini embedding), cosine similarity against prompt.embedding (embed title + use_cases + master_prompt at seed time), rescaled to 0-100.
4. Success score (0-100): success_votes / max(total_votes,1) * 100, blended with copy_count normalised across the catalog so new prompts are not buried.
5. Viral score: the stored viral_score. Freshness (0-100): 100 for today, decaying over 90 days from created_at.
6. Final = 0.45*Semantic + 0.20*Keyword + 0.20*Success + 0.10*Viral + 0.05*Freshness, plus the intent boost from step 1.
7. Log every search in search_logs. Return: prompt, finalScore, breakdown {semantic, keyword, success, viral, freshness}, matchedUseCase.

Acceptance tests you must pass and show me: query "Diwali product photo for my saree shop" ranks the Diwali Product Photo prompt #1; query "birthday photo edit" ranks the Birthday Photo prompt #1. If a test fails, fix the scoring, do not change the test.
```

## PROMPT 5 — HOME + SEARCH UI + PROMPT CARD

```
Build the home page: hero with one big search bar "What do you want to create today?", quick-search chips (birthday photo edit, diwali product photo, veo 3 cafe video, resume headline), category chips for the 8 categories, and a Trending This Week section (sorted by viral_score).

Build the PromptCard component: title, category + tool badges, viral and success badges, the master_prompt preview, rank + "Why this rank?" expandable breakdown (the 5 scores from the API), and buttons: Copy, Save, It Worked.
Search must be live: typing / submitting re-ranks results using /api/search, shows the detected intent ("Showing Business + Festival prompts for: saree shop"), and handles empty results with "No prompt yet — submit the Reel and we'll add it" + a link to /submit.
Make it look premium on mobile first, then desktop. No lorem ipsum.
```

## PROMPT 6 — VARIABLES, COPY, SAVE, "IT WORKED"

```
On each PromptCard / prompt detail page, parse all [VARIABLES] from master_prompt and render a small input for each one. As the user fills them, show the live finished prompt below. The Copy button copies the FINISHED prompt (variables replaced; any unfilled variable stays as [NAME]), increments copy_count via an API route, and shows "Copied".
Save button: requires login (Supabase Auth, magic link or Google), saves to saves table, prompt appears in /my-vault. If logged out, prompt the user to log in and preserve the save intent.
"It Worked" button: increments success_votes + total_votes once per user/session, then re-runs the current search so the user can see the re-ranking happen.
```

## PROMPT 7 — SUBMIT A REEL / LINKEDIN POST (user side)

```
Build /submit: a form with URL (Instagram Reel / YouTube Shorts / LinkedIn post), platform auto-detected from the URL, a required one-line note "What output did the creator show?", and optional "What do you remember of the prompt?".
On submit, insert into submissions with status 'pending' and show the user their submission in a public Extraction Queue list with its status. Validate the URL domain (instagram.com, youtube.com, linkedin.com). No scraping happens here.
```

## PROMPT 8 — ADMIN EXTRACTION PANEL (Reels + LinkedIn analysis + manual research)

```
Build /admin (admin-only) with three parts:

A) Submission Inbox: list submissions by status (Pending, Extracting, Needs Manual Research, Draft, Published). Admin can change status.

B) Analysis Workspace for one submission: fields to paste the extracted material — caption, pinned/first comment, audio transcript, on-screen OCR text, LinkedIn post body, LinkedIn carousel slide text — plus source creator name. Add an "Extract Master Prompt" AI action: send all pasted material to the LLM with instructions to (1) find the verbatim prompt if present, (2) otherwise reconstruct a prompt that would produce the shown output, (3) templatize specifics into [VARIABLES], (4) suggest title, category, tool, and 3-5 use_cases. Output goes into an editable DRAFT, never directly live.

C) Manual Research Checklist (for when the prompt is NOT in the post/Reel): a per-submission checklist the admin ticks off — watched at 0.5x and noted exact output; checked caption; checked pinned comment; did the comment-keyword/DM trick; checked creator bio link / Linktree / YouTube cross-post description; Googled creator handle + keywords + "prompt"; screenshotted frames and OCR'd them; reconstructed and TESTED the prompt in the target tool and compared output (80%+ match); templatized variables. Only when "tested" is ticked can the admin Publish.

Publish action: creates a row in prompts from the draft (generating its embedding), sets submission status to 'published' and draft_prompt_id, and the new prompt must immediately appear in search. Show me the full flow working with one example Reel link and one example LinkedIn link.
```

## PROMPT 9 — PROMPT DETAIL + CATEGORIES + SEO

```
Build /prompt/[slug]: full master prompt, variable filler + copy (same logic as Prompt 6), example output description, source Reel/Post link with creator credit, related prompts (same category, ranked by the search algorithm with the prompt title as query).
Build /categories/[slug] pages for the 8 categories. Add SEO: unique title/meta per prompt and category, Open Graph tags, sitemap.xml, and JSON-LD for the prompt list. Every prompt must be indexable by its use-case phrases.
```

## PROMPT 10 — POLISH, TEST, FIX

```
Run a full QA pass and fix everything you find: (1) the two acceptance searches from Prompt 4 still rank #1 correctly, (2) copy with variables filled and unfilled, (3) save/unsave + My Vault, (4) It Worked re-ranking, (5) submit -> admin inbox -> draft -> publish -> searchable, (6) mobile layout with no horizontal overflow, category chips may scroll horizontally, (7) empty states, loading states, and error states on every page, (8) no console errors. Give me a checklist report with pass/fail per item and screenshots or it didn't happen.
```

## PROMPT 11 — DEPLOY

```
Prepare PromptVault for production on Vercel + Supabase: production env vars list (no secrets in code), build passes with `npm run build`, seed runs only when prompts table is empty (never overwrite user saves/votes/copies), and a README with: how to run locally, how to add a prompt manually via /admin, the ranking formula, and how to add a new category. Deploy and give me the live URL + a final smoke test on the live site using the Diwali saree shop query.
```

---

## Operator notes (for Max, not for Claude)
- Paste prompts in order. Do not combine Prompt 4 with Prompt 5 — the algorithm must pass its acceptance tests before the UI is built on top of it.
- If Claude invents a different ranking formula, reject it and re-paste Prompt 4. The formula is the product.
- The seed in Prompt 3 is the minimum. Your real growth loop is Prompt 8: every Reel/LinkedIn submission you research manually becomes a new searchable prompt.
- Keep the prototype scores honest: label viral/copy/success numbers as prototype signals until real user data replaces them.
