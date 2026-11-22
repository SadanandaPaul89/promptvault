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
