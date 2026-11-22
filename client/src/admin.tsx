import { Fragment, useEffect, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type AdminAnalysis, type AdminSubmissionDTO, type ImportDefaults, type SubmissionStatus } from "./api";
import { useAuth } from "./auth";
import { AddPrompts, CollectionFields, VariableChips, useAfterChange, useCatalog } from "./admin-prompts";

const PAGE = 25;
export const STATUS_LABEL: Record<SubmissionStatus, string> = { pending: "In review", added: "Approved", rejected: "Declined" };
const fmtDate = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Items waiting for an admin decision. Refreshes whenever an admin action invalidates these keys. */
export function usePendingCounts(enabled: boolean) {
  const { user } = useAuth();
  const links = useQuery({
    queryKey: ["admin-subs", user?.id, "pending-count"],
    queryFn: () => api.adminSubmissions("pending", 0, 1),
    enabled,
    staleTime: 30_000,
  });
  const analyses = useQuery({
    queryKey: ["admin-analyses", user?.id, "pending-count"],
    queryFn: () => api.adminAnalyses("pending"),
    enabled,
    staleTime: 30_000,
  });
  const l = links.data?.counts.pending ?? 0;
  const a = analyses.data?.analyses.length ?? 0;
  return { links: l, analyses: a, total: l + a };
}

