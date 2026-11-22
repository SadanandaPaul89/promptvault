# Data Plan

## Context provenance
- `i want to build a website where we have a database of prompts viral in reels social media which usually gets lost, users can search about their use case and get curated master prompts, it should have an algorithm basically` (verbatim user request; defines core: searchable viral prompt database + ranking algorithm)
- `Build the MVP prototype now` (user acceptance of assistant proposal in parent conversation)
- Assistant proposal accepted by user: 8 categories (AI Photo, AI Video, Reels Script, Business/Marketing, Study, Coding, Resume/LinkedIn, Festival/Indian), hybrid ranking formula 0.45 semantic + 0.20 keyword + 0.20 success + 0.10 viral + 0.05 freshness, copy/save/submit-reel flows, Trending This Week sorted by Viral Score, master prompts with [VARIABLES] (proposal text in parent conversation; shapes MVP scope)

## Tested sources
No external API or web fetch is used at runtime. All prompt content is a locally seeded prototype catalog stored in ctx.db, as explicitly requested for the MVP prototype. Search/ranking runs server-side over that catalog. No declared hosts.

## Seed content
- 24 curated master prompts authored for the prototype across the 8 categories, each with: title, master_prompt template with [VARIABLES], tool (ChatGPT / Gemini / Nano Banana / Veo 3 / Kling / Midjourney / Claude), use_cases, variables list, viral_score, copy_count, success votes. Labeled in UI as prototype vault. Seeded once via migration-gated check (only when prompts table empty) so user saves/votes/copies are never overwritten.
- Viral scores / copy counts are prototype ranking signals for demonstrating the algorithm, not claimed real-world measurements; UI exposes the score breakdown transparently.

## Long-term data behavior
- **Refresh policy**: No external refresh; data changes only via user actions (copy, save, vote 'It Worked', submit reel link). No cron.
- **Growth**: User submissions append to submissions table with status pending; saves and votes persist per prompt.
- **Ordering**: Default = Trending (viral_score desc); Search = hybrid Final Score desc with breakdown returned per result.
- **Time semantics**: created_at stored as timestamp_ms; freshness computed from age in days at query time.

## Imagery
Imagery not needed: prompt database is text-first — the master prompt text itself is the content; cards use tool/category badges and score visuals instead of photos, avoiding fake preview images for prompts that have none.

## Post analyzer ingestion (added 2026-11-22)
- Source: a user-initiated, opt-in desktop browser extension. It reads the one post the user is viewing, in their own session, only when they click Analyze. The server still makes no requests to Instagram or LinkedIn. Mobile is "coming soon".
- Cache-first: one `analyses` row per canonical post key. Repeat requests are served instantly with no moderation. The first sighting of new prompts is moderated.
- Stored: extracted text (caption, OCR, transcript), the post link and the creator handle. Not stored: images, video, audio. Audio is deleted right after whisper.cpp transcription.
- Extraction is rule-based for now. LLM extraction is a planned future upgrade (deferred for cost).

## Rejected approaches
- **Tried**: Live scraping of Instagram Reels / external prompt sites
  **Why rejected**: No reliable public API, login walls, and copyright/provenance risk; MVP prototype uses curated seed catalog instead, with a Submit-a-Reel form as the ingestion entry point.
- **Tried**: Pure keyword search
  **Why rejected**: User explicitly asked for an algorithm; hybrid scoring with intent boosts (e.g. 'for my shop' -> business) is the core differentiator and is implemented server-side.
