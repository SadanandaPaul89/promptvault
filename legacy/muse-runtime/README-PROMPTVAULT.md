# PromptVault — MVP (already built)

Searchable database of prompts that went viral on Reels / Shorts / LinkedIn and usually get lost.
Users search by use case in plain language and get curated MASTER PROMPTS ranked by a hybrid algorithm:
Final = 0.45*Semantic + 0.20*Keyword + 0.20*Success + 0.10*Viral + 0.05*Freshness

## What's in this zip
- `client/` — React client (App.tsx is the whole UI: search, cards, variables, copy/save/vote, trending, submit)
- `server/src/actions.ts` — server actions incl. the ranking algorithm + 24-prompt seed catalog
- `server/src/schema.ts` — DB schema (prompts, saves, submissions)
- `drizzle/` — SQL migrations
- `DATA-PLAN.md` — data provenance, seed and ranking decisions for this build
- `CLAUDE-AUTOMATION-PROMPTS.md` — the 12-prompt series (0–11) to rebuild / extend this as a standalone Next.js + Supabase app with Claude Code, including the Admin Extraction Panel for Reels + LinkedIn posts and the manual-research checklist
- `package.json`, `space.json` — this build runs on the Muse web-artifact runtime (Bun + @hatch/space-sdk). It is NOT a plain `npm run dev` Next.js app — use the Claude prompt series to port it standalone, or run it inside Muse.

## Verified in the live MVP
- Search "Diwali product photo for my saree shop" → Diwali Product Photo prompt ranks #1 (Final 98)
- Search "birthday photo edit" → Birthday Photo prompt ranks #1
- 24 prompts, 8 categories: AI Photo, AI Video, Reels Script, Business, Study, Coding, Resume, Festival
- Tools: Nano Banana, Veo 3, Kling, ChatGPT, Gemini, Claude, Midjourney
- Features: live [VARIABLES] filling, Copy finished prompt, Save to My Vault, "It worked" vote re-ranks, Trending This Week, Submit-a-Reel extraction queue

## Honest limits
- Viral / copy / success numbers in the seed are prototype ranking signals, not real-world measurements.
- No live Instagram/LinkedIn scraping — ingestion is Submit-a-Link + admin manual research (see Prompt 8 in CLAUDE-AUTOMATION-PROMPTS.md).