export function AdminView() {
  const pending = usePendingCounts(true);
  const [section, setSection] = useState<"submissions" | "analyses" | "add">(() => (pending.links === 0 && pending.analyses > 0 ? "analyses" : "submissions"));
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div>
          <h2 className="font-display text-2xl font-bold">Admin</h2>
          <p className="text-sm text-[var(--dim)] mt-1">Review submitted links and extension finds, and add your own prompts.</p>
        </div>
        <div className="segmented" role="tablist" aria-label="Admin sections">
          <button type="button" role="tab" aria-selected={section === "submissions"} aria-pressed={section === "submissions"} onClick={() => setSection("submissions")}>
            Submitted links{pending.links > 0 && <span className="tab-count ml-1.5">{pending.links}</span>}
          </button>
          <button type="button" role="tab" aria-selected={section === "analyses"} aria-pressed={section === "analyses"} onClick={() => setSection("analyses")}>
            Extension analyses{pending.analyses > 0 && <span className="tab-count ml-1.5">{pending.analyses}</span>}
          </button>
          <button type="button" role="tab" aria-selected={section === "add"} aria-pressed={section === "add"} onClick={() => setSection("add")}>Add prompts</button>
        </div>
      </div>
      {section === "submissions" ? <Submissions /> : section === "analyses" ? <Analyses /> : <AddPrompts />}
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
  const [approving, setApproving] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const setMut = useMutation({
    mutationFn: ({ id, s }: { id: number; s: Exclude<SubmissionStatus, "added"> }) => api.setSubmissionStatus(id, s),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-subs"] }),
  });
  const busy = (id: number) => setMut.isPending && setMut.variables?.id === id;
  const approved = (msg: string) => { setApproving(null); setNotice(msg); };
  const counts = q.data?.counts;
  const total = counts ? (status === "all" ? counts.pending + counts.added + counts.rejected : counts[status]) : 0;
  const filters: [SubmissionStatus | "all", string][] = [["pending", "Waiting for review"], ["added", "Approved"], ["rejected", "Declined"], ["all", "All"]];

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
      {notice && <p role="status" className="text-sm text-[var(--ok)] mb-3">{notice}</p>}
      {q.data && q.data.submissions.length === 0 && (
        <div className="empty">
          <p className="font-semibold">{status === "pending" ? "All caught up" : "Nothing here"}</p>
          <p className="text-sm text-[var(--dim)] mt-1">
            {status === "pending"
              ? "No links are waiting for review. When someone submits a post on the Submit tab, it shows up here. Approve it by adding the prompt from that post; the submitter then sees it."
              : `No ${status === "all" ? "" : STATUS_LABEL[status].toLowerCase() + " "}links.`}
          </p>
        </div>
      )}

      {q.data && q.data.submissions.length > 0 && (() => {
        const decision = (s: (typeof q.data.submissions)[number]) =>
          s.status === "pending" ? (
            <div className="inline-flex gap-2">
              <button type="button" className="btn btn-primary btn-sm" disabled={busy(s.id)} aria-expanded={approving === s.id}
                onClick={() => { setNotice(""); setApproving(approving === s.id ? null : s.id); }} aria-label={`Approve ${s.url} and add its prompt`}>
                {approving === s.id ? "Close" : "Approve"}
              </button>
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy(s.id)} onClick={() => setMut.mutate({ id: s.id, s: "rejected" })} aria-label={`Decline ${s.url}`}>Decline</button>
            </div>
          ) : (
            <div className="inline-flex items-center gap-3">
              <span className={`status status-${s.status}`}>{STATUS_LABEL[s.status as SubmissionStatus] ?? s.status}</span>
              <button type="button" className="link text-xs" disabled={busy(s.id)} onClick={() => setMut.mutate({ id: s.id, s: "pending" })} aria-label={`Undo decision for ${s.url}`}
                title={s.status === "added" ? "Moves it back to review. The prompts it added stay in the vault (delete them under Add prompts if needed)." : undefined}>Undo</button>
            </div>
          );
        const who = (s: (typeof q.data.submissions)[number]) => s.submittedBy ?? <span title="Submitted before accounts existed">Anonymous</span>;
        const linked = (s: (typeof q.data.submissions)[number]) => s.prompts.length > 0 && (
          <p className="text-xs text-[var(--dim)] mt-1">Added: {s.prompts.map((p) => `#${p.id} ${p.title}`).join(", ")}</p>
        );
        return (
          <div className={q.isPlaceholderData ? "opacity-60" : ""}>
            {/* Phones: one card per link, decision buttons always in view. */}
            <ul className="md:hidden space-y-3">
              {q.data.submissions.map((s) => (
                <li key={s.id} className="panel">
                  <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="link break-all text-sm font-medium">{s.url}</a>
                  {s.note && <p className="text-xs text-[var(--dim)] mt-1">{s.note}</p>}
                  {linked(s)}
                  <p className="text-xs text-[var(--dim)] mt-2">{who(s)} · {s.category} · <span className="tabular-nums">{fmtDate(s.createdAt)}</span></p>
                  <div className="mt-3">{decision(s)}</div>
                  {approving === s.id && <ApproveForm s={s} idPrefix={`m${s.id}`} onDone={approved} />}
                </li>
              ))}
            </ul>
            {/* Wider screens: a table. */}
            <div className="hidden md:block panel p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-[var(--dim)] border-b border-[var(--border)]">
                    <th className="font-medium py-2.5 px-4">Link</th>
                    <th className="font-medium py-2.5 px-3">Submitted by</th>
                    <th className="font-medium py-2.5 px-3">Category</th>
                    <th className="font-medium py-2.5 px-3">When</th>
                    <th className="font-medium py-2.5 px-4 text-right">Decision</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {q.data.submissions.map((s) => (
                    <Fragment key={s.id}>
                      <tr className="align-top">
                        <td className="py-3 px-4 max-w-[360px]">
                          <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="link break-all">{s.url}</a>
                          {s.note && <p className="text-xs text-[var(--dim)] mt-1">{s.note}</p>}
                          {linked(s)}
                        </td>
                        <td className="py-3 px-3 text-[var(--dim)]">{who(s)}</td>
                        <td className="py-3 px-3">{s.category}</td>
                        <td className="py-3 px-3 text-[var(--dim)] whitespace-nowrap tabular-nums">{fmtDate(s.createdAt)}</td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">{decision(s)}</td>
                      </tr>
                      {approving === s.id && (
                        <tr><td colSpan={5} className="px-4 pb-4"><ApproveForm s={s} idPrefix={`t${s.id}`} onDone={approved} /></td></tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}
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

type Draft = { title: string; masterPrompt: string; useCases: string };
const MAX_PER_LINK = 10;

/**
 * Approving a link means adding the prompt(s) from that post. Open the post,
 * copy the prompt in, and approve: the prompts go live in the vault and the
 * submitter sees them under "Your submissions". A prompt that's already in the
 * vault is linked instead of added twice.
 */
function ApproveForm({ s, idPrefix, onDone }: { s: AdminSubmissionDTO; idPrefix: string; onDone: (msg: string) => void }) {
  const qc = useQueryClient();
  const after = useAfterChange();
  const collections = useCatalog();
  const guessCategory = s.category !== "Other" ? s.category : "";
  const [where, setWhere] = useState<ImportDefaults>({ collection: "", category: guessCategory, tool: "" });
  const [drafts, setDrafts] = useState<Draft[]>([{ title: s.note, masterPrompt: "", useCases: "" }]);
  const edit = (i: number, patch: Partial<Draft>) => setDrafts(drafts.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  // Once the catalog loads, put the submitter's category in its collection.
  useEffect(() => {
    if (where.collection || !guessCategory) return;
    const home = collections.find((c) => c.categories.some((x) => x.name === guessCategory));
    if (home) setWhere((w) => ({ ...w, collection: home.name }));
  }, [collections, guessCategory, where.collection]);

  const mut = useMutation({
    mutationFn: () => api.approveSubmission(s.id, drafts.map((d) => ({ ...d, ...where }))),
    onSuccess: ({ result }) => {
      qc.invalidateQueries({ queryKey: ["admin-subs"] });
      after();
      const added = result.rows.filter((r) => r.status === "new").length;
      const linked = result.rows.filter((r) => r.existingId).length;
      onDone(`Approved. ${added ? `${added} prompt${added === 1 ? "" : "s"} added to the vault` : ""}${added && linked ? ", " : ""}${linked ? `${linked} already in the vault and linked` : ""}. The submitter can open ${added + linked === 1 ? "it" : "them"} now.`);
    },
  });

  return (
    <form className="panel mt-3 space-y-4 text-left whitespace-normal" onSubmit={(e) => { e.preventDefault(); mut.mutate(); }}>
      <div>
        <p className="font-semibold">Add the prompt from this post</p>
        <p className="text-xs text-[var(--dim)] mt-1">
          <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="link">Open the post</a>, copy its prompt in, and approve.
          It goes live in the vault and the submitter sees it. Nothing to add? Decline instead.
        </p>
      </div>
      <CollectionFields value={where} onChange={setWhere} idPrefix={idPrefix} requiredNote=" *" />
      {drafts.map((d, i) => (
        <fieldset key={i} className={i > 0 ? "pt-4 border-t border-[var(--border)] space-y-3" : "space-y-3"}>
          {drafts.length > 1 && (
            <legend className="flex w-full items-center justify-between text-xs font-medium text-[var(--dim)]">
              Prompt {i + 1}
              <button type="button" className="link" onClick={() => setDrafts(drafts.filter((_, j) => j !== i))}>Remove</button>
            </legend>
          )}
          <label className="block">
            <span className="block text-xs font-medium text-[var(--dim)] mb-1">Title *</span>
            <input value={d.title} onChange={(e) => edit(i, { title: e.target.value })} maxLength={120} required className="field" placeholder="e.g. Saree product photo" />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-[var(--dim)] mb-1">Master prompt *</span>
            <textarea value={d.masterPrompt} onChange={(e) => edit(i, { masterPrompt: e.target.value })} maxLength={8000} required minLength={10} rows={5}
              className="field font-prompt text-[13px]" placeholder="Paste the prompt from the post. Put anything the user should change in [BRACKETS]." />
            <VariableChips prompt={d.masterPrompt} />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-[var(--dim)] mb-1">Search keywords <span className="opacity-70">(optional, separate with |)</span></span>
            <input value={d.useCases} onChange={(e) => edit(i, { useCases: e.target.value })} maxLength={600} className="field" placeholder="saree | product photo | diwali" />
          </label>
        </fieldset>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="btn btn-primary" disabled={mut.isPending}>
          {mut.isPending ? "Approving…" : `Approve and add ${drafts.length === 1 ? "prompt" : `${drafts.length} prompts`}`}
        </button>
        {drafts.length < MAX_PER_LINK && (
          <button type="button" className="btn btn-secondary" onClick={() => setDrafts([...drafts, { title: "", masterPrompt: "", useCases: "" }])}>Add another prompt</button>
        )}
        {mut.isError && <span role="alert" className="text-sm text-[var(--danger)]">{mut.error.message}</span>}
      </div>
    </form>
  );
}

function Analyses() {
  const { user } = useAuth();
  const [status, setStatus] = useState("pending");
  const q = useQuery({ queryKey: ["admin-analyses", user?.id, status], queryFn: () => api.adminAnalyses(status) });
  const statuses: [string, string][] = [["pending", "Waiting for review"], ["approved", "Approved"], ["rejected", "Rejected"], ["no_prompt", "No prompt"], ["dm_gated", "DM-gated"]];

  return (
    <section>
      <div className="flex flex-wrap gap-2 mb-3">
        {statuses.map(([s, label]) => (
          <button key={s} type="button" className={`filter ${status === s ? "is-active" : ""}`} aria-pressed={status === s} onClick={() => setStatus(s)}>{label}</button>
        ))}
      </div>
      {q.isError && <p role="alert" className="text-sm text-[var(--danger)]">{q.error.message}</p>}
      {q.data && q.data.analyses.length === 0 && (
        <div className="empty">
          <p className="font-semibold">{status === "pending" ? "All caught up" : "Nothing here"}</p>
          <p className="text-sm text-[var(--dim)] mt-1">
            {status === "pending"
              ? "When the browser extension finds a new prompt in a reel or post, it waits here for you to approve or reject."
              : "No analyses with this status."}
          </p>
        </div>
      )}
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
