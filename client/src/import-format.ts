// Bulk prompt import: file parsing, the field reference shown in the Admin
// panel, and the downloadable templates. The full guide is
// docs/IMPORTING-PROMPTS.md; validation itself happens on the server.

export type FieldDoc = { name: string; required: "yes" | "no" | "yes*"; aliases: string; description: string; example: string };

export const FIELDS: FieldDoc[] = [
  { name: "title", required: "yes", aliases: "name", description: "Short name shown in the list. Up to 120 characters.", example: "LinkedIn hook writer" },
  {
    name: "masterPrompt", required: "yes", aliases: "prompt, master_prompt, text",
    description: "The prompt itself, 10–8,000 characters. Put anything the user should fill in inside [square brackets]; each becomes a fill-in field. Line breaks are kept.",
    example: "Write 5 LinkedIn hooks about [TOPIC] for [AUDIENCE].",
  },
  { name: "category", required: "yes*", aliases: "", description: "Filter group inside the collection, e.g. Sales, AI Photo. Up to 60 characters.", example: "Writing" },
  { name: "collection", required: "yes*", aliases: "", description: "Top-level library. Use an existing name to add to it, or a new name to create one. Up to 60 characters.", example: "Creator Toolkit" },
  { name: "tool", required: "no", aliases: "model, ai", description: "Which AI it's written for. Defaults to “Any AI”.", example: "ChatGPT" },
  { name: "useCases", required: "no", aliases: "tags, keywords", description: "Search keywords. A list in JSON, or separated by | in CSV. The category is added automatically.", example: "linkedin | hooks | personal brand" },
  { name: "section", required: "no", aliases: "subcategory", description: "Finer grouping under the category. Defaults to the category.", example: "Hooks" },
  { name: "viralScore", required: "no", aliases: "score", description: "0–100 starting rank signal. Leave empty (0) unless the prompt is proven popular.", example: "40" },
];

export const CSV_TEMPLATE = [
  "title,masterPrompt,category,collection,tool,useCases",
  `LinkedIn hook writer,"Write 5 scroll-stopping LinkedIn hooks about [TOPIC] for [AUDIENCE]. Each under 12 words.",Writing,Creator Toolkit,ChatGPT,linkedin | hooks | personal brand`,
  `Cold email opener,"Write a cold email to [PROSPECT_ROLE] at [COMPANY] about [OFFER].
Keep it under 90 words and end with one clear question.",Sales,Creator Toolkit,Claude,cold email | outreach`,
  "",
].join("\r\n");

export const JSON_TEMPLATE = JSON.stringify([
  {
    title: "LinkedIn hook writer",
    masterPrompt: "Write 5 scroll-stopping LinkedIn hooks about [TOPIC] for [AUDIENCE]. Each under 12 words.",
    category: "Writing",
    collection: "Creator Toolkit",
    tool: "ChatGPT",
    useCases: ["linkedin", "hooks", "personal brand"],
  },
  {
    title: "Cold email opener",
    masterPrompt: "Write a cold email to [PROSPECT_ROLE] at [COMPANY] about [OFFER].\nKeep it under 90 words and end with one clear question.",
    category: "Sales",
    collection: "Creator Toolkit",
    tool: "Claude",
    useCases: ["cold email", "outreach"],
  },
], null, 2);

/** RFC 4180 CSV: quoted fields may contain commas, line breaks and "" escaped quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, ""); // Excel's BOM
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else field += ch;
  }
  if (quoted) throw new Error("A quoted field is never closed: check for a missing \" in the file.");
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export type Parsed = { rows: Record<string, unknown>[]; format: "csv" | "json"; columns: string[] };

/** Accepts a JSON array (or { "prompts": [...] }) or CSV with a header row. */
export function parseImport(text: string, fileName = ""): Parsed {
  const t = text.trim();
  if (!t) throw new Error("The file is empty.");
  const looksJson = /\.json$/i.test(fileName) || t.startsWith("[") || t.startsWith("{");
  if (looksJson) {
    let data: unknown;
    try {
      data = JSON.parse(t);
    } catch (e) {
      throw new Error(`Not valid JSON: ${(e as Error).message}`);
    }
    const arr = Array.isArray(data) ? data : (data as { prompts?: unknown })?.prompts;
    if (!Array.isArray(arr)) throw new Error('JSON must be an array of prompts, or an object with a "prompts" array.');
    const columns = [...new Set(arr.flatMap((r) => (r && typeof r === "object" ? Object.keys(r) : [])))];
    return { rows: arr as Record<string, unknown>[], format: "json", columns };
  }
  const table = parseCsv(t);
  if (table.length < 2) throw new Error("CSV needs a header row and at least one prompt row.");
  const header = table[0]!.map((h) => h.trim());
  if (header.some((h) => !h)) throw new Error("Every column in the header row needs a name.");
  const rows = table.slice(1).map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""])));
  return { rows, format: "csv", columns: header };
}

export function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Same rule as the server and the prompt detail view. */
export function detectVariables(prompt: string): string[] {
  const out: string[] = [];
  for (const m of prompt.matchAll(/\[([^\]\n]{1,60})\]/g)) {
    const v = m[1]!.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}
