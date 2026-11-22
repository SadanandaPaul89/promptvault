import { defineAction, z, type ActionsModule } from "@hatch/space-sdk";
import { desc, eq } from "drizzle-orm";
import * as schema from "./schema";

type Seed = { title: string; masterPrompt: string; category: string; tool: string; useCases: string[]; variables: string[]; viralScore: number; copyCount: number; workedVotes: number; totalVotes: number; daysAgo: number };

const SEED: Seed[] = [
  { title: "Cinematic Portrait from a Selfie", category: "AI Photo", tool: "Nano Banana", viralScore: 96, copyCount: 18420, workedVotes: 412, totalVotes: 468, daysAgo: 2, variables: ["PHOTO", "MOOD", "OUTFIT", "BACKGROUND"], useCases: ["portrait", "selfie to cinematic photo", "profile picture", "dp", "photo editing"], masterPrompt: "Transform the uploaded [PHOTO] into a cinematic portrait. Keep the face 100% identical — same skin tone, features and expression. Change outfit to [OUTFIT], background to [BACKGROUND], mood: [MOOD]. Shot on 85mm lens, shallow depth of field, golden-hour light, ultra-detailed skin texture, 4K. No cartoon, no face change." },
  { title: "Restore Old / Damaged Family Photo", category: "AI Photo", tool: "Gemini", viralScore: 91, copyCount: 15230, workedVotes: 389, totalVotes: 421, daysAgo: 4, variables: ["OLD_PHOTO", "YEAR"], useCases: ["old photo restore", "family photo", "damaged photo fix", "black and white to colour"], masterPrompt: "Restore this [OLD_PHOTO] from around [YEAR]. Remove scratches, tears, folds and stains. Reconstruct missing areas naturally, colourise realistically with true skin tones, sharpen faces without changing identity. Keep clothing and background authentic to the era. Output high-resolution, print-ready." },
  { title: "3D Action Figure / Collectible Toy of Yourself", category: "AI Photo", tool: "ChatGPT Image", viralScore: 94, copyCount: 22100, workedVotes: 356, totalVotes: 445, daysAgo: 3, variables: ["PHOTO", "NAME", "ACCESSORIES"], useCases: ["3d figurine", "action figure", "toy trend", "collectible", "fun gift photo"], masterPrompt: "Create a 1/7 scale 3D action figure of the person in [PHOTO], in premium collectible packaging. Name on box: [NAME]. Include accessories: [ACCESSORIES]. Figure wears the same outfit as the photo, realistic PVC toy texture, studio lighting, box art in background, ultra detailed." },
  { title: "8-Second Product Ad — Veo 3", category: "AI Video", tool: "Veo 3", viralScore: 95, copyCount: 19800, workedVotes: 401, totalVotes: 462, daysAgo: 1, variables: ["PRODUCT", "SETTING", "VOICE_LINE"], useCases: ["product ad video", "veo 3 video", "shop advertisement", "brand video", "selling video"], masterPrompt: "Cinematic 8-second product ad: [PRODUCT] on [SETTING], camera slowly orbits 180°, light sweeps across the surface, water droplets / steam for freshness. A confident voice says: '[VOICE_LINE]'. End with product centred, logo space on top. Photorealistic, 24fps, no text distortion." },
  { title: "Make Any Photo Talk & Sing", category: "AI Video", tool: "Kling", viralScore: 88, copyCount: 12400, workedVotes: 298, totalVotes: 361, daysAgo: 5, variables: ["PHOTO", "SCRIPT", "EMOTION"], useCases: ["talking photo", "lip sync video", "photo speaks", "birthday wish video"], masterPrompt: "Animate the person in [PHOTO] to speak this script with natural lip-sync: '[SCRIPT]'. Emotion: [EMOTION]. Keep head movement subtle, eyes blinking naturally, background static, face identity unchanged. Duration 10 seconds, vertical 9:16." },
  { title: "Before / After Transformation Reel", category: "AI Video", tool: "Veo 3", viralScore: 90, copyCount: 14750, workedVotes: 342, totalVotes: 398, daysAgo: 3, variables: ["BEFORE", "AFTER", "SUBJECT"], useCases: ["transformation video", "before after", "makeover reel", "room renovation video", "weight loss reel"], masterPrompt: "Seamless transformation video of [SUBJECT]: starts as [BEFORE], camera pushes in, a light flash / whip-pan transition at second 3, reveals [AFTER] — same angle, same framing. Satisfying, high-energy, vertical 9:16, photorealistic throughout." },
  { title: "30-Second Hook Script That Stops the Scroll", category: "Reels Script", tool: "ChatGPT", viralScore: 89, copyCount: 16900, workedVotes: 377, totalVotes: 430, daysAgo: 2, variables: ["TOPIC", "AUDIENCE", "TONE"], useCases: ["reel script", "hook", "viral reel", "content script", "instagram growth"], masterPrompt: "Write a 30-second Reel script on [TOPIC] for [AUDIENCE], tone: [TONE]. Give me: (1) 5 hook lines under 7 words for the first 2 seconds, (2) spoken script with [ON-SCREEN TEXT] and [B-ROLL] cues per line, (3) a loop ending that replays into the hook, (4) caption + 5 hashtags. Hinglish where it sounds natural." },
  { title: "Hinglish Storytime Reel — Full Script", category: "Reels Script", tool: "Claude", viralScore: 82, copyCount: 9200, workedVotes: 244, totalVotes: 302, daysAgo: 7, variables: ["STORY_TOPIC", "TWIST"], useCases: ["storytime", "hinglish script", "story reel", "narrative video"], masterPrompt: "Turn this topic into a 45-second Hinglish storytime script: [STORY_TOPIC]. Start mid-action, no intro. Build tension every 8 seconds, end with this twist: [TWIST]. Write exactly how a 22-year-old in Delhi/Mumbai actually talks — mix Hindi-English naturally. Add pause markers (…) where I should breathe." },
  { title: "7 Reels from 1 Idea — Content Calendar", category: "Reels Script", tool: "ChatGPT", viralScore: 84, copyCount: 10800, workedVotes: 271, totalVotes: 318, daysAgo: 6, variables: ["NICHE", "PRODUCT_OR_SKILL"], useCases: ["content calendar", "7 day plan", "creator ideas", "niche content", "posting plan"], masterPrompt: "I create content in [NICHE] and want to promote [PRODUCT_OR_SKILL]. Give me 7 Reel ideas for 7 days: for each — hook line, 20-second script outline, trending audio type to search, best posting time (IST), and CTA. Mix: 2 educational, 2 entertaining, 1 story, 1 proof/testimonial style, 1 direct offer. No repeats." },
  { title: "Diwali Product Photo for Your Shop", category: "Business", tool: "Nano Banana", viralScore: 97, copyCount: 24300, workedVotes: 488, totalVotes: 521, daysAgo: 1, variables: ["PRODUCT", "SHOP_TYPE", "OFFER"], useCases: ["diwali product photo", "saree shop", "shop photo", "product photo for business", "festival sale", "small business marketing"], masterPrompt: "Professional product photo of [PRODUCT] for a [SHOP_TYPE]. Festive Diwali setting: warm fairy lights bokeh, marigold flowers, brass diyas at the side, rich warm tones. Product is hero — sharp, centred, true colours. Leave clean space at top for text. Add subtle text area: '[OFFER]'. Studio-quality, ready to post on Instagram & WhatsApp status." },
  { title: "Caption + Hashtags That Actually Sell", category: "Business", tool: "ChatGPT", viralScore: 85, copyCount: 13600, workedVotes: 312, totalVotes: 371, daysAgo: 4, variables: ["PRODUCT", "PRICE", "CITY"], useCases: ["instagram caption", "sell on instagram", "small business", "hashtags", "shop marketing"], masterPrompt: "Write an Instagram caption to sell [PRODUCT] at [PRICE] in [CITY]. Line 1 = hook with the result, not the product. Then 3 short benefit lines, social proof placeholder, clear CTA: 'DM ORDER or WhatsApp'. End with 12 hashtags: 4 big, 4 medium, 4 hyper-local to [CITY]. Also give a Hinglish version." },
  { title: "WhatsApp Broadcast Offer Message", category: "Business", tool: "ChatGPT", viralScore: 81, copyCount: 8900, workedVotes: 229, totalVotes: 276, daysAgo: 8, variables: ["OFFER", "DEADLINE", "SHOP_NAME"], useCases: ["whatsapp marketing", "offer message", "broadcast", "sale announcement", "customers"], masterPrompt: "Write a WhatsApp broadcast for [SHOP_NAME]: offer is [OFFER], valid till [DEADLINE]. Under 60 words, friendly not spammy, starts with customer's benefit, one emoji max per line, ends with a reply keyword ('Reply YES to book'). Give 3 variants: formal, friendly, Hinglish." },
  { title: "Feynman Exam Crammer — Learn Anything Fast", category: "Study", tool: "ChatGPT", viralScore: 93, copyCount: 20100, workedVotes: 445, totalVotes: 489, daysAgo: 2, variables: ["TOPIC", "EXAM", "HOURS_LEFT"], useCases: ["exam preparation", "study fast", "feynman", "last minute study", "learn topic"], masterPrompt: "Teach me [TOPIC] for [EXAM] — I have [HOURS_LEFT] hours. Use Feynman method: explain like I'm 12, then add exam-level depth, then quiz me with 5 questions one by one (wait for my answer). After each answer, tell me what's missing. Finish with a 10-line revision sheet + 3 most likely exam questions with model answers." },
  { title: "Notes → Flashcards + Viva Quiz", category: "Study", tool: "Claude", viralScore: 86, copyCount: 11400, workedVotes: 289, totalVotes: 334, daysAgo: 5, variables: ["NOTES"], useCases: ["flashcards", "notes revision", "quiz me", "active recall", "study notes"], masterPrompt: "Here are my notes: [NOTES]. Convert into: (1) 15 flashcards Q/A — short, one fact each, (2) 10 viva-style oral questions with 2-line answers, (3) a 'trap list' of 5 confusions students make in this topic. Order flashcards from easy → hard. Nothing outside my notes except marking traps." },
  { title: "Viva / Interview Answer Builder", category: "Study", tool: "ChatGPT", viralScore: 83, copyCount: 9700, workedVotes: 251, totalVotes: 305, daysAgo: 6, variables: ["SUBJECT", "TOPIC"], useCases: ["viva preparation", "oral exam", "interview answers", "college viva"], masterPrompt: "Act as a strict but fair viva examiner for [SUBJECT], topic [TOPIC]. Ask me one question at a time, starting basic → advanced. After my answer: score /10, give the ideal 3-line answer, and one follow-up the real examiner would ask. Do 10 rounds, then give my readiness report." },
  { title: "Fix My Bug Like a Senior Dev", category: "Coding", tool: "Claude", viralScore: 90, copyCount: 15800, workedVotes: 367, totalVotes: 412, daysAgo: 3, variables: ["LANGUAGE", "CODE", "ERROR"], useCases: ["debug code", "fix bug", "error help", "programming help"], masterPrompt: "Language: [LANGUAGE]. My code: [CODE]. Error: [ERROR]. Don't just fix it — (1) explain the root cause in 2 lines, (2) give the corrected code with the changed lines marked, (3) tell me the concept I misunderstood, (4) give me a 5-minute practice task on that concept. No full rewrite unless necessary." },
  { title: "Landing Page in One Prompt", category: "Coding", tool: "ChatGPT", viralScore: 87, copyCount: 12900, workedVotes: 303, totalVotes: 365, daysAgo: 4, variables: ["PRODUCT", "AUDIENCE", "STYLE"], useCases: ["build website", "landing page", "portfolio site", "startup page", "html css"], masterPrompt: "Build a complete single-file HTML landing page for [PRODUCT], audience: [AUDIENCE], style: [STYLE]. Include: hero with headline + CTA, 3 features, pricing, testimonial placeholders, FAQ, footer. Modern CSS, mobile-first, no external images (use CSS/SVG), smooth scroll. Give full working code, then list what to customise first." },
  { title: "Explain Code Like I'm a Beginner", category: "Coding", tool: "ChatGPT", viralScore: 80, copyCount: 7600, workedVotes: 198, totalVotes: 247, daysAgo: 9, variables: ["CODE", "LANGUAGE"], useCases: ["explain code", "learn programming", "beginner coding", "understand code"], masterPrompt: "Explain this [LANGUAGE] code to a complete beginner: [CODE]. Go block by block: what it does in plain English, a real-life analogy, then the technical term. End with: 3 'what happens if I change…' experiments I should try, and 2 questions to check I understood." },
  { title: "ATS Resume Bullet Rewriter", category: "Resume", tool: "ChatGPT", viralScore: 92, copyCount: 18700, workedVotes: 423, totalVotes: 471, daysAgo: 2, variables: ["ROLE", "MY_WORK", "COMPANY_TYPE"], useCases: ["resume", "ats resume", "job application", "internship resume", "cv bullets"], masterPrompt: "Rewrite my work into ATS resume bullets for a [ROLE] role at a [COMPANY_TYPE]. My raw work: [MY_WORK]. Rules: start every bullet with a strong verb, add numbers/metrics where my work implies them (mark guesses with ?), keep each bullet under 18 words, mirror keywords a [ROLE] JD would use. Give 5 bullets + 1-line summary." },
  { title: "LinkedIn About Section That Gets Calls", category: "Resume", tool: "Claude", viralScore: 84, copyCount: 10200, workedVotes: 256, totalVotes: 311, daysAgo: 7, variables: ["FIELD", "ACHIEVEMENT", "GOAL"], useCases: ["linkedin profile", "about section", "personal branding", "job search"], masterPrompt: "Write my LinkedIn About section. Field: [FIELD]. Best achievement: [ACHIEVEMENT]. Goal: [GOAL]. First line must be a hook a recruiter stops at. First person, human, zero buzzword soup ('passionate synergy' banned). 150-200 words, ends with what I'm open to + how to reach me. Give 2 tones: confident-student and professional." },
  { title: "Cold DM / Cover Note for Internships", category: "Resume", tool: "ChatGPT", viralScore: 85, copyCount: 11100, workedVotes: 274, totalVotes: 329, daysAgo: 5, variables: ["COMPANY", "ROLE", "ONE_PROOF"], useCases: ["cold dm", "internship application", "cover letter", "linkedin dm", "job outreach"], masterPrompt: "Write a cold DM to a hiring manager at [COMPANY] for a [ROLE] internship. My one proof of work: [ONE_PROOF]. Under 90 words, opens with something specific about their product (leave [SPECIFIC_DETAIL] for me to fill), no begging tone, ends with one easy yes/no question. Also write a 3-line email version." },
  { title: "Diwali Family Portrait — Festival Edit", category: "Festival", tool: "Nano Banana", viralScore: 94, copyCount: 21500, workedVotes: 431, totalVotes: 478, daysAgo: 1, variables: ["FAMILY_PHOTO", "OUTFIT_STYLE"], useCases: ["diwali photo", "family portrait", "festival edit", "ethnic outfit photo", "greeting photo"], masterPrompt: "Edit [FAMILY_PHOTO] into a Diwali portrait: change outfits to [OUTFIT_STYLE] (kurta / saree, rich festive colours), background = decorated home entrance with diyas, rangoli and fairy lights. Keep every face exactly the same. Warm golden light, everyone smiling naturally, high resolution — ready to share as a Diwali greeting." },
  { title: "Eid / Festival Greeting Card Prompt", category: "Festival", tool: "Gemini", viralScore: 79, copyCount: 6800, workedVotes: 176, totalVotes: 221, daysAgo: 10, variables: ["FESTIVAL", "NAME", "MESSAGE"], useCases: ["greeting card", "eid card", "festival wishes", "whatsapp greeting"], masterPrompt: "Create an elegant [FESTIVAL] greeting card: crescent / festive motifs, deep green & gold (or festival colours), Arabic-inspired border pattern, empty centre space. Add text exactly: '[MESSAGE]' and '— [NAME]' in clean calligraphy-style font. No people, no spelling errors in the text, print quality." },
  { title: "Birthday Photo — Cake, Balloons & Confetti", category: "Festival", tool: "Nano Banana", viralScore: 91, copyCount: 17300, workedVotes: 398, totalVotes: 442, daysAgo: 3, variables: ["PHOTO", "AGE", "THEME_COLOUR"], useCases: ["birthday photo", "birthday edit", "celebration photo", "party photo"], masterPrompt: "Turn [PHOTO] into a birthday celebration portrait: person holding a cake with '[AGE]' candles, balloons and confetti in [THEME_COLOUR], party lights bokeh behind. Keep face identical, outfit upgraded to smart party wear, joyful natural expression. Vertical 4:5, ultra detailed, Instagram-ready." },
];

