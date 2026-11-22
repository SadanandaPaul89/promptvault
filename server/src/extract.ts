// Rule-based prompt extraction (no LLM). Takes the text we could get from a
// post — caption / post body, OCR of images and reel frames, reel transcript —
// and returns prompt candidates normalized to the vault's [VARIABLE] format.
// Pure functions so they're unit-testable; an LLM pass can replace
// `extractCandidates` later without touching the rest of the pipeline.

export type ExtractSources = {
  /** Instagram caption or LinkedIn post body. */
  text?: string;
  /** OCR of images / reel keyframes; blocks separated by blank lines. */
  ocrText?: string;
  /** Reel audio transcript. */
  transcript?: string;
};

export type SourceKind = "text" | "ocr" | "transcript";

export type Candidate = {
  title: string;
  masterPrompt: string;
  category: string;
  tool: string;
  variables: string[];
  source: SourceKind;
  /** 0–1 heuristic confidence. */
  confidence: number;
};

export type ExtractResult = { candidates: Candidate[]; dmGated: boolean };

const MIN_CONFIDENCE = 0.45;
const MAX_CANDIDATES = 5;

// "Comment PROMPT and I'll DM it", "prompt in bio", "DM me 'AI' for the prompt"…
const DM_GATE = [
  /\bcomment\b[^.\n]{0,50}\b(dm|inbox|send|message|link)\b/i,
  /\b(dm|message|inbox) me\b[^.\n]{0,40}\b(prompt|guide|link)/i,
  /\bprompts?\b[^.\n]{0,30}\b(in|at|on) (my |the )?(bio|profile|link)\b/i,
  /\blink in bio\b/i,
];

// Phrases that introduce the prompt itself.
const MARKER = /\b(?:prompts?|copy (?:this|it)|paste (?:this|it)|use this(?: prompt)?|type this|here(?:'s| is) the prompt)\b\s*(?:[:,\-–—👇⬇↓]+|is\b|below\b)\s*/gi; // "," — speech-to-text often writes "this prompt, act as…"

const IMPERATIVE = /^(act as|you are|i want you|pretend|imagine|create|generate|make|write|design|transform|turn|convert|edit|change|replace|give|draft|build|analy[sz]e|help|explain|summari[sz]e|rewrite|plan|list|prepare|use (the|my|this) (uploaded|attached)|take (the|my|this)|(an? )?(hyper|ultra)[- ]?realistic|(an? )?(cinematic|photorealistic|close-up|portrait|wide shot|8k|4k))\b/i;

const TOOL_HINTS = /(--ar\b|--v\b|--style\b|--stylize\b|\b8k\b|\b4k\b|photorealistic|hyper[- ]?realistic|ultra[- ]?realistic|cinematic|depth of field|bokeh|\b\d{2,3}mm\b|lighting|aspect ratio|shot on|high detail|ultra[- ]?detailed|step by step|act as|in the style of|keep the face)/gi;

const SPAM = /\b(follow (me|us|for)|like (and|&) share|save (this|it) for later|turn on (post )?notifications|tag a friend|share with)\b/i;

const PLACEHOLDER = /\[([^\]\n]{1,40})\]|\{([^}\n]{1,40})\}|<([^>\n]{1,40})>/g;

const TOOLS: [RegExp, string][] = [
  [/nano ?banana/i, "Nano Banana"],
  [/\bveo ?3?\b/i, "Veo 3"],
  [/\bkling\b/i, "Kling"],
  [/\bsora\b/i, "Sora"],
  [/\brunway\b/i, "Runway"],
  [/midjourney|--ar\b|--v \d/i, "Midjourney"],
  [/\bleonardo\b/i, "Leonardo"],
  [/\bclaude\b/i, "Claude"],
  [/\bgemini\b/i, "Gemini"],
  [/chat ?gpt[^.\n]{0,20}\b(image|photo|picture)|gpt[- ]?image/i, "ChatGPT Image"],
  [/chat ?gpt|\bgpt[- ]?\d/i, "ChatGPT"],
];

