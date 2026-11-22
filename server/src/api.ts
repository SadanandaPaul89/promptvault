import type { Db, PromptRow } from "./db.ts";
import { buildIdf, isRelevant, scorePrompt, tokenize, type Idf, type RankablePrompt } from "./ranking.ts";
import {
  ALL, type AdminSubmissionDTO, type AdminSubmissionsResponse, type CollectionInfo, type PromptDTO, type SubmissionDTO,
  type SubmissionStatus, type VaultResponse,
} from "./types.ts";

function toRankable(r: PromptRow): RankablePrompt {
  return {
    title: r.title, masterPrompt: r.master_prompt, category: r.category, section: r.section, tool: r.tool,
    useCases: JSON.parse(r.use_cases) as string[], viralScore: r.viral_score, workedVotes: r.worked_votes,
    totalVotes: r.total_votes, createdAt: r.created_at,
  };
}

export type SubmissionRow = {
  id: number; url: string; note: string; category: string; status: string; created_at: number; prompt_ids: string; email?: string | null;
};

/** Maps rows to DTOs, resolving linked prompt ids to titles (prompts deleted since are dropped). */
export async function toSubmissionDTOs(db: Db, rows: SubmissionRow[]): Promise<AdminSubmissionDTO[]> {
  const ids = rows.map((r) => JSON.parse(r.prompt_ids || "[]") as number[]);
  const titles = ids.some((l) => l.length > 0) ? new Map((await allPrompts(db)).map((p) => [p.id, p.title])) : new Map<number, string>();
  return rows.map((r, i): AdminSubmissionDTO => ({
    id: r.id, url: r.url, note: r.note, category: r.category, status: r.status, createdAt: new Date(r.created_at).toISOString(),
    prompts: ids[i]!.flatMap((id) => (titles.has(id) ? [{ id, title: titles.get(id)! }] : [])),
    submittedBy: r.email ?? null,
  }));
}

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

/** Cache key for the prompt catalog. Anything that changes a prompt row invalidates it. */
export const PROMPTS_CACHE = "prompts";
const PROMPTS_TTL_MS = 60_000;

const successRate = (worked: number, total: number) => (total > 0 ? Math.round((worked / total) * 100) : 75);

/** The whole catalog (~500 rows), cached in memory: every vault request ranks all of it. */
export const allPrompts = (db: Db) => db.cached(PROMPTS_CACHE, PROMPTS_TTL_MS, () => db.all<PromptRow>("SELECT * FROM prompts"));

