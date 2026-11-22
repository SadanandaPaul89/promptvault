// Post analyzer: cache-first. Every post is keyed by its canonical URL. The first
// request for a post runs extraction (OCR text comes from the extension, STT runs
// here) and, if new prompts are found, waits for moderation. Every later request
// for the same post — from anyone — is answered from the cache instantly.

import type { AnalysisRow, Db, Queryable } from "./db.ts";
import { HttpError, PROMPTS_CACHE, allPrompts } from "./api.ts";
import { canonicalize } from "./canonical.ts";
import { extractCandidates, similarity, type Candidate } from "./extract.ts";
import type { Transcriber } from "./stt.ts";
import type { AnalysisDTO, AnalysisLookup, AnalysisStatus, AnalyzedPrompt } from "./types.ts";

export const ANALYZED_COLLECTION = "From Reels & Posts";
/** Word-trigram Jaccard at/above which a candidate is "already in the vault". */
const CATALOG_MATCH = 0.45;

export type AnalyzeInput = {
  url: string;
  creator?: string;
  /** Caption / post body. */
  text?: string;
  ocrText?: string;
  audio?: Buffer;
};

type StoredCandidate = Candidate & { matchPromptId: number | null };

const MESSAGES: Record<AnalysisStatus, string> = {
  pending: "Prompts found — they're being reviewed and will appear here once approved.",
  approved: "Here are the prompts from this post.",
  rejected: "We reviewed this post and couldn't find a usable prompt in it.",
  no_prompt: "No prompt was found in this post.",
  dm_gated: "This post hides its prompt behind a comment-for-DM. If you received the DM, paste it into the Vault's submit form.",
};

