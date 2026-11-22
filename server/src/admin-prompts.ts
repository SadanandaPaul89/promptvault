// Admin prompt management: add one prompt or import many at once.
// Import format is documented in docs/IMPORTING-PROMPTS.md (keep the two in sync).
//
// Every import can run as a dry run first: each row comes back as "new",
// "duplicate" or "invalid" with reasons, and nothing is written. A real run
// inserts only the "new" rows, so re-importing the same file is harmless.

import { createHash } from "node:crypto";
import type { Db, Stmt } from "./db.ts";
import { HttpError, PROMPTS_CACHE, allPrompts, toSubmissionDTOs, type SubmissionRow } from "./api.ts";
import type { AdminPromptDTO, AdminSubmissionDTO, ImportDefaults, ImportResult, ImportRowResult } from "./types.ts";

export const MAX_IMPORT_ROWS = 1000;
export const DEFAULT_TOOL = "Any AI";

const LIMITS = { title: 120, masterPrompt: 8000, category: 60, collection: 60, section: 80, tool: 40, useCase: 60, useCases: 20 };

/** Accepted column / key names (lowercased, spaces/underscores/dashes removed) → field. */
const ALIASES: Record<string, keyof ImportFields> = {
  title: "title", name: "title",
  masterprompt: "masterPrompt", prompt: "masterPrompt", prompttext: "masterPrompt", text: "masterPrompt",
  category: "category",
  collection: "collection",
  section: "section", subcategory: "section",
  tool: "tool", model: "tool", ai: "tool",
  usecases: "useCases", tags: "useCases", keywords: "useCases",
  viralscore: "viralScore", score: "viralScore",
};

type ImportFields = {
  title: string;
  masterPrompt: string;
  category: string;
  collection: string;
  section: string;
  tool: string;
  useCases: string[];
  viralScore: number;
};

