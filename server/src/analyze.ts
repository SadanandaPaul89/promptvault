// Post analyzer: cache-first. Every post is keyed by its canonical URL. The first
// request for a post runs extraction (OCR text comes from the extension, STT runs
// here) and, if new prompts are found, waits for moderation. Every later request
// for the same post — from anyone — is answered from the cache instantly.

import type { DatabaseSync } from "node:sqlite";
import { transaction, type AnalysisRow, type PromptRow } from "./db.ts";
import { HttpError } from "./api.ts";
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

export function createAnalyzer(db: DatabaseSync, opts: { transcriber?: Transcriber } = {}) {
  const stmts = {
    byKey: db.prepare("SELECT * FROM analyses WHERE canonical_key = ?"),
    byId: db.prepare("SELECT * FROM analyses WHERE id = ?"),
    insert: db.prepare(
      `INSERT INTO analyses (canonical_key, platform, source_url, creator, status, post_text, ocr_text, transcript,
                             candidates, prompt_ids, request_count, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)
       ON CONFLICT(canonical_key) DO NOTHING RETURNING id`,
    ),
    addRequest: db.prepare("INSERT OR IGNORE INTO analysis_requests (visitor_id, analysis_id, created_at) VALUES (?, ?, ?)"),
    bumpRequests: db.prepare("UPDATE analyses SET request_count = request_count + 1 WHERE id = ?"),
    setStatus: db.prepare("UPDATE analyses SET status = ?, prompt_ids = ?, updated_at = ? WHERE id = ?"),
    listByStatus: db.prepare("SELECT * FROM analyses WHERE status = ? ORDER BY id LIMIT ?"),
    allPromptTexts: db.prepare("SELECT id, master_prompt FROM prompts"),
    promptById: db.prepare("SELECT * FROM prompts WHERE id = ?"),
    bumpViral: db.prepare("UPDATE prompts SET viral_score = MIN(100, viral_score + 1) WHERE id = ?"),
    insertPrompt: db.prepare(
      `INSERT INTO prompts (seed_key, title, master_prompt, collection, category, section, tool, use_cases, variables,
                            viral_score, copy_count, worked_votes, total_votes, created_at)
       VALUES (NULL,?,?,?,?,?,?,?,?,?,0,0,0,?) RETURNING id`,
    ),
  };

  function toDTO(r: AnalysisRow, cached: boolean): AnalysisDTO {
    const status = r.status as AnalysisStatus;
    const prompts: AnalyzedPrompt[] = [];
    if (status === "approved") {
      for (const id of JSON.parse(r.prompt_ids) as number[]) {
        const p = stmts.promptById.get(id) as PromptRow | undefined;
        if (p) prompts.push({ id: p.id, title: p.title, masterPrompt: p.master_prompt, category: p.category, tool: p.tool, variables: JSON.parse(p.variables) });
      }
    }
    return {
      found: true, cached, id: r.id, key: r.canonical_key, platform: r.platform as AnalysisDTO["platform"],
      sourceUrl: r.source_url, creator: r.creator, status, message: MESSAGES[status], prompts,
      requestCount: r.request_count, createdAt: new Date(r.created_at).toISOString(),
    };
  }

  function recordRequest(visitor: string, id: number) {
    const r = stmts.addRequest.run(visitor, id, Date.now());
    if (Number(r.changes) > 0) stmts.bumpRequests.run(id);
  }

  function requireCanonical(url: string) {
    const c = canonicalize(url);
    if (!c) throw new HttpError(400, "Open a single Instagram post/reel or LinkedIn post, then try again.");
    return c;
  }

  function matchCatalog(cands: Candidate[]): StoredCandidate[] {
    const catalog = stmts.allPromptTexts.all() as { id: number; master_prompt: string }[];
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
    lookup(visitor: string, url: string): AnalysisLookup {
      const c = requireCanonical(url);
      const row = stmts.byKey.get(c.key) as AnalysisRow | undefined;
      if (!row) return { found: false, key: c.key };
      recordRequest(visitor, row.id);
      return toDTO(stmts.byId.get(row.id) as AnalysisRow, true);
    },

    async analyze(visitor: string, input: AnalyzeInput): Promise<AnalysisDTO> {
      const c = requireCanonical(input.url);
      const existing = stmts.byKey.get(c.key) as AnalysisRow | undefined;
      if (existing) {
        recordRequest(visitor, existing.id);
        return toDTO(stmts.byId.get(existing.id) as AnalysisRow, true);
      }

      let transcript = "";
      if (input.audio && input.audio.length > 0 && opts.transcriber) {
        try {
          transcript = await opts.transcriber(input.audio);
        } catch (e) {
          console.error("transcription failed:", e);
        }
      }

      const { candidates, dmGated } = extractCandidates({ text: input.text, ocrText: input.ocrText, transcript });
      const stored = matchCatalog(candidates);
      const matchedIds = [...new Set(stored.flatMap((s) => (s.matchPromptId === null ? [] : [s.matchPromptId])))];

      let status: AnalysisStatus;
      if (stored.length === 0) status = dmGated ? "dm_gated" : "no_prompt";
      // Everything found is already a vetted vault prompt → no moderation needed.
      else if (stored.every((s) => s.matchPromptId !== null)) status = "approved";
      else status = "pending";

      const now = Date.now();
      const id = transaction(db, () => {
        const r = stmts.insert.get(
          c.key, c.platform, c.url, (input.creator ?? "").slice(0, 100), status,
          input.text ?? "", input.ocrText ?? "", transcript,
          JSON.stringify(stored), JSON.stringify(status === "approved" ? matchedIds : []), now, now,
        ) as { id: number } | undefined;
        if (!r) return null; // a concurrent request for the same post won the race
        // Each new post that repeats a vault prompt is a "sighting" — a viral signal.
        for (const pid of matchedIds) stmts.bumpViral.run(pid);
        return r.id;
      });

      if (id === null) {
        const winner = stmts.byKey.get(c.key) as AnalysisRow;
        recordRequest(visitor, winner.id);
        return toDTO(stmts.byId.get(winner.id) as AnalysisRow, true);
      }
      stmts.addRequest.run(visitor, id, now);
      return toDTO(stmts.byId.get(id) as AnalysisRow, false);
    },

    // --- moderation -------------------------------------------------------------

    list(status: AnalysisStatus, limit: number) {
      return (stmts.listByStatus.all(status, limit) as AnalysisRow[]).map((r) => ({
        ...toDTO(r, true),
        postText: r.post_text,
        ocrText: r.ocr_text,
        transcript: r.transcript,
        candidates: JSON.parse(r.candidates) as StoredCandidate[],
      }));
    },

    /** Approve: new candidates (optionally only the `keep` indexes) become vault prompts. */
    approve(id: number, keep?: number[]): AnalysisDTO {
      const row = stmts.byId.get(id) as AnalysisRow | undefined;
      if (!row) throw new HttpError(404, "Analysis not found");
      if (row.status !== "pending") throw new HttpError(409, `Analysis is ${row.status}, not pending`);
      const cands = JSON.parse(row.candidates) as StoredCandidate[];
      const chosen = keep ? cands.filter((_, i) => keep.includes(i)) : cands;
      if (chosen.length === 0) throw new HttpError(400, "Nothing to approve — reject it instead");
      const now = Date.now();
      transaction(db, () => {
        const ids: number[] = [];
        for (const cand of chosen) {
          if (cand.matchPromptId !== null) { ids.push(cand.matchPromptId); continue; }
          const useCases = [row.platform, cand.category.toLowerCase(), ...(row.creator ? [`by ${row.creator}`] : [])];
          const r = stmts.insertPrompt.get(
            cand.title, cand.masterPrompt, ANALYZED_COLLECTION, cand.category, cand.category, cand.tool,
            JSON.stringify(useCases), JSON.stringify(cand.variables), Math.min(100, 50 + row.request_count * 2), now,
          ) as { id: number };
          ids.push(r.id);
        }
        stmts.setStatus.run("approved", JSON.stringify([...new Set(ids)]), now, id);
      });
      return toDTO(stmts.byId.get(id) as AnalysisRow, true);
    },

    reject(id: number): AnalysisDTO {
      const row = stmts.byId.get(id) as AnalysisRow | undefined;
      if (!row) throw new HttpError(404, "Analysis not found");
      stmts.setStatus.run("rejected", "[]", Date.now(), id);
      return toDTO(stmts.byId.get(id) as AnalysisRow, true);
    },
  };
}

export type Analyzer = ReturnType<typeof createAnalyzer>;
