import type {
  AdminPromptDTO, AdminSubmissionDTO, AdminSubmissionsResponse, AnalysisDTO, ImportDefaults, ImportResult, SubmissionDTO,
  SubmissionStatus, UserDTO, VaultResponse,
} from "../../server/src/types.ts";

export type {
  PromptDTO, VaultResponse, SubmissionDTO, CollectionInfo, UserDTO, AdminSubmissionDTO, AdminSubmissionsResponse, SubmissionStatus,
  AdminPromptDTO, ImportDefaults, ImportResult, ImportRowResult,
} from "../../server/src/types.ts";

// Sessions live in HttpOnly cookies set by the server; this file never sees a token.
// The browser id below is only used once, at sign-in, to move this browser's
// pre-account saves into the account.
const KEY = "pv.visitor";

function browserId(): string | undefined {
  try {
    const id = localStorage.getItem(KEY);
    return id && /^[A-Za-z0-9-]{16,64}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** One refresh at a time, shared by every request that hit an expired token. */
let refreshing: Promise<boolean> | null = null;
function refreshSession(): Promise<boolean> {
  refreshing ??= fetch("/api/auth/refresh", { method: "POST", credentials: "same-origin" })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => { refreshing = null; });
  return refreshing;
}

/** Called when the session is gone, so the app can drop cached personal data. */
let onSessionLost: () => void = () => {};
export function setSessionLostHandler(fn: () => void) { onSessionLost = fn; }

async function request<T>(path: string, init?: { method?: string; body?: unknown }, retried = false): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (res.status === 401 && data.code === "token_expired" && !retried) {
    if (await refreshSession()) return request<T>(path, init, true);
    onSessionLost();
  } else if (res.status === 401 && (data.code === "session_revoked" || data.code === "invalid_token")) {
    onSessionLost();
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, data.code);
  return data as T;
}

export type VaultParams = { q: string; collection: string; category: string; savedOnly: boolean; offset: number; limit: number };

export type AdminAnalysis = AnalysisDTO & {
  postText: string;
  ocrText: string;
  transcript: string;
  candidates: { title: string; masterPrompt: string; category: string; tool: string; source: string; confidence: number; matchPromptId: number | null }[];
};

export const api = {
  vault(p: VaultParams) {
    const s = new URLSearchParams({
      q: p.q, collection: p.collection, category: p.category,
      offset: String(p.offset), limit: String(p.limit), ...(p.savedOnly ? { saved: "1" } : {}),
    });
    return request<VaultResponse>(`/api/vault?${s}`);
  },
  recordCopy: (id: number) => request<{ copyCount: number }>(`/api/prompts/${id}/copy`, { method: "POST" }),
  toggleSave: (id: number) => request<{ saved: boolean }>(`/api/prompts/${id}/save`, { method: "POST" }),
  vote: (id: number, worked: boolean) =>
    request<{ successRate: number; myVote: "worked" | "failed" }>(`/api/prompts/${id}/vote`, { method: "POST", body: { worked } }),
  submit: (url: string, note: string, category: string) =>
    request<{ id: number }>("/api/submissions", { method: "POST", body: { url, note, category } }),
  mySubmissions: () => request<{ submissions: SubmissionDTO[] }>("/api/submissions?limit=10"),

  // --- accounts ---
  me: () => request<{ user: UserDTO | null }>("/api/auth/me"),
  login: (email: string, password: string) =>
    request<{ user: UserDTO }>("/api/auth/login", { method: "POST", body: { email, password, visitorId: browserId() } }),
  register: (email: string, password: string, name: string) =>
    request<{ user: UserDTO }>("/api/auth/register", { method: "POST", body: { email, password, name, visitorId: browserId() } }),
  logout: (everywhere = false) => request<{ ok: true }>("/api/auth/logout", { method: "POST", body: { everywhere } }),

  // --- admin ---
  adminSubmissions: (status: SubmissionStatus | "all", offset: number, limit: number) =>
    request<AdminSubmissionsResponse>(`/api/admin/submissions?status=${status}&offset=${offset}&limit=${limit}`),
  setSubmissionStatus: (id: number, status: SubmissionStatus) =>
    request<AdminSubmissionDTO>(`/api/admin/submissions/${id}`, { method: "POST", body: { status } }),
  adminAnalyses: (status: string) => request<{ analyses: AdminAnalysis[] }>(`/api/admin/analyses?status=${status}&limit=50`),
  approveAnalysis: (id: number, keep: number[]) => request<AnalysisDTO>(`/api/admin/analyses/${id}/approve`, { method: "POST", body: { keep } }),
  rejectAnalysis: (id: number) => request<AnalysisDTO>(`/api/admin/analyses/${id}/reject`, { method: "POST" }),
  /** Validate (dryRun) or import prompts. Rows use the documented field names (or their aliases). */
  importPrompts: (prompts: Record<string, unknown>[], defaults: ImportDefaults, dryRun: boolean) =>
    request<ImportResult>("/api/admin/prompts", { method: "POST", body: { prompts, defaults, dryRun } }),
  recentPrompts: () => request<{ prompts: AdminPromptDTO[] }>("/api/admin/prompts?limit=30"),
  deletePrompt: (id: number) => request<{ deleted: true }>(`/api/admin/prompts/${id}`, { method: "DELETE" }),
};
