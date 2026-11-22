import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type AdminAnalysis, type SubmissionStatus } from "./api";
import { useAuth } from "./auth";

const PAGE = 25;
const fmtDate = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function AdminView() {
  const [section, setSection] = useState<"submissions" | "analyses">("submissions");
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div>
          <h2 className="font-display text-2xl font-bold">Admin</h2>
          <p className="text-sm text-[var(--dim)] mt-1">Review links people submitted and prompts the extension found.</p>
        </div>
        <div className="segmented" role="tablist" aria-label="Admin sections">
          <button type="button" role="tab" aria-selected={section === "submissions"} aria-pressed={section === "submissions"} onClick={() => setSection("submissions")}>Submitted links</button>
          <button type="button" role="tab" aria-selected={section === "analyses"} aria-pressed={section === "analyses"} onClick={() => setSection("analyses")}>Extension analyses</button>
        </div>
      </div>
      {section === "submissions" ? <Submissions /> : <Analyses />}
    </div>
  );
}

function Submissions() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [status, setStatus] = useState<SubmissionStatus | "all">("pending");
  const [page, setPage] = useState(0);
  const q = useQuery({
    queryKey: ["admin-subs", user?.id, status, page],
    queryFn: () => api.adminSubmissions(status, page * PAGE, PAGE),
    placeholderData: keepPreviousData,
  });
  const setMut = useMutation({
    mutationFn: ({ id, s }: { id: number; s: SubmissionStatus }) => api.setSubmissionStatus(id, s),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-subs"] }),
  });
  const counts = q.data?.counts;
  const total = counts ? (status === "all" ? counts.pending + counts.added + counts.rejected : counts[status]) : 0;
  const filters: [SubmissionStatus | "all", string][] = [["pending", "Pending"], ["added", "Added"], ["rejected", "Rejected"], ["all", "All"]];

  return (
    <section>
      <div className="flex flex-wrap gap-2 mb-3">
        {filters.map(([s, label]) => (
          <button key={s} type="button" className={`filter ${status === s ? "is-active" : ""}`} aria-pressed={status === s} onClick={() => { setStatus(s); setPage(0); }}>
            {label}
            {counts && <span className="count">{s === "all" ? counts.pending + counts.added + counts.rejected : counts[s]}</span>}
          </button>
        ))}
      </div>

      {q.isError && <p role="alert" className="text-sm text-[var(--danger)]">{q.error.message}</p>}
      {q.data && q.data.submissions.length === 0 && <div className="empty"><p className="font-semibold">Nothing here</p><p className="text-sm text-[var(--dim)] mt-1">No {status === "all" ? "" : status} submissions.</p></div>}

      {q.data && q.data.submissions.length > 0 && (
        <div className={`panel p-0 overflow-x-auto ${q.isPlaceholderData ? "opacity-60" : ""}`}>
          <table className="w-full text-sm min-w-[720px]">
            <thead>
              <tr className="text-left text-xs text-[var(--dim)] border-b border-[var(--border)]">
                <th className="font-medium py-2.5 px-4">Link</th>
                <th className="font-medium py-2.5 px-3">Submitted by</th>
                <th className="font-medium py-2.5 px-3">Category</th>
                <th className="font-medium py-2.5 px-3">When</th>
                <th className="font-medium py-2.5 px-4 text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {q.data.submissions.map((s) => (
                <tr key={s.id} className="align-top">
                  <td className="py-3 px-4 max-w-[360px]">
                    <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="link break-all">{s.url}</a>
                    {s.note && <p className="text-xs text-[var(--dim)] mt-1">{s.note}</p>}
                  </td>
                  <td className="py-3 px-3 text-[var(--dim)]">{s.submittedBy ?? <span title="Submitted before accounts existed">Anonymous</span>}</td>
                  <td className="py-3 px-3">{s.category}</td>
                  <td className="py-3 px-3 text-[var(--dim)] whitespace-nowrap tabular-nums">{fmtDate(s.createdAt)}</td>
                  <td className="py-3 px-4 text-right">
                    <select
                      aria-label={`Status for ${s.url}`}
                      value={s.status}
                      disabled={setMut.isPending && setMut.variables?.id === s.id}
                      onChange={(e) => setMut.mutate({ id: s.id, s: e.target.value as SubmissionStatus })}
                      className="field field-sm w-auto"
                    >
                      <option value="pending">Pending</option>
                      <option value="added">Added</option>
                      <option value="rejected">Rejected</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {total > PAGE && (
        <div className="flex items-center justify-end gap-2 mt-3 text-sm text-[var(--dim)]">
          <span className="tabular-nums">{page * PAGE + 1}–{Math.min(total, (page + 1) * PAGE)} of {total}</span>
          <button type="button" className="btn btn-secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
          <button type="button" className="btn btn-secondary" disabled={(page + 1) * PAGE >= total} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
    </section>
  );
}

function Analyses() {
  const { user } = useAuth();
  const [status, setStatus] = useState("pending");
  const q = useQuery({ queryKey: ["admin-analyses", user?.id, status], queryFn: () => api.adminAnalyses(status) });
  const statuses: [string, string][] = [["pending", "Pending"], ["approved", "Approved"], ["rejected", "Rejected"], ["no_prompt", "No prompt"], ["dm_gated", "DM-gated"]];

  return (
    <section>
      <div className="flex flex-wrap gap-2 mb-3">
        {statuses.map(([s, label]) => (
          <button key={s} type="button" className={`filter ${status === s ? "is-active" : ""}`} aria-pressed={status === s} onClick={() => setStatus(s)}>{label}</button>
        ))}
      </div>
      {q.isError && <p role="alert" className="text-sm text-[var(--danger)]">{q.error.message}</p>}
      {q.data && q.data.analyses.length === 0 && <div className="empty"><p className="font-semibold">Nothing to review</p><p className="text-sm text-[var(--dim)] mt-1">Posts analysed with the extension show up here.</p></div>}
      <div className="space-y-3">
        {q.data?.analyses.map((a) => <AnalysisCard key={a.id} a={a} />)}
      </div>
    </section>
  );
}

function AnalysisCard({ a }: { a: AdminAnalysis }) {
  const qc = useQueryClient();
  const [keep, setKeep] = useState<number[]>(a.candidates.map((_, i) => i));
  const done = () => qc.invalidateQueries({ queryKey: ["admin-analyses"] });
  const approve = useMutation({ mutationFn: () => api.approveAnalysis(a.id, keep), onSuccess: done });
  const reject = useMutation({ mutationFn: () => api.rejectAnalysis(a.id), onSuccess: done });
  const err = approve.error ?? reject.error;

  return (
    <article className="panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <a href={a.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="link font-medium break-all">{a.sourceUrl}</a>
        <span className="text-xs text-[var(--dim)] tabular-nums">{a.platform} · {a.creator || "unknown creator"} · {a.requestCount} request{a.requestCount === 1 ? "" : "s"} · {fmtDate(a.createdAt)}</span>
      </div>

      {a.candidates.length > 0 && (
        <ul className="mt-3 space-y-2">
          {a.candidates.map((c, i) => (
            <li key={i} className="flex gap-3 items-start">
              {a.status === "pending" && (
                <input type="checkbox" aria-label={`Keep “${c.title}”`} className="mt-1" checked={keep.includes(i)} onChange={(e) => setKeep(e.target.checked ? [...keep, i] : keep.filter((k) => k !== i))} />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{c.title} <span className="text-xs text-[var(--dim)] font-normal">· {c.tool} · {c.category} · from {c.source} · {Math.round(c.confidence * 100)}%{c.matchPromptId ? " · already in vault" : ""}</span></p>
                <p className="prompt-box mt-1.5 text-xs">{c.masterPrompt}</p>
              </div>
            </li>
          ))}
        </ul>
      )}

      <details className="mt-3">
        <summary className="text-xs text-[var(--dim)]">Raw text (caption, OCR, transcript)</summary>
        <div className="mt-2 grid gap-2 text-xs">
          {[["Caption / post", a.postText], ["OCR", a.ocrText], ["Transcript", a.transcript]].map(([label, t]) => t ? (
            <div key={label}><p className="section-label mb-1">{label}</p><p className="whitespace-pre-wrap text-[var(--dim)]">{t}</p></div>
          ) : null)}
        </div>
      </details>

      {a.status === "pending" && (
        <div className="flex flex-wrap items-center gap-2 mt-4">
          <button type="button" className="btn btn-primary" disabled={keep.length === 0 || approve.isPending} onClick={() => approve.mutate()}>
            Approve {keep.length} prompt{keep.length === 1 ? "" : "s"}
          </button>
          <button type="button" className="btn btn-secondary" disabled={reject.isPending} onClick={() => reject.mutate()}>Reject</button>
          {err && <span role="alert" className="text-sm text-[var(--danger)]">{err.message}</span>}
        </div>
      )}
    </article>
  );
}
