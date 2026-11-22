// Hybrid ranking:
//   with a query:  Final = 0.45*Semantic + 0.20*Keyword + 0.20*Success + 0.10*Viral + 0.05*Freshness
//   browsing:      Final = 0.55*Viral + 0.30*Success + 0.15*Freshness
// Pure functions — no I/O — so they are unit-testable.

import type { ScoreBreakdown } from "./types.ts";

export type RankablePrompt = {
  title: string;
  masterPrompt: string;
  category: string;
  section: string;
  tool: string;
  useCases: string[];
  viralScore: number;
  workedVotes: number;
  totalVotes: number;
  createdAt: number; // epoch ms
};

const STOPWORDS = new Set(
  "the and for with you your my our are was were this that these those from into about how what when where which who why can could should would will want need make give get help me please some any all one two use using write create build new best good like just tell show into onto via per than then them they their its it's i'm".split(" "),
);

const SYNONYMS: Record<string, string[]> = {
  // creator / viral
  shop: ["business", "sell", "store", "marketing"],
  store: ["business", "shop"],
  sell: ["business", "shop", "sales"],
  photo: ["image", "portrait", "picture", "edit"],
  image: ["photo", "picture"],
  picture: ["photo", "image"],
  video: ["reel", "veo", "kling"],
  resume: ["cv", "job", "ats", "internship"],
  cv: ["resume"],
  job: ["resume", "internship", "linkedin", "career"],
  study: ["exam", "learn", "notes"],
  exam: ["study", "viva", "quiz"],
  birthday: ["celebration", "cake", "party"],
  diwali: ["festival", "family"],
  code: ["coding", "bug", "programming"],
  coding: ["code", "bug"],
  // product management
  prd: ["requirement", "spec", "document", "documentation"],
  spec: ["requirement", "prd", "documentation"],
  requirement: ["prd", "spec", "story", "documentation"],
  story: ["requirement", "acceptance", "backlog"],
  okr: ["metric", "goal", "objective", "kpi"],
  kpi: ["metric", "analytics", "okr"],
  metric: ["kpi", "analytics", "data", "measure"],
  analytics: ["metric", "data", "dashboard"],
  roadmap: ["prioritization", "planning", "quarter"],
  prioritize: ["prioritization", "roadmap", "backlog"],
  prioritization: ["roadmap", "backlog", "rice"],
  backlog: ["prioritization", "roadmap", "story"],
  gtm: ["launch", "market", "positioning"],
  launch: ["gtm", "release", "announcement"],
  competitor: ["competitive", "market", "landscape"],
  competitive: ["competitor", "market"],
  persona: ["user", "customer", "segment"],
  interview: ["research", "user", "customer", "discovery"],
  survey: ["research", "feedback", "customer"],
  feedback: ["research", "customer", "survey"],
  discovery: ["research", "interview", "problem"],
  pricing: ["monetization", "price", "revenue"],
  revenue: ["monetization", "pricing", "business"],
  stakeholder: ["alignment", "executive", "cross", "functional"],
  engineering: ["engineer", "technical", "developer"],
  vision: ["strategy", "mission"],
  strategy: ["vision", "strategic"],
  ux: ["design", "usability", "user"],
  design: ["ux", "wireframe", "usability"],
  email: ["communication", "writing", "message"],
  memo: ["writing", "communication", "document"],
  career: ["promotion", "growth", "development"],
  pm: ["product", "management"],
};

// Query intent → category boost.
const INTENTS: [RegExp, string[]][] = [
  [/^(shop|business|sell|store)$/, ["Business"]],
  [/^(exam|study|viva)$/, ["Study"]],
  [/^(vision|strategy|strategic|mission|north)$/, ["Strategy & Vision"]],
  [/^(roadmap|prioriti[sz]e|prioritization|backlog|rice|moscow)$/, ["Roadmap & Prioritization"]],
  [/^(prd|spec|requirement|story|acceptance|documentation)$/, ["Requirements & Documentation"]],
  [/^(metric|kpi|okr|analytics|dashboard|funnel|retention|cohort|experiment)$/, ["Metrics, Analytics & Data"]],
  [/^(interview|persona|survey|feedback|discovery|jtbd|research)$/, ["User Research & Customer Insights"]],
  [/^(competitor|competitive|market|tam|landscape|swot)$/, ["Market Research & Competitive Analysis"]],
  [/^(launch|gtm|positioning|messaging|release)$/, ["Go-to-Market & Launch"]],
  [/^(stakeholder|alignment|executive|engineering|cross)$/, ["Stakeholder & Cross-functional Collaboration"]],
  [/^(email|memo|presentation|writing|announcement|update)$/, ["Communication & Writing"]],
  [/^(career|promotion|mentor|growth|salary)$/, ["Career & Personal Development"]],
  [/^(pricing|monetization|revenue|business)$/, ["Business & Monetization"]],
  [/^(ux|design|wireframe|usability|prototype|onboarding)$/, ["UX & Design Thinking"]],
];