// Category keywords for the creator collection (matches viral-prompts.json).
const CATEGORIES: [string, RegExp][] = [
  ["Festival", /\b(diwali|holi|eid|christmas|navratri|ganesh|rakhi|raksha|onam|pongal|festival|new year)\b/gi],
  ["AI Video", /\b(video|veo|kling|sora|runway|clip|animate|animation|camera (pan|move)|slow motion|seconds?)\b/gi],
  ["AI Photo", /\b(photo|image|portrait|selfie|picture|headshot|lighting|lens|\d{2,3}mm|background|outfit|face|realistic|8k|4k)\b/gi],
  ["Reels Script", /\b(reel|script|hook|caption|voiceover|shorts|youtube|content idea|viral)\b/gi],
  ["Business", /\b(business|shop|store|product|brand|marketing|ad|ads|sales|customer|startup|instagram post)\b/gi],
  ["Study", /\b(study|exam|notes|learn|student|revision|quiz|explain|teacher|syllabus|viva)\b/gi],
  ["Coding", /\b(code|coding|bug|debug|function|python|javascript|api|program|developer|sql|react)\b/gi],
  ["Resume", /\b(resume|cv|linkedin|job|interview|career|cover letter|ats|recruiter|internship)\b/gi],
];

export function isDmGated(...texts: (string | undefined)[]): boolean {
  const all = texts.filter(Boolean).join("\n");
  return DM_GATE.some((re) => re.test(all));
}

