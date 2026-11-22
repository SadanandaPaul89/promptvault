import type { DatabaseSync } from "node:sqlite";
import { transaction, type PromptRow } from "./db.ts";
import { buildIdf, isRelevant, scorePrompt, tokenize, type Idf, type RankablePrompt } from "./ranking.ts";

function toRankable(r: PromptRow): RankablePrompt {
  return {
    title: r.title, masterPrompt: r.master_prompt, category: r.category, section: r.section, tool: r.tool,
    useCases: JSON.parse(r.use_cases) as string[], viralScore: r.viral_score, workedVotes: r.worked_votes,
    totalVotes: r.total_votes, createdAt: r.created_at,
  };
}
import {
  ALL, type AdminSubmissionDTO, type AdminSubmissionsResponse, type CollectionInfo, type PromptDTO, type SubmissionDTO,
  type SubmissionStatus, type VaultResponse,
} from "./types.ts";

type SubmissionRow = { id: number; url: string; note: string; category: string; status: string; created_at: number; email?: string | null };
const toSubmissionDTO = (r: SubmissionRow): SubmissionDTO => ({
  id: r.id, url: r.url, note: r.note, category: r.category, status: r.status, createdAt: new Date(r.created_at).toISOString(),
});

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type VaultQuery = {
  q: string;
  collection: string;
  category: string;
  savedOnly: boolean;
  offset: number;
  limit: number;
};