export function createAnalyzer(db: Db, opts: { transcriber?: Transcriber } = {}) {
  async function toDTO(r: AnalysisRow, cached: boolean): Promise<AnalysisDTO> {
    const status = r.status as AnalysisStatus;
    const prompts: AnalyzedPrompt[] = [];
    if (status === "approved") {
      const byId = new Map((await allPrompts(db)).map((p) => [p.id, p]));
      for (const id of JSON.parse(r.prompt_ids) as number[]) {
        const p = byId.get(id);
        if (p) prompts.push({ id: p.id, title: p.title, masterPrompt: p.master_prompt, category: p.category, tool: p.tool, variables: JSON.parse(p.variables) });
      }
    }
    return {
      found: true, cached, id: r.id, key: r.canonical_key, platform: r.platform as AnalysisDTO["platform"],
      sourceUrl: r.source_url, creator: r.creator, status, message: MESSAGES[status], prompts,
      requestCount: r.request_count, createdAt: new Date(r.created_at).toISOString(),
    };
  }

  /** Counts this visitor once per post, and returns the up-to-date row. One round trip. */
  async function recordRequest(visitor: string, id: number): Promise<AnalysisRow> {
    const res = await db.batch<AnalysisRow>([
      { sql: "INSERT OR IGNORE INTO analysis_requests (visitor_id, analysis_id, created_at) VALUES (?, ?, ?)", args: [visitor, id, Date.now()] },
      { sql: "UPDATE analyses SET request_count = (SELECT COUNT(*) FROM analysis_requests WHERE analysis_id = ?1) WHERE id = ?1", args: [id] },
      { sql: "SELECT * FROM analyses WHERE id = ?", args: [id] },
    ]);
    return res[2]![0]!;
  }

  const byKey = (key: string) => db.get<AnalysisRow>("SELECT * FROM analyses WHERE canonical_key = ?", key);
  const byId = (id: number, q: Queryable = db) => q.get<AnalysisRow>("SELECT * FROM analyses WHERE id = ?", id);

  function requireCanonical(url: string) {
    const c = canonicalize(url);
    if (!c) throw new HttpError(400, "Open a single Instagram post/reel or LinkedIn post, then try again.");
    return c;
  }

  async function matchCatalog(cands: Candidate[]): Promise<StoredCandidate[]> {
    if (cands.length === 0) return [];
    const catalog = await allPrompts(db);
    return cands.map((c) => {
      let best: { id: number; s: number } | null = null;
      for (const p of catalog) {
        const s = similarity(c.masterPrompt, p.master_prompt);
        if (s >= CATALOG_MATCH && (!best || s > best.s)) best = { id: p.id, s };
      }
      return { ...c, matchPromptId: best?.id ?? null };
    });
  }

  return {
    /** Cache lookup only — never runs extraction. */
    async lookup(visitor: string, url: string): Promise<AnalysisLookup> {
      const c = requireCanonical(url);
      const row = await byKey(c.key);
      if (!row) return { found: false, key: c.key };
      return toDTO(await recordRequest(visitor, row.id), true);
    },

    async analyze(visitor: string, input: AnalyzeInput): Promise<AnalysisDTO> {
      const c = requireCanonical(input.url);
      const existing = await byKey(c.key);
      if (existing) return toDTO(await recordRequest(visitor, existing.id), true);

      let transcript = "";
      if (input.audio && input.audio.length > 0 && opts.transcriber) {
        try {
          transcript = await opts.transcriber(input.audio);
        } catch (e) {
          console.error("transcription failed:", e);
        }
      }

      const { candidates, dmGated } = extractCandidates({ text: input.text, ocrText: input.ocrText, transcript });
      const stored = await matchCatalog(candidates);
      const matchedIds = [...new Set(stored.flatMap((s) => (s.matchPromptId === null ? [] : [s.matchPromptId])))];

      let status: AnalysisStatus;
      if (stored.length === 0) status = dmGated ? "dm_gated" : "no_prompt";
      // Everything found is already a vetted vault prompt → no moderation needed.
      else if (stored.every((s) => s.matchPromptId !== null)) status = "approved";
      else status = "pending";

      const now = Date.now();
      const row = await db.transaction(async (tx) => {
        const r = await tx.get<{ id: number }>(
          `INSERT INTO analyses (canonical_key, platform, source_url, creator, status, post_text, ocr_text, transcript,
                                 candidates, prompt_ids, request_count, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)
           ON CONFLICT(canonical_key) DO NOTHING RETURNING id`,
          c.key, c.platform, c.url, (input.creator ?? "").slice(0, 100), status,
          input.text ?? "", input.ocrText ?? "", transcript,
          JSON.stringify(stored), JSON.stringify(status === "approved" ? matchedIds : []), now, now,
        );
        if (!r) return null; // a concurrent request for the same post won the race
        // Each new post that repeats a vault prompt is a "sighting": a viral signal.
        for (const pid of matchedIds) await tx.run("UPDATE prompts SET viral_score = MIN(100, viral_score + 1) WHERE id = ?", pid);
        await tx.run("INSERT OR IGNORE INTO analysis_requests (visitor_id, analysis_id, created_at) VALUES (?, ?, ?)", visitor, r.id, now);
        return byId(r.id, tx);
      });
      if (matchedIds.length > 0) db.invalidate(PROMPTS_CACHE);

      if (!row) {
        const winner = (await byKey(c.key))!;
        return toDTO(await recordRequest(visitor, winner.id), true);
      }
      return toDTO(row, false);
    },

    // --- moderation -------------------------------------------------------------

    async list(status: AnalysisStatus, limit: number) {
      const rows = await db.all<AnalysisRow>("SELECT * FROM analyses WHERE status = ? ORDER BY id LIMIT ?", status, limit);
      return Promise.all(rows.map(async (r) => ({
        ...(await toDTO(r, true)),
        postText: r.post_text,
        ocrText: r.ocr_text,
        transcript: r.transcript,
        candidates: JSON.parse(r.candidates) as StoredCandidate[],
      })));
    },

    /** Approve: new candidates (optionally only the `keep` indexes) become vault prompts. */
    async approve(id: number, keep?: number[]): Promise<AnalysisDTO> {
      const now = Date.now();
      const row = await db.transaction(async (tx) => {
        const row = await byId(id, tx);
        if (!row) throw new HttpError(404, "Analysis not found");
        if (row.status !== "pending") throw new HttpError(409, `Analysis is ${row.status}, not pending`);
        const cands = JSON.parse(row.candidates) as StoredCandidate[];
        const chosen = keep ? cands.filter((_, i) => keep.includes(i)) : cands;
        if (chosen.length === 0) throw new HttpError(400, "Nothing to approve — reject it instead");
        const ids: number[] = [];
        for (const cand of chosen) {
          if (cand.matchPromptId !== null) { ids.push(cand.matchPromptId); continue; }
          const useCases = [row.platform, cand.category.toLowerCase(), ...(row.creator ? [`by ${row.creator}`] : [])];
          const r = await tx.get<{ id: number }>(
            `INSERT INTO prompts (seed_key, title, master_prompt, collection, category, section, tool, use_cases, variables,
                                  viral_score, copy_count, worked_votes, total_votes, created_at)
             VALUES (NULL,?,?,?,?,?,?,?,?,?,0,0,0,?) RETURNING id`,
            cand.title, cand.masterPrompt, ANALYZED_COLLECTION, cand.category, cand.category, cand.tool,
            JSON.stringify(useCases), JSON.stringify(cand.variables), Math.min(100, 50 + row.request_count * 2), now,
          );
          ids.push(r!.id);
        }
        await tx.run("UPDATE analyses SET status = 'approved', prompt_ids = ?, updated_at = ? WHERE id = ?", JSON.stringify([...new Set(ids)]), now, id);
        return (await byId(id, tx))!;
      });
      db.invalidate(PROMPTS_CACHE);
      return toDTO(row, true);
    },

    async reject(id: number): Promise<AnalysisDTO> {
      const res = await db.batch<AnalysisRow>([
        { sql: "UPDATE analyses SET status = 'rejected', prompt_ids = '[]', updated_at = ? WHERE id = ?", args: [Date.now(), id] },
        { sql: "SELECT * FROM analyses WHERE id = ?", args: [id] },
      ]);
      const row = res[1]![0];
      if (!row) throw new HttpError(404, "Analysis not found");
      return toDTO(row, true);
    },
  };
}

export type Analyzer = ReturnType<typeof createAnalyzer>;