/** Split into candidate blocks: text after prompt markers, quoted blocks, paragraphs. */
function blocksOf(text: string, kind: SourceKind): { body: string; marked: boolean }[] {
  const out: { body: string; marked: boolean }[] = [];
  const t = text.replace(/\r/g, "");

  // 1. Text following an explicit marker ("Prompt:", "Copy this 👇"), up to a blank line
  //    — or, for transcripts (no paragraphs), up to ~700 chars / a sign-off.
  for (const m of t.matchAll(MARKER)) {
    const start = (m.index ?? 0) + m[0].length;
    let rest = t.slice(start);
    if (kind === "transcript") {
      const stop = rest.search(/\b(that'?s it|and that'?s|now (just )?(hit|click|press)|follow (me|for))\b/i);
      rest = rest.slice(0, stop > 0 ? stop : 700);
    } else {
      const end = rest.search(/\n\s*\n/);
      if (end >= 0) rest = rest.slice(0, end);
    }
    out.push({ body: rest, marked: true });
  }

  // 2. Quoted blocks and code fences.
  for (const m of t.matchAll(/```[a-z]*\n?([\s\S]{40,3000}?)```|[“"]([^“”"]{60,3000})[”"]/g)) {
    out.push({ body: (m[1] ?? m[2])!, marked: true });
  }

  // 3. Paragraphs (OCR blocks are separated by blank lines too).
  if (kind !== "transcript") {
    for (const p of t.split(/\n\s*\n/)) out.push({ body: p, marked: false });
  }
  return out;
}

function clean(s: string): string {
  return s
    .replace(PLACEHOLDER, (_m, a?: string, b?: string, c?: string) => `[${toVar((a ?? b ?? c)!)}]`)
    .replace(/(^|\s)#[\p{L}\p{N}_]+/gu, " ") // hashtags
    .replace(/(^|\s)@[\w.]+/g, " ") // mentions
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "") // emoji
    .replace(/^[\s:\-–—*>•"“”']+|[\s\-–—*"“”']+$/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function toVar(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").toUpperCase() || "INPUT";
}

function score(body: string, marked: boolean): number {
  const words = body.split(/\s+/).filter(Boolean);
  if (body.length < 40 || words.length < 8) return 0;
  let s = marked ? 0.35 : 0;
  if (IMPERATIVE.test(body)) s += 0.3;
  const hints = new Set((body.match(TOOL_HINTS) ?? []).map((h) => h.toLowerCase())).size;
  s += Math.min(0.3, hints * 0.1);
  if (/\[[A-Z0-9_]+\]/.test(body)) s += 0.15;
  if (body.length >= 80 && body.length <= 2500) s += 0.1;
  if (/\b(you|your|the (image|photo|video|subject))\b/i.test(body)) s += 0.05;
  if (SPAM.test(body)) s -= 0.3;
  if (/\?\s*$/.test(body) && words.length < 25) s -= 0.2; // a question to the audience, not a prompt
  return Math.max(0, Math.min(1, s));
}

export function detectTool(...texts: string[]): string {
  const all = texts.join("\n");
  for (const [re, tool] of TOOLS) if (re.test(all)) return tool;
  return "Any AI";
}

export function detectCategory(text: string): string {
  let best = "AI Photo";
  let bestN = 0;
  for (const [cat, re] of CATEGORIES) {
    const n = (text.match(re) ?? []).length;
    if (n > bestN) { best = cat; bestN = n; }
  }
  return best;
}

function titleFor(prompt: string, context: string): string {
  const firstLine = context.split("\n").map((l) => clean(l)).find((l) => l.length >= 12 && l.length <= 70 && !/^(prompt|copy|paste)/i.test(l));
  const base = firstLine ?? prompt.split(/[.,\n]/)[0]!;
  const words = base.split(/\s+/).slice(0, 9).join(" ");
  const t = words.length > 70 ? words.slice(0, 67) + "…" : words;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Word-trigram Jaccard similarity, 0–1. Used for dedupe within a post and against the catalog. */
export function similarity(a: string, b: string): number {
  const grams = (s: string) => {
    const w = s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
    const g = new Set<string>();
    if (w.length < 3) { g.add(w.join(" ")); return g; }
    for (let i = 0; i + 2 < w.length; i++) g.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
    return g;
  };
  const A = grams(a);
  const B = grams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export function extractCandidates(src: ExtractSources): ExtractResult {
  const sources: [SourceKind, string][] = [];
  if (src.text?.trim()) sources.push(["text", src.text]);
  if (src.ocrText?.trim()) sources.push(["ocr", src.ocrText]);
  if (src.transcript?.trim()) sources.push(["transcript", src.transcript]);
  const allText = sources.map(([, t]) => t).join("\n\n");
  const caption = src.text ?? "";

  const found: Candidate[] = [];
  for (const [kind, text] of sources) {
    for (const { body, marked } of blocksOf(text, kind)) {
      const cleaned = clean(body).slice(0, 4000);
      const prompt = cleaned.charAt(0).toUpperCase() + cleaned.slice(1); // transcripts start lowercase
      // OCR / speech are noisier than typed captions — require a little more.
      const conf = score(prompt, marked) - (kind === "text" ? 0 : 0.05);
      if (conf < MIN_CONFIDENCE) continue;
      const variables = [...new Set([...prompt.matchAll(/\[([A-Z0-9_]+)\]/g)].map((m) => m[1]!))];
      found.push({
        title: titleFor(prompt, caption || prompt),
        masterPrompt: prompt,
        category: detectCategory(`${prompt}\n${caption}`),
        tool: detectTool(prompt, allText),
        variables,
        source: kind,
        confidence: Math.round(conf * 100) / 100,
      });
    }
  }

  // Dedupe: the same prompt often appears in caption + OCR + a marker block. Keep the
  // most confident, then the longest.
  found.sort((a, b) => b.confidence - a.confidence || b.masterPrompt.length - a.masterPrompt.length);
  const kept: Candidate[] = [];
  for (const c of found) {
    const dup = kept.some((k) => similarity(k.masterPrompt, c.masterPrompt) >= 0.5 || k.masterPrompt.includes(c.masterPrompt) || c.masterPrompt.includes(k.masterPrompt));
    if (!dup) kept.push(c);
    if (kept.length >= MAX_CANDIDATES) break;
  }

  return { candidates: kept, dmGated: isDmGated(allText) };
}