const SYNONYMS: Record<string, string[]> = {
  shop: ["business", "sell", "product", "store", "marketing"], store: ["business", "shop", "product"], sell: ["business", "shop", "product"],
  photo: ["image", "portrait", "picture", "edit"], image: ["photo", "picture"], video: ["reel", "veo", "kling"],
  resume: ["cv", "job", "ats", "internship"], job: ["resume", "internship", "linkedin"], study: ["exam", "learn", "notes"], exam: ["study", "viva", "quiz"],
  birthday: ["celebration", "cake", "party"], diwali: ["festival", "product", "family"], code: ["coding", "bug", "programming"], coding: ["code", "bug"],
};

function tokenize(s: string): string[] { return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2); }
function expand(tokens: string[]): Set<string> { const out = new Set(tokens); for (const t of tokens) { for (const s of SYNONYMS[t] ?? []) out.add(s); } return out; }

function scorePrompt(p: typeof schema.prompts.$inferSelect, query: string) {
  const qTokens = tokenize(query);
  const expanded = expand(qTokens);
  const useCases: string[] = JSON.parse(p.useCases || "[]");
  const hay = `${p.title} ${p.category} ${p.tool} ${useCases.join(" ")}`.toLowerCase();
  let keywordHits = 0; for (const t of qTokens) if (hay.includes(t)) keywordHits++;
  const keyword = qTokens.length ? keywordHits / qTokens.length : 0;
  let semHits = 0, semTotal = 0;
  for (const uc of useCases) { const ucTokens = tokenize(uc); semTotal += 1; if (ucTokens.some((t) => expanded.has(t)) || qTokens.some((t) => uc.toLowerCase().includes(t))) semHits++; }
  // also direct tool/category intent
  let intentBoost = 0;
  const ql = query.toLowerCase();
  if (ql.includes(p.tool.toLowerCase())) intentBoost += 0.25;
  if ((ql.includes("shop") || ql.includes("business") || ql.includes("sell")) && p.category === "Business") intentBoost += 0.3;
  if ((ql.includes("exam") || ql.includes("study")) && p.category === "Study") intentBoost += 0.3;
  const semantic = Math.min(1, (semTotal ? semHits / Math.max(2, semTotal * 0.6) : 0) + intentBoost);
  const success = p.totalVotes > 0 ? p.workedVotes / p.totalVotes : 0.75;
  const viral = p.viralScore / 100;
  const ageDays = Math.max(0, (Date.now() - p.createdAt.getTime()) / 86400000);
  const freshness = 1 / (1 + ageDays / 21);
  const hasQuery = qTokens.length > 0;
  const final = hasQuery
    ? Math.round((0.45 * semantic + 0.20 * keyword + 0.20 * success + 0.10 * viral + 0.05 * freshness) * 100)
    : Math.round((0.55 * viral + 0.30 * success + 0.15 * freshness) * 100);
  return { semantic: Math.round(semantic * 100), keyword: Math.round(keyword * 100), success: Math.round(success * 100), viral: Math.round(viral * 100), freshness: Math.round(freshness * 100), final };
}