export function stem(w: string): string {
  if (w.length <= 4) return w;
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.endsWith("ing") && w.length > 5) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 5) return w.slice(0, -2);
  if (w.endsWith("es") && w.length > 5 && !w.endsWith("ses")) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => (w.length > 2 || w === "pm" || w === "ux" || w === "ai") && !STOPWORDS.has(w))
    .map(stem);
}

function synonymsOf(t: string): string[] {
  return (SYNONYMS[t] ?? []).map(stem);
}

/** Fields searched, strongest first. Weight 1 = title-level match. */
type Field = { tokens: Set<string>; weight: number };

function fieldsFor(p: RankablePrompt): Field[] {
  return [
    { tokens: new Set(tokenize(p.title)), weight: 1 },
    { tokens: new Set(tokenize(`${p.section} ${p.useCases.join(" ")}`)), weight: 0.85 },
    { tokens: new Set(tokenize(`${p.category} ${p.tool}`)), weight: 0.7 },
    { tokens: new Set(tokenize(p.masterPrompt)), weight: 0.5 },
  ];
}

/** token → weight in [0.15, 1]; rare words weigh more than words every prompt contains. */
export type Idf = (token: string) => number;

export function buildIdf(prompts: RankablePrompt[]): Idf {
  const df = new Map<string, number>();
  for (const p of prompts) {
    const seen = new Set<string>();
    for (const f of fieldsFor(p)) for (const t of f.tokens) seen.add(t);
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = prompts.length;
  const norm = Math.log(n + 1);
  return (t) => (n === 0 ? 1 : Math.max(0.15, Math.log((n + 1) / ((df.get(t) ?? 0) + 1)) / norm));
}

export function scorePrompt(p: RankablePrompt, query: string, now = Date.now(), idf: Idf = () => 1): ScoreBreakdown {
  const qTokens = [...new Set(tokenize(query))];
  const success = p.totalVotes > 0 ? p.workedVotes / p.totalVotes : 0.75;
  const viral = Math.max(0, Math.min(100, p.viralScore)) / 100;
  const ageDays = Math.max(0, (now - p.createdAt) / 86_400_000);
  const freshness = 1 / (1 + ageDays / 21);
  const pct = (n: number) => Math.round(n * 100);

  if (qTokens.length === 0) {
    return {
      semantic: 0, keyword: 0, success: pct(success), viral: pct(viral), freshness: pct(freshness),
      final: pct(0.55 * viral + 0.3 * success + 0.15 * freshness),
    };
  }

  const fields = fieldsFor(p);
  let keywordSum = 0;
  let semanticSum = 0;
  let idfSum = 0;
  for (const t of qTokens) {
    const w = idf(t);
    idfSum += w;
    // Keyword: exact token (stemmed), strongest field it appears in.
    let kw = 0;
    for (const f of fields) if (f.tokens.has(t)) { kw = Math.max(kw, f.weight === 0.5 ? 0.5 : 1); }
    keywordSum += kw * w;
    // Semantic: token or any synonym, weighted by field strength. Synonyms count
    // 50% and only in title/tags/category — in long prompt bodies they're noise.
    let sem = 0;
    const syns = synonymsOf(t);
    for (const f of fields) {
      if (f.tokens.has(t)) sem = Math.max(sem, f.weight);
      else if (f !== fields[fields.length - 1] && syns.some((s) => f.tokens.has(s))) sem = Math.max(sem, f.weight * 0.5);
    }
    semanticSum += sem * w;
  }
  const keyword = keywordSum / idfSum;

  let intentBoost = 0;
  const ql = query.toLowerCase();
  if (p.tool && ql.includes(p.tool.toLowerCase())) intentBoost += 0.25;
  for (const [re, cats] of INTENTS) {
    if (cats.includes(p.category) && qTokens.some((t) => re.test(t))) { intentBoost += 0.3; break; }
  }
  const semantic = semanticSum === 0 && keyword === 0 ? 0 : Math.min(1, semanticSum / idfSum + intentBoost);

  return {
    semantic: pct(semantic), keyword: pct(keyword), success: pct(success), viral: pct(viral), freshness: pct(freshness),
    final: pct(0.45 * semantic + 0.2 * keyword + 0.2 * success + 0.1 * viral + 0.05 * freshness),
  };
}

/**
 * A query result is relevant only if a meaningful share of the query matched —
 * one generic word (e.g. "product") in a five-word query isn't enough.
 */
export function isRelevant(s: ScoreBreakdown, hasQuery: boolean): boolean {
  return !hasQuery || s.semantic >= 25 || s.keyword >= 50;
}