export function createService(db: DatabaseSync) {
  const stmts = {
    allPrompts: db.prepare("SELECT * FROM prompts"),
    promptById: db.prepare("SELECT * FROM prompts WHERE id = ?"),
    savesFor: db.prepare("SELECT prompt_id FROM saves WHERE visitor_id = ?"),
    votesFor: db.prepare("SELECT prompt_id, worked FROM votes WHERE visitor_id = ?"),
    submissionCount: db.prepare("SELECT COUNT(*) AS n FROM submissions"),
    incCopy: db.prepare("UPDATE prompts SET copy_count = copy_count + 1 WHERE id = ? RETURNING copy_count"),
    getSave: db.prepare("SELECT 1 FROM saves WHERE visitor_id = ? AND prompt_id = ?"),
    addSave: db.prepare("INSERT INTO saves (visitor_id, prompt_id, created_at) VALUES (?, ?, ?)"),
    delSave: db.prepare("DELETE FROM saves WHERE visitor_id = ? AND prompt_id = ?"),
    getVote: db.prepare("SELECT worked FROM votes WHERE visitor_id = ? AND prompt_id = ?"),
    upsertVote: db.prepare(
      `INSERT INTO votes (visitor_id, prompt_id, worked, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(visitor_id, prompt_id) DO UPDATE SET worked = excluded.worked`,
    ),
    bumpVotes: db.prepare("UPDATE prompts SET total_votes = total_votes + ?, worked_votes = worked_votes + ? WHERE id = ?"),
    addSubmission: db.prepare(
      "INSERT INTO submissions (visitor_id, url, note, category, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?) RETURNING id",
    ),
    mySubmissions: db.prepare("SELECT * FROM submissions WHERE visitor_id = ? ORDER BY id DESC LIMIT ?"),
    adminSubmissions: db.prepare(
      `SELECT s.*, u.email FROM submissions s LEFT JOIN users u ON s.visitor_id = 'u:' || u.id
       WHERE (? = 'all' OR s.status = ?) ORDER BY s.id DESC LIMIT ? OFFSET ?`,
    ),
    submissionCounts: db.prepare("SELECT status, COUNT(*) AS n FROM submissions GROUP BY status"),
    setSubmissionStatus: db.prepare("UPDATE submissions SET status = ? WHERE id = ?"),
    submissionById: db.prepare("SELECT s.*, u.email FROM submissions s LEFT JOIN users u ON s.visitor_id = 'u:' || u.id WHERE s.id = ?"),
  };

  let idfCache: { size: number; idf: Idf } | undefined;

  function requirePrompt(id: number): PromptRow {
    const row = stmts.promptById.get(id) as PromptRow | undefined;
    if (!row) throw new HttpError(404, "Prompt not found");
    return row;
  }

  function collectionsOf(rows: PromptRow[]): CollectionInfo[] {
    const map = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const cats = map.get(r.collection) ?? new Map<string, number>();
      cats.set(r.category, (cats.get(r.category) ?? 0) + 1);
      map.set(r.collection, cats);
    }
    return [...map.entries()].map(([name, cats]) => ({
      name,
      count: [...cats.values()].reduce((a, b) => a + b, 0),
      categories: [...cats.entries()].map(([n, count]) => ({ name: n, count })),
    }));
  }

  return {
    vault(visitor: string, q: VaultQuery): VaultResponse {
      const rows = stmts.allPrompts.all() as PromptRow[];
      const saved = new Set((stmts.savesFor.all(visitor) as { prompt_id: number }[]).map((r) => r.prompt_id));
      const votes = new Map((stmts.votesFor.all(visitor) as { prompt_id: number; worked: number }[]).map((r) => [r.prompt_id, r.worked]));
      const query = q.q.trim();
      const now = Date.now();
      if (!idfCache || idfCache.size !== rows.length) idfCache = { size: rows.length, idf: buildIdf(rows.map(toRankable)) };
      const idf = idfCache.idf;

      const toDTO = (r: PromptRow): PromptDTO => {
        const vote = votes.get(r.id);
        return {
          id: r.id, title: r.title, masterPrompt: r.master_prompt, collection: r.collection, category: r.category,
          section: r.section, tool: r.tool, useCases: JSON.parse(r.use_cases), variables: JSON.parse(r.variables),
          viralScore: r.viral_score, copyCount: r.copy_count, workedVotes: r.worked_votes, totalVotes: r.total_votes,
          successRate: r.total_votes > 0 ? Math.round((r.worked_votes / r.total_votes) * 100) : 75,
          saved: saved.has(r.id), myVote: vote === undefined ? null : vote ? "worked" : "failed",
          createdAt: new Date(r.created_at).toISOString(),
          score: scorePrompt(toRankable(r), query, now, idf),
        };
      };

      let list = rows
        .filter((r) => q.collection === ALL || r.collection === q.collection)
        .filter((r) => q.category === ALL || r.category === q.category)
        .filter((r) => !q.savedOnly || saved.has(r.id))
        .map(toDTO)
        .filter((p) => isRelevant(p.score, tokenize(query).length > 0));
      list.sort((a, b) => b.score.final - a.score.final || b.viralScore - a.viralScore || a.id - b.id);

      const trending = query || q.offset > 0
        ? []
        : rows
            .filter((r) => r.viral_score > 0 && (q.collection === ALL || r.collection === q.collection))
            .sort((a, b) => b.viral_score - a.viral_score)
            .slice(0, 3)
            .map(toDTO);

      const matched = list.length;
      list = list.slice(q.offset, q.offset + q.limit);
      return {
        prompts: list, matched, offset: q.offset, limit: q.limit, trending,
        stats: {
          total: rows.length,
          savedCount: saved.size,
          totalCopies: rows.reduce((a, r) => a + r.copy_count, 0),
          submissions: Number((stmts.submissionCount.get() as { n: number }).n),
        },
        collections: collectionsOf(rows),
      };
    },

    recordCopy(id: number): { copyCount: number } {
      requirePrompt(id);
      const r = stmts.incCopy.get(id) as { copy_count: number };
      return { copyCount: r.copy_count };
    },

    toggleSave(visitor: string, id: number): { saved: boolean } {
      requirePrompt(id);
      if (stmts.getSave.get(visitor, id)) {
        stmts.delSave.run(visitor, id);
        return { saved: false };
      }
      stmts.addSave.run(visitor, id, Date.now());
      return { saved: true };
    },

    /** One vote per visitor per prompt; changing your vote moves it rather than adding another. */
    vote(visitor: string, id: number, worked: boolean): { successRate: number; myVote: "worked" | "failed" } {
      requirePrompt(id);
      transaction(db, () => {
        const prev = stmts.getVote.get(visitor, id) as { worked: number } | undefined;
        const w = worked ? 1 : 0;
        if (!prev) stmts.bumpVotes.run(1, w, id);
        else if (prev.worked !== w) stmts.bumpVotes.run(0, w ? 1 : -1, id);
        stmts.upsertVote.run(visitor, id, w, Date.now());
      });
      const row = requirePrompt(id);
      return {
        successRate: row.total_votes > 0 ? Math.round((row.worked_votes / row.total_votes) * 100) : 75,
        myVote: worked ? "worked" : "failed",
      };
    },

    submit(visitor: string, url: string, note: string, category: string): { id: number } {
      const r = stmts.addSubmission.get(visitor, url, note, category, Date.now()) as { id: number };
      return { id: r.id };
    },

    mySubmissions(owner: string, limit: number): { submissions: SubmissionDTO[] } {
      return { submissions: (stmts.mySubmissions.all(owner, limit) as SubmissionRow[]).map(toSubmissionDTO) };
    },

    // --- admin ---------------------------------------------------------------
    adminSubmissions(status: SubmissionStatus | "all", limit: number, offset: number): AdminSubmissionsResponse {
      const rows = stmts.adminSubmissions.all(status, status, limit, offset) as SubmissionRow[];
      const counts: Record<SubmissionStatus, number> = { pending: 0, added: 0, rejected: 0 };
      for (const r of stmts.submissionCounts.all() as { status: string; n: number }[]) {
        if (r.status in counts) counts[r.status as SubmissionStatus] = Number(r.n);
      }
      return { submissions: rows.map((r) => ({ ...toSubmissionDTO(r), submittedBy: r.email ?? null })), counts };
    },

    setSubmissionStatus(id: number, status: SubmissionStatus): AdminSubmissionDTO {
      if (Number(stmts.setSubmissionStatus.run(status, id).changes) === 0) throw new HttpError(404, "Submission not found");
      const r = stmts.submissionById.get(id) as SubmissionRow;
      return { ...toSubmissionDTO(r), submittedBy: r.email ?? null };
    },

    categories(): Set<string> {
      return new Set((db.prepare("SELECT DISTINCT category FROM prompts").all() as { category: string }[]).map((r) => r.category));
    },
  };
}

export type Service = ReturnType<typeof createService>;