async function ensureSeed(ctx: { db: <T>() => any }) {
  const db = ctx.db<typeof schema>();
  const existing = await db.select({ id: schema.prompts.id }).from(schema.prompts).limit(1);
  if (existing.length > 0) return;
  const now = Date.now();
  for (const s of SEED) {
    await db.insert(schema.prompts).values({
      title: s.title, masterPrompt: s.masterPrompt, category: s.category, tool: s.tool,
      useCases: JSON.stringify(s.useCases), variables: JSON.stringify(s.variables),
      viralScore: s.viralScore, copyCount: s.copyCount, workedVotes: s.workedVotes, totalVotes: s.totalVotes,
      createdAt: new Date(now - s.daysAgo * 86400000),
    });
  }
}

const promptOut = z.object({
  id: z.number(), title: z.string(), masterPrompt: z.string(), category: z.string(), tool: z.string(),
  useCases: z.array(z.string()), variables: z.array(z.string()), viralScore: z.number(), copyCount: z.number(),
  workedVotes: z.number(), totalVotes: z.number(), successRate: z.number(), saved: z.boolean(), createdAt: z.string(),
  score: z.object({ semantic: z.number(), keyword: z.number(), success: z.number(), viral: z.number(), freshness: z.number(), final: z.number() }),
});