/** Same rule the UI uses to turn "[product name]" into the variable PRODUCT_NAME. */
const normVar = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
export function detectVariables(prompt: string): string[] {
  const out: string[] = [];
  for (const m of prompt.matchAll(/\[([^\]\n]{1,60})\]/g)) {
    const v = normVar(m[1]!);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Content key shared with the seed loader, so a prompt can't be added twice to a collection. */
export function promptKey(collection: string, title: string, masterPrompt: string): string {
  return createHash("sha1").update(`${collection}\n${title}\n${masterPrompt}`).digest("hex");
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const sameText = (s: string) => squash(s).toLowerCase();

function toText(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function toList(v: unknown): string[] {
  const parts = Array.isArray(v) ? v.map(toText) : toText(v).split(/[|;\n]/);
  const out: string[] = [];
  for (const p of parts) {
    const t = squash(p).toLowerCase();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Maps any accepted key spelling to a field; returns the unknown keys as warnings. */
function readRow(raw: unknown): { fields: Partial<Record<keyof ImportFields, unknown>>; unknown: string[] } {
  const fields: Partial<Record<keyof ImportFields, unknown>> = {};
  const unknown: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { fields, unknown };
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const f = ALIASES[k.toLowerCase().replace(/[\s_-]+/g, "")];
    if (!f) { if (toText(v).trim()) unknown.push(k); continue; }
    if (fields[f] === undefined || toText(fields[f]).trim() === "") fields[f] = v;
  }
  return { fields, unknown };
}

function validate(raw: unknown, defaults: ImportDefaults) {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) errors.push("Row must be an object with named fields.");
  const { fields, unknown } = readRow(raw);
  if (unknown.length) warnings.push(`Ignored unknown column${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);

  const title = squash(toText(fields.title));
  // Keep the prompt's own line breaks; just trim the ends.
  const masterPrompt = toText(fields.masterPrompt).replace(/\r\n?/g, "\n").trim();
  const category = squash(toText(fields.category)) || squash(defaults.category ?? "");
  const collection = squash(toText(fields.collection)) || squash(defaults.collection ?? "");
  const section = squash(toText(fields.section)) || category;
  const tool = squash(toText(fields.tool)) || squash(defaults.tool ?? "") || DEFAULT_TOOL;
  let useCases = toList(fields.useCases);

  if (!title) errors.push("title is required.");
  else if (title.length > LIMITS.title) errors.push(`title is longer than ${LIMITS.title} characters.`);
  if (!masterPrompt) errors.push("masterPrompt is required.");
  else if (masterPrompt.length < 10) errors.push("masterPrompt is too short (10+ characters).");
  else if (masterPrompt.length > LIMITS.masterPrompt) errors.push(`masterPrompt is longer than ${LIMITS.masterPrompt} characters.`);
  if (!category) errors.push("category is required (or pick a default category).");
  else if (category.length > LIMITS.category) errors.push(`category is longer than ${LIMITS.category} characters.`);
  if (!collection) errors.push("collection is required (or pick a default collection).");
  else if (collection.length > LIMITS.collection) errors.push(`collection is longer than ${LIMITS.collection} characters.`);
  if (section.length > LIMITS.section) errors.push(`section is longer than ${LIMITS.section} characters.`);
  if (tool.length > LIMITS.tool) errors.push(`tool is longer than ${LIMITS.tool} characters.`);
  if (useCases.some((u) => u.length > LIMITS.useCase)) errors.push(`each useCase must be ${LIMITS.useCase} characters or fewer.`);
  if (useCases.length > LIMITS.useCases) { warnings.push(`Only the first ${LIMITS.useCases} useCases are kept.`); useCases = useCases.slice(0, LIMITS.useCases); }

  let viralScore = 0;
  const vsRaw = toText(fields.viralScore).trim();
  if (vsRaw) {
    const n = Number(vsRaw);
    if (!Number.isFinite(n) || n < 0 || n > 100) errors.push("viralScore must be a number from 0 to 100.");
    else viralScore = Math.round(n);
  }

  const variables = detectVariables(masterPrompt);
  if (masterPrompt && variables.length === 0) warnings.push("No [VARIABLES] found: users can copy it but have nothing to fill in.");
  if (/\{\{[^}]+\}\}/.test(masterPrompt)) warnings.push("Found {{curly}} placeholders: only [square brackets] become fill-in fields.");
  // The category itself is a useful search keyword (as in the built-in prompts).
  const cat = category.toLowerCase();
  if (cat && !useCases.includes(cat)) useCases.push(cat);

  const value: ImportFields = { title, masterPrompt, category, collection, section, tool, useCases, viralScore };
  return { value, variables, errors, warnings };
}

export function createPromptAdmin(db: Db) {
  const admin = {
    /**
     * Approves a submitted link by adding the prompt(s) found in that post.
     * Prompts already in the vault are linked instead of added again. Nothing is
     * written if any prompt is invalid. The submitter then sees the prompts.
     */
    async approveSubmission(id: number, rows: unknown, defaults: ImportDefaults, addedBy: string): Promise<{ submission: AdminSubmissionDTO; result: ImportResult }> {
      const sub = await db.get<{ status: string }>("SELECT status FROM submissions WHERE id = ?", id);
      if (!sub) throw new HttpError(404, "Submission not found");
      if (sub.status !== "pending") throw new HttpError(409, `This link is already ${sub.status === "added" ? "approved" : "declined"}. Undo that first.`);

      const check = await admin.importPrompts(rows, defaults, true, addedBy);
      const bad = check.rows.filter((r) => r.status === "invalid");
      if (bad.length) throw new HttpError(400, bad.map((r) => `Prompt ${r.row}: ${r.errors.join(" ")}`).join(" "));

      const result = await admin.importPrompts(rows, defaults, false, addedBy);
      const ids = [...new Set(result.rows.flatMap((r) => r.id ?? r.existingId ?? []))];
      if (ids.length === 0) throw new HttpError(400, "Add at least one prompt from this post, or decline it.");

      const res = await db.batch<SubmissionRow>([
        { sql: "UPDATE submissions SET status = 'added', prompt_ids = ? WHERE id = ? AND status = 'pending'", args: [JSON.stringify(ids), id] },
        { sql: "SELECT s.*, u.email FROM submissions s LEFT JOIN users u ON s.visitor_id = 'u:' || u.id WHERE s.id = ?", args: [id] },
      ]);
      return { submission: (await toSubmissionDTOs(db, res[1]!))[0]!, result };
    },

    /** Validates every row; unless dryRun, inserts the rows that are new. */
    async importPrompts(rows: unknown, defaults: ImportDefaults, dryRun: boolean, addedBy: string): Promise<ImportResult> {
      if (!Array.isArray(rows)) throw new HttpError(400, "`prompts` must be an array of prompt objects.");
      if (rows.length === 0) throw new HttpError(400, "There are no prompts to import.");
      if (rows.length > MAX_IMPORT_ROWS) throw new HttpError(413, `Import at most ${MAX_IMPORT_ROWS} prompts at a time; split the file.`);

      const existing = await allPrompts(db);
      const existingText = new Map(existing.map((p) => [sameText(p.master_prompt), p]));
      const seenInFile = new Map<string, number>();

      const checked = rows.map((raw, i) => {
        const v = validate(raw, defaults);
        const result: ImportRowResult = {
          row: i + 1, status: "new", errors: v.errors, warnings: v.warnings,
          title: v.value.title, collection: v.value.collection, category: v.value.category, tool: v.value.tool, variables: v.variables,
        };
        if (v.errors.length) { result.status = "invalid"; return { result, v }; }
        const text = sameText(v.value.masterPrompt);
        const dupe = existingText.get(text);
        if (dupe) {
          result.status = "duplicate";
          result.existingId = dupe.id;
          result.errors = [`Already in the vault as #${dupe.id} “${dupe.title}” (${dupe.collection}).`];
        } else if (seenInFile.has(text)) {
          result.status = "duplicate";
          result.errors = [`Same prompt as row ${seenInFile.get(text)} of this import.`];
        } else {
          seenInFile.set(text, result.row);
        }
        return { result, v };
      });

      let imported = 0;
      if (!dryRun) {
        const toInsert = checked.filter((c) => c.result.status === "new");
        const now = Date.now();
        for (let i = 0; i < toInsert.length; i += 200) {
          const chunk = toInsert.slice(i, i + 200);
          const stmts: Stmt[] = chunk.map(({ v }) => ({
            sql: `INSERT OR IGNORE INTO prompts
                    (seed_key, title, master_prompt, collection, category, section, tool, use_cases, variables,
                     viral_score, copy_count, worked_votes, total_votes, created_at, source, added_by)
                  VALUES (?,?,?,?,?,?,?,?,?,?,0,0,0,?,'admin',?) RETURNING id`,
            args: [
              promptKey(v.value.collection, v.value.title, v.value.masterPrompt), v.value.title, v.value.masterPrompt,
              v.value.collection, v.value.category, v.value.section, v.value.tool,
              JSON.stringify(v.value.useCases), JSON.stringify(v.variables), v.value.viralScore, now, addedBy,
            ],
          }));
          const res = await db.batch<{ id: number }>(stmts);
          res.forEach((rows, j) => {
            const r = chunk[j]!.result;
            if (rows[0]) { r.id = rows[0].id; imported++; }
            else { r.status = "duplicate"; r.errors = ["Already in this collection with the same title."]; }
          });
        }
        if (imported > 0) db.invalidate(PROMPTS_CACHE);
      }

      const results = checked.map((c) => c.result);
      const count = (s: ImportRowResult["status"]) => results.filter((r) => r.status === s).length;
      return {
        dryRun,
        rows: results,
        summary: { total: results.length, new: count("new"), duplicate: count("duplicate"), invalid: count("invalid"), imported },
      };
    },

    /** Prompts added by admins (newest first), for the "Recently added" list. */
    async recent(limit: number): Promise<{ prompts: AdminPromptDTO[] }> {
      const rows = await db.all<{ id: number; title: string; collection: string; category: string; tool: string; source: string; created_at: number }>(
        "SELECT id, title, collection, category, tool, source, created_at FROM prompts WHERE source = 'admin' ORDER BY id DESC LIMIT ?",
        limit,
      );
      return {
        prompts: rows.map((r) => ({
          id: r.id, title: r.title, collection: r.collection, category: r.category, tool: r.tool, source: r.source,
          createdAt: new Date(r.created_at).toISOString(),
        })),
      };
    },

    /** Deletes an admin- or extension-added prompt with its saves and votes. Built-in prompts can't be deleted. */
    async remove(id: number): Promise<{ deleted: true }> {
      const row = await db.get<{ source: string }>("SELECT source FROM prompts WHERE id = ?", id);
      if (!row) throw new HttpError(404, "Prompt not found");
      if (row.source === "seed") throw new HttpError(409, "Built-in prompts can't be deleted here.");
      await db.batch([
        { sql: "DELETE FROM saves WHERE prompt_id = ?", args: [id] },
        { sql: "DELETE FROM votes WHERE prompt_id = ?", args: [id] },
        { sql: "DELETE FROM prompts WHERE id = ?", args: [id] },
      ]);
      db.invalidate(PROMPTS_CACHE);
      return { deleted: true };
    },
  };
  return admin;
}

export type PromptAdmin = ReturnType<typeof createPromptAdmin>;
