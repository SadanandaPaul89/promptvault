// Shared API contract between server and client. Type-only — safe to import
// from the browser bundle.

export type ScoreBreakdown = {
  semantic: number;
  keyword: number;
  success: number;
  viral: number;
  freshness: number;
  final: number;
};

export type PromptDTO = {
  id: number;
  title: string;
  masterPrompt: string;
  collection: string;
  category: string;
  section: string;
  tool: string;
  useCases: string[];
  variables: string[];
  viralScore: number;
  copyCount: number;
  workedVotes: number;
  totalVotes: number;
  successRate: number;
  saved: boolean;
  myVote: "worked" | "failed" | null;
  createdAt: string;
  score: ScoreBreakdown;
};

export type CategoryCount = { name: string; count: number };
export type CollectionInfo = { name: string; count: number; categories: CategoryCount[] };

export type VaultResponse = {
  prompts: PromptDTO[];
  /** Number of prompts matching the query + filters (before pagination). */
  matched: number;
  offset: number;
  limit: number;
  trending: PromptDTO[];
  stats: { total: number; savedCount: number; totalCopies: number; submissions: number };
  collections: CollectionInfo[];
};

export type SubmissionDTO = {
  id: number;
  url: string;
  note: string;
  category: string;
  status: string;
  createdAt: string;
  /** Vault prompts added (or linked) for this link when it was approved. */
  prompts: { id: number; title: string }[];
};

export type UserDTO = { id: number; email: string; name: string; role: "user" | "admin" };

export type SubmissionStatus = "pending" | "added" | "rejected";

export type AdminSubmissionDTO = SubmissionDTO & {
  /** Submitter's email, or null for submissions made before accounts existed. */
  submittedBy: string | null;
};

export type AdminSubmissionsResponse = {
  submissions: AdminSubmissionDTO[];
  counts: Record<SubmissionStatus, number>;
};

/**
 * pending   — prompts found, waiting for moderation (first time a post is seen)
 * approved  — moderated (or every prompt already existed in the vault); served instantly to everyone
 * rejected  — moderator found nothing usable
 * no_prompt — no prompt detected
 * dm_gated  — the post hides the prompt behind "comment X and I'll DM you"
 */
export type AnalysisStatus = "pending" | "approved" | "rejected" | "no_prompt" | "dm_gated";

export type AnalyzedPrompt = {
  id: number;
  title: string;
  masterPrompt: string;
  category: string;
  tool: string;
  variables: string[];
};

export type AnalysisDTO = {
  found: true;
  /** true when this post had already been analysed before this request. */
  cached: boolean;
  id: number;
  key: string;
  platform: "instagram" | "linkedin";
  sourceUrl: string;
  creator: string;
  status: AnalysisStatus;
  message: string;
  /** Only filled once approved. */
  prompts: AnalyzedPrompt[];
  requestCount: number;
  createdAt: string;
};

export type AnalysisLookup = AnalysisDTO | { found: false; key: string };

export const ALL = "All";

// --- admin: adding prompts (see docs/IMPORTING-PROMPTS.md) -----------------------

export type ImportDefaults = { collection?: string; category?: string; tool?: string };

export type ImportRowResult = {
  /** 1-based, matching the row number in the admin's file (header excluded). */
  row: number;
  status: "new" | "duplicate" | "invalid";
  errors: string[];
  warnings: string[];
  title: string;
  collection: string;
  category: string;
  tool: string;
  variables: string[];
  /** Set after a real (non-dry) import. */
  id?: number;
  /** For a duplicate of a prompt already in the vault: that prompt's id. */
  existingId?: number;
};

export type ImportResult = {
  dryRun: boolean;
  rows: ImportRowResult[];
  summary: { total: number; new: number; duplicate: number; invalid: number; imported: number };
};

export type AdminPromptDTO = {
  id: number; title: string; collection: string; category: string; tool: string; source: string; createdAt: string;
};