export const Actions = {
  getVault: defineAction({
    description: "Returns ranked prompts for a search query and category, seeding the prototype catalog on first load.",
    request: z.object({ query: z.string().max(200).default(""), category: z.string().max(40).default("All"), savedOnly: z.boolean().default(false) }),
    response: z.object({
      prompts: z.array(promptOut),
      stats: z.object({ total: z.number(), savedCount: z.number(), totalCopies: z.number(), submissions: z.number() }),
      categories: z.array(z.string()),
    }),
    async handler(ctx, args) {
      await ensureSeed(ctx as any);
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.prompts).orderBy(desc(schema.prompts.viralScore));
      const saveRows = await db.select().from(schema.saves);
      const savedIds = new Set(saveRows.map((s: any) => s.promptId));
      const subRows = await db.select({ id: schema.submissions.id }).from(schema.submissions);
      let out = rows.map((r: any) => {
        const sc = scorePrompt(r, args.query.trim());
        return {
          id: r.id, title: r.title, masterPrompt: r.masterPrompt, category: r.category, tool: r.tool,
          useCases: JSON.parse(r.useCases || "[]"), variables: JSON.parse(r.variables || "[]"),
          viralScore: r.viralScore, copyCount: r.copyCount, workedVotes: r.workedVotes, totalVotes: r.totalVotes,
          successRate: r.totalVotes > 0 ? Math.round((r.workedVotes / r.totalVotes) * 100) : 75,
          saved: savedIds.has(r.id), createdAt: r.createdAt.toISOString(), score: sc,
        };
      });
      if (args.category !== "All") out = out.filter((p: any) => p.category === args.category);
      if (args.savedOnly) out = out.filter((p: any) => p.saved);
      out.sort((a: any, b: any) => b.score.final - a.score.final || b.viralScore - a.viralScore);
      const totalCopies = rows.reduce((a: number, r: any) => a + r.copyCount, 0);
      return { prompts: out, stats: { total: rows.length, savedCount: savedIds.size, totalCopies, submissions: subRows.length }, categories: ["All", "AI Photo", "AI Video", "Reels Script", "Business", "Study", "Coding", "Resume", "Festival"] };
    },
  }),
  toggleSave: defineAction({
    description: "Saves or unsaves a prompt.",
    request: z.object({ promptId: z.number().int().positive() }),
    response: z.object({ saved: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.saves).where(eq(schema.saves.promptId, args.promptId));
      if (existing.length > 0) { await db.delete(schema.saves).where(eq(schema.saves.promptId, args.promptId)); ctx.invalidateQueries(); return { saved: false }; }
      await db.insert(schema.saves).values({ promptId: args.promptId });
      ctx.invalidateQueries(); return { saved: true };
    },
  }),
  recordCopy: defineAction({
    description: "Records that a prompt was copied, increasing its copy count.",
    request: z.object({ promptId: z.number().int().positive() }),
    response: z.object({ copyCount: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.prompts).where(eq(schema.prompts.id, args.promptId));
      const row = rows[0]; if (!row) throw new Error("Prompt not found");
      const next = row.copyCount + 1;
      await db.update(schema.prompts).set({ copyCount: next }).where(eq(schema.prompts.id, args.promptId));
      ctx.invalidateQueries(); return { copyCount: next };
    },
  }),
  voteWorked: defineAction({
    description: "Records whether a prompt worked for the user, feeding the success score.",
    request: z.object({ promptId: z.number().int().positive(), worked: z.boolean() }),
    response: z.object({ successRate: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.prompts).where(eq(schema.prompts.id, args.promptId));
      const row = rows[0]; if (!row) throw new Error("Prompt not found");
      const total = row.totalVotes + 1; const worked = row.workedVotes + (args.worked ? 1 : 0);
      await db.update(schema.prompts).set({ totalVotes: total, workedVotes: worked }).where(eq(schema.prompts.id, args.promptId));
      ctx.invalidateQueries(); return { successRate: Math.round((worked / total) * 100) };
    },
  }),
  submitReel: defineAction({
    description: "Submits a Reel link so its prompt can be extracted and added to the vault.",
    request: z.object({ reelUrl: z.string().trim().min(8).max(500), note: z.string().max(300).default(""), category: z.string().max(40).default("AI Photo") }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const res = await db.insert(schema.submissions).values({ reelUrl: args.reelUrl, note: args.note, category: args.category, status: "pending" }).returning({ id: schema.submissions.id });
      const row = res[0]; if (!row) throw new Error("Submit failed");
      ctx.invalidateQueries(); return { id: row.id };
    },
  }),
  listSubmissions: defineAction({
    description: "Lists submitted Reel links awaiting extraction.",
    request: z.object({ limit: z.number().int().positive().max(50).default(20) }),
    response: z.object({ submissions: z.array(z.object({ id: z.number(), reelUrl: z.string(), note: z.string(), category: z.string(), status: z.string(), createdAt: z.string() })) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.submissions).orderBy(desc(schema.submissions.id)).limit(args.limit);
      return { submissions: rows.map((r: any) => ({ id: r.id, reelUrl: r.reelUrl, note: r.note, category: r.category, status: r.status, createdAt: r.createdAt.toISOString() })) };
    },
  }),
} satisfies ActionsModule;