export function createService(db: Db) {
  let idfCache: { rows: PromptRow[]; idf: Idf } | undefined;
  const catalog = () => allPrompts(db);

  async function requirePrompt(id: number): Promise<void> {
    if (!(await db.get("SELECT 1 AS ok FROM prompts WHERE id = ?", id))) throw new HttpError(404, "Prompt not found");
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
    async vault(visitor: string, q: VaultQuery): Promise<VaultResponse> {
      // One round trip for everything personal, plus the cached catalog.
      const [rows, [saves, votesRows, subCount]] = await Promise.all([
        catalog(),
        db.batch<Record<string, number>>([
          { sql: "SELECT prompt_id FROM saves WHERE visitor_id = ?", args: [visitor] },
          { sql: "SELECT prompt_id, worked FROM votes WHERE visitor_id = ?", args: [visitor] },
          { sql: "SELECT COUNT(*) AS n FROM submissions" },
        ], "read") as Promise<Record<string, number>[][]>,
      ]);
      const saved = new Set(saves!.map((r) => r.prompt_id!));
      const votes = new Map(votesRows!.map((r) => [r.prompt_id!, r.worked!]));
      const query = q.q.trim();
      const now = Date.now();
      if (!idfCache || idfCache.rows !== rows) idfCache = { rows, idf: buildIdf(rows.map(toRankable)) };
      const idf = idfCache.idf;

      const toDTO = (r: PromptRow): PromptDTO => {
        const vote = votes.get(r.id);
        return {
          id: r.id, title: r.title, masterPrompt: r.master_prompt, collection: r.collection, category: r.category,
          section: r.section, tool: r.tool, useCases: JSON.parse(r.use_cases), variables: JSON.parse(r.variables),
          viralScore: r.viral_score, copyCount: r.copy_count, workedVotes: r.worked_votes, totalVotes: r.total_votes,
          successRate: successRate(r.worked_votes, r.total_votes),
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
          submissions: Number(subCount![0]!.n),
        },
        collections: collectionsOf(rows),
      };
    },

    async recordCopy(id: number): Promise<{ copyCount: number }> {
      const r = await db.get<{ copy_count: number }>("UPDATE prompts SET copy_count = copy_count + 1 WHERE id = ? RETURNING copy_count", id);
      if (!r) throw new HttpError(404, "Prompt not found");
      db.invalidate(PROMPTS_CACHE);
      return { copyCount: r.copy_count };
    },

    async toggleSave(visitor: string, id: number): Promise<{ saved: boolean }> {
      await requirePrompt(id);
      if ((await db.run("DELETE FROM saves WHERE visitor_id = ? AND prompt_id = ?", visitor, id)).changes > 0) return { saved: false };
      await db.run("INSERT OR IGNORE INTO saves (visitor_id, prompt_id, created_at) VALUES (?, ?, ?)", visitor, id, Date.now());
      return { saved: true };
    },

    /** One vote per visitor per prompt; changing your vote moves it rather than adding another. */
    async vote(visitor: string, id: number, worked: boolean): Promise<{ successRate: number; myVote: "worked" | "failed" }> {
      await requirePrompt(id);
      const w = worked ? 1 : 0;
      const prev = "(SELECT worked FROM votes WHERE visitor_id = ?1 AND prompt_id = ?2)";
      // Atomic: the counter update reads the previous vote, then the vote is upserted.
      const res = await db.batch<{ worked_votes: number; total_votes: number }>([
        {
          sql: `UPDATE prompts SET
                  total_votes  = total_votes  + CASE WHEN ${prev} IS NULL THEN 1 ELSE 0 END,
                  worked_votes = worked_votes + CASE WHEN ${prev} IS NULL THEN ?3 WHEN ${prev} = ?3 THEN 0 WHEN ?3 = 1 THEN 1 ELSE -1 END
                WHERE id = ?2`,
          args: [visitor, id, w],
        },
        {
          sql: `INSERT INTO votes (visitor_id, prompt_id, worked, created_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(visitor_id, prompt_id) DO UPDATE SET worked = excluded.worked`,
          args: [visitor, id, w, Date.now()],
        },
        { sql: "SELECT worked_votes, total_votes FROM prompts WHERE id = ?", args: [id] },
      ]);
      db.invalidate(PROMPTS_CACHE);
      const row = res[2]![0]!;
      return { successRate: successRate(row.worked_votes, row.total_votes), myVote: worked ? "worked" : "failed" };
    },

    async submit(visitor: string, url: string, note: string, category: string): Promise<{ id: number }> {
      const r = await db.get<{ id: number }>(
        "INSERT INTO submissions (visitor_id, url, note, category, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?) RETURNING id",
        visitor, url, note, category, Date.now(),
      );
      return { id: r!.id };
    },

    async mySubmissions(owner: string, limit: number): Promise<{ submissions: SubmissionDTO[] }> {
      const rows = await db.all<SubmissionRow>("SELECT * FROM submissions WHERE visitor_id = ? ORDER BY id DESC LIMIT ?", owner, limit);
      // The submitter never sees who else reviewed or submitted: drop the admin-only field.
      return { submissions: (await toSubmissionDTOs(db, rows)).map(({ submittedBy: _, ...s }) => s) };
    },

    // --- admin ---------------------------------------------------------------
    async adminSubmissions(status: SubmissionStatus | "all", limit: number, offset: number): Promise<AdminSubmissionsResponse> {
      const [rows, countRows] = await db.batch([
        {
          sql: `SELECT s.*, u.email FROM submissions s LEFT JOIN users u ON s.visitor_id = 'u:' || u.id
                WHERE (? = 'all' OR s.status = ?) ORDER BY s.id DESC LIMIT ? OFFSET ?`,
          args: [status, status, limit, offset],
        },
        { sql: "SELECT status, COUNT(*) AS n FROM submissions GROUP BY status" },
      ], "read");
      const counts: Record<SubmissionStatus, number> = { pending: 0, added: 0, rejected: 0 };
      for (const r of countRows as { status: string; n: number }[]) {
        if (r.status in counts) counts[r.status as SubmissionStatus] = Number(r.n);
      }
      return { submissions: await toSubmissionDTOs(db, rows as SubmissionRow[]), counts };
    },

    /**
     * Decline, or undo a decision (back to pending). Approving goes through
     * PromptAdmin.approveSubmission, because an approval must add prompts.
     * Undoing an approval unlinks its prompts but leaves them in the vault.
     */
    async setSubmissionStatus(id: number, status: Exclude<SubmissionStatus, "added">): Promise<AdminSubmissionDTO> {
      const res = await db.batch<SubmissionRow>([
        { sql: "UPDATE submissions SET status = ?, prompt_ids = '[]' WHERE id = ?", args: [status, id] },
        { sql: "SELECT s.*, u.email FROM submissions s LEFT JOIN users u ON s.visitor_id = 'u:' || u.id WHERE s.id = ?", args: [id] },
      ]);
      const r = res[1]![0];
      if (!r) throw new HttpError(404, "Submission not found");
      return (await toSubmissionDTOs(db, [r]))[0]!;
    },

    async categories(): Promise<Set<string>> {
      return new Set((await catalog()).map((r) => r.category));
    },
  };
}

export type Service = ReturnType<typeof createService>;
