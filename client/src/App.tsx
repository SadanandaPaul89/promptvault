import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type CollectionInfo, type PromptDTO, type SubmissionStatus } from "./api";
import { AccountMenu, useAuth } from "./auth";
import { AdminView, STATUS_LABEL, usePendingCounts } from "./admin";

const ALL = "All";
const PAGE_SIZES = [10, 20, 40, 60] as const;
const SIZE_KEY = "pv.pageSize";

type View = "browse" | "saved" | "submit" | "ranking" | "admin";
const VIEWS: { id: View; label: string; admin?: boolean }[] = [
  { id: "browse", label: "Browse" },
  { id: "saved", label: "Saved" },
  { id: "submit", label: "Submit" },
  { id: "admin", label: "Admin", admin: true },
  { id: "ranking", label: "How ranking works" },
];

const QUICK: Record<string, string[]> = {
  [ALL]: ["Diwali product photo for my saree shop", "write a PRD for a new feature", "birthday photo edit", "prioritize my roadmap"],
  "Viral Creator Prompts": ["Diwali product photo for my saree shop", "birthday photo edit", "Veo 3 product ad", "reel hook script"],
  "Product Management": ["write a PRD for a new feature", "prioritize my roadmap", "define a north star metric", "competitor analysis"],
};

// ---------- helpers ---------------------------------------------------------
const normVar = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const fmt = (n: number) => n.toLocaleString("en-IN");

/** Readable label for a variable, taken from how it's written in the prompt. */
function varLabel(p: PromptDTO, v: string): string {
  let raw = v;
  for (const m of p.masterPrompt.matchAll(/\[([^\]]+)\]/g)) if (normVar(m[1]!) === v) { raw = m[1]!; break; }
  const s = raw === raw.toUpperCase() ? raw.toLowerCase().replace(/_/g, " ") : raw;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fillPrompt(p: PromptDTO, vals: Record<string, string>): string {
  return p.masterPrompt.replace(/\[([^\]]+)\]/g, (whole, inner: string) => (vals[normVar(inner)] ?? "").trim() || whole);
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

function readPageSize(): number {
  try {
    const n = Number(localStorage.getItem(SIZE_KEY));
    return (PAGE_SIZES as readonly number[]).includes(n) ? n : 10;
  } catch {
    return 10;
  }
}

// ---------- URL state (shareable) -------------------------------------------
type UrlState = { view: View; q: string; collection: string; category: string; page: number; selected: number | null };

function readUrl(): UrlState {
  const s = new URLSearchParams(window.location.search);
  const v = s.get("v");
  return {
    view: VIEWS.some((x) => x.id === v) ? (v as View) : "browse",
    q: s.get("q") ?? "",
    collection: s.get("c") ?? ALL,
    category: s.get("cat") ?? ALL,
    page: Math.max(1, Number(s.get("page")) || 1),
    selected: Number(s.get("p")) || null,
  };
}

function writeUrl(st: UrlState) {
  const s = new URLSearchParams();
  if (st.view !== "browse") s.set("v", st.view);
  if (st.q) s.set("q", st.q);
  if (st.collection !== ALL) s.set("c", st.collection);
  if (st.category !== ALL) s.set("cat", st.category);
  if (st.page > 1) s.set("page", String(st.page));
  if (st.selected) s.set("p", String(st.selected));
  const qs = s.toString();
  window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
}

// ---------- icons -----------------------------------------------------------
const ICONS = {
  search: "M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15ZM21 21l-5.2-5.2",
  copy: "M8 8h12v12H8zM16 8V4H4v12h4",
  bookmark: "M6 3.5h12v17l-6-4.2-6 4.2z",
  close: "M6 6l12 12M18 6 6 18",
  left: "M15 18l-6-6 6-6",
  right: "M9 18l6-6-6-6",
  check: "M5 12.5l4.5 4.5L19 7",
  chevron: "M6 9l6 6 6-6",
} as const;

function Icon({ name, filled, className = "size-4" }: { name: keyof typeof ICONS; filled?: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

// ---------- small building blocks ---------------------------------------------
function Button({ children, onClick, variant = "secondary", pressed, disabled, className = "", label, type = "button" }: {
  children: ReactNode; onClick?: () => void; variant?: "primary" | "secondary" | "ghost"; pressed?: boolean; disabled?: boolean; className?: string; label?: string; type?: "button" | "submit";
}) {
  return (
    <button type={type} onClick={onClick} disabled={disabled} aria-pressed={pressed} aria-label={label} className={`btn btn-${variant} ${className}`}>
      {children}
    </button>
  );
}

function Pagination({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null;
  const nums: (number | "…")[] = [];
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || Math.abs(i - page) <= 1) nums.push(i);
    else if (nums[nums.length - 1] !== "…") nums.push("…");
  }
  return (
    <nav aria-label="Pages" className="flex items-center gap-1">
      <Button variant="ghost" label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}><Icon name="left" /></Button>
      {nums.map((n, i) =>
        n === "…" ? (
          <span key={`gap${i}`} className="px-1 text-[var(--dim)]">…</span>
        ) : (
          <button key={n} type="button" onClick={() => onPage(n)} aria-current={n === page ? "page" : undefined} className={`page-num ${n === page ? "is-current" : ""}`}>
            {n}
          </button>
        ),
      )}
      <Button variant="ghost" label="Next page" disabled={page >= pages} onClick={() => onPage(page + 1)}><Icon name="right" /></Button>
    </nav>
  );
}

// ---------- prompt list ---------------------------------------------------------
function PromptRow({ p, selected, showRank, onSelect }: { p: PromptDTO; selected: boolean; showRank: boolean; onSelect: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await copyText(p.masterPrompt);
    api.recordCopy(p.id).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <li className={`row ${selected ? "is-selected" : ""}`} data-id={p.id}>
      <button type="button" onClick={onSelect} aria-current={selected || undefined} className="row-main">
        <span className="flex items-baseline justify-between gap-3">
          <span className="font-semibold text-[15px] leading-snug text-[var(--text)]">{p.title}</span>
          {showRank && <span className="tabular-nums text-xs font-semibold text-[var(--accent)] shrink-0" title="Match score">{p.score.final}</span>}
        </span>
        <span className="row-preview">{p.masterPrompt}</span>
        <span className="row-meta">
          <span>{p.tool}</span>
          <span>{p.category}</span>
          <span>{p.totalVotes > 0 ? `${p.successRate}% worked` : "No votes yet"}</span>
          <span className="hidden sm:inline">{fmt(p.copyCount)} copies</span>
          {p.saved && <span className="text-[var(--accent)]">Saved</span>}
        </span>
      </button>
      <button type="button" onClick={copy} className="row-copy" aria-label={`Copy “${p.title}”`} title="Copy template">
        <Icon name={copied ? "check" : "copy"} />
      </button>
    </li>
  );
}

function PromptText({ p, vals }: { p: PromptDTO; vals: Record<string, string> }) {
  return (
    <>
      {p.masterPrompt.split(/(\[[^\]]+\])/g).map((part, i) => {
        const m = part.match(/^\[([^\]]+)\]$/);
        if (!m) return part;
        const v = (vals[normVar(m[1]!)] ?? "").trim();
        return v ? <mark key={i} className="var-filled">{v}</mark> : <span key={i} className="var-token">{part}</span>;
      })}
    </>
  );
}

function PromptDetail({ p, showRank, onClose }: { p: PromptDTO; showRank: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { requireAuth } = useAuth();
  const [vals, setVals] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  const [copies, setCopies] = useState(p.copyCount);
  const [err, setErr] = useState("");
  useEffect(() => setCopies(p.copyCount), [p.copyCount]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["vault"] });
  const onError = (e: Error) => { setErr(e.message); setTimeout(() => setErr(""), 4000); };
  const copyMut = useMutation({ mutationFn: () => api.recordCopy(p.id), onSuccess: (r) => setCopies(r.copyCount) });
  const saveMut = useMutation({ mutationFn: () => api.toggleSave(p.id), onSuccess: refresh, onError });
  const voteMut = useMutation({ mutationFn: (worked: boolean) => api.vote(p.id, worked), onSuccess: refresh, onError });

  const doCopy = async () => {
    await copyText(fillPrompt(p, vals));
    setCopied(true);
    copyMut.mutate();
    setTimeout(() => setCopied(false), 1800);
  };
  const filled = p.variables.filter((v) => (vals[v] ?? "").trim()).length;
  const myVote = voteMut.isPending ? (voteMut.variables ? "worked" : "failed") : p.myVote;
  const saved = saveMut.isPending ? !p.saved : p.saved;
  const bars: [string, number, string][] = showRank
    ? [["Semantic", p.score.semantic, "45%"], ["Keyword", p.score.keyword, "20%"], ["Success", p.score.success, "20%"], ["Viral", p.score.viral, "10%"], ["Freshness", p.score.freshness, "5%"]]
    : [["Viral", p.score.viral, "55%"], ["Success", p.score.success, "30%"], ["Freshness", p.score.freshness, "15%"]];

  return (
    <article className="flex flex-col h-full" aria-labelledby="detail-title">
      <header className="detail-head">
        <div className="min-w-0">
          <p className="eyebrow">{p.collection} · {p.category}</p>
          <h2 id="detail-title" className="font-display text-xl font-bold leading-tight mt-1">{p.title}</h2>
          <p className="text-[13px] text-[var(--dim)] mt-1.5 tabular-nums">
            {p.tool} · {p.totalVotes > 0 ? `${p.successRate}% of ${fmt(p.totalVotes)} said it worked` : "No votes yet"} · {fmt(copies)} copies
          </p>
        </div>
        <Button variant="ghost" label="Close" onClick={onClose} className="shrink-0 -mr-2"><Icon name="close" /></Button>
      </header>

      <div className="detail-body">
        <section>
          <div className="flex items-center justify-between mb-2">
            <h3 className="section-label">Prompt</h3>
            {p.variables.length > 0 && <span className="text-xs text-[var(--dim)] tabular-nums">{filled}/{p.variables.length} filled</span>}
          </div>
          <p className="prompt-box"><PromptText p={p} vals={vals} /></p>
        </section>

        {p.variables.length > 0 && (
          <section className="mt-5">
            <h3 className="section-label mb-2">Your details</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-2.5">
              {p.variables.map((v) => {
                const id = `var-${p.id}-${v}`;
                return (
                  <label key={v} htmlFor={id} className="block min-w-0">
                    <span className="block text-xs font-medium text-[var(--dim)] mb-1">{varLabel(p, v)}</span>
                    <input id={id} maxLength={2000} value={vals[v] ?? ""} onChange={(e) => setVals({ ...vals, [v]: e.target.value })} className="field" />
                  </label>
                );
              })}
            </div>
          </section>
        )}

        <details className="mt-5 group">
          <summary className="summary">
            <span className="section-label">Why it ranks here</span>
            <span className="ml-auto tabular-nums text-xs text-[var(--dim)]">Score {p.score.final}</span>
            <Icon name="chevron" className="size-4 text-[var(--dim)] transition-transform group-open:rotate-180" />
          </summary>
          <div className="mt-3 space-y-2">
            {bars.map(([label, val, w]) => (
              <div key={label} className="grid grid-cols-[88px_1fr_28px] items-center gap-3 text-xs">
                <span>{label} <span className="text-[var(--dim)]">{w}</span></span>
                <span className="h-1.5 rounded-full bg-[var(--surface2)] overflow-hidden"><span className="block h-full bg-[var(--text)]" style={{ width: `${val}%` }} /></span>
                <span className="text-right tabular-nums">{val}</span>
              </div>
            ))}
          </div>
        </details>
      </div>

      <footer className="detail-foot">
        <div className="flex gap-2">
          <Button variant="primary" onClick={doCopy} className="flex-1">
            <Icon name={copied ? "check" : "copy"} /> {copied ? "Copied" : filled > 0 ? "Copy filled prompt" : "Copy prompt"}
          </Button>
          <Button onClick={() => { if (requireAuth("Sign in to save prompts to your vault.")) saveMut.mutate(); }} pressed={saved} label={saved ? "Remove from saved" : "Save"}>
            <Icon name="bookmark" filled={saved} /> <span className="hidden sm:inline">{saved ? "Saved" : "Save"}</span>
          </Button>
        </div>
        <div className="flex items-center gap-2 mt-3 text-[13px]">
          <span className="text-[var(--dim)] mr-auto">{err ? <span role="alert" className="text-[var(--danger)]">{err}</span> : "Did it work for you?"}</span>
          <div className="segmented" role="group" aria-label="Did it work?">
            <button type="button" aria-pressed={myVote === "worked"} onClick={() => { if (requireAuth("Sign in to vote on prompts.")) voteMut.mutate(true); }}>Worked</button>
            <button type="button" aria-pressed={myVote === "failed"} onClick={() => { if (requireAuth("Sign in to vote on prompts.")) voteMut.mutate(false); }}>Didn't</button>
          </div>
        </div>
      </footer>
    </article>
  );
}

// ---------- sidebar filters -------------------------------------------------------
function Filters({ collections, collection, category, onCollection, onCategory }: {
  collections: CollectionInfo[]; collection: string; category: string; onCollection: (c: string) => void; onCategory: (c: string) => void;
}) {
  const total = collections.reduce((a, c) => a + c.count, 0);
  const active = collections.find((c) => c.name === collection);
  return (
    <>
      {/* Desktop: list */}
      <nav aria-label="Collections" className="hidden lg:block">
        <p className="section-label mb-2 px-2">Collections</p>
        <ul className="space-y-px">
          <li><button type="button" className={`side-item ${collection === ALL ? "is-active" : ""}`} onClick={() => onCollection(ALL)}><span>All prompts</span><span className="count">{total}</span></button></li>
          {collections.map((c) => (
            <li key={c.name}>
              <button type="button" className={`side-item ${collection === c.name ? "is-active" : ""}`} onClick={() => onCollection(c.name)}>
                <span>{c.name}</span><span className="count">{c.count}</span>
              </button>
              {collection === c.name && (
                <ul className="mt-px mb-2 ml-2 pl-2 border-l border-[var(--border)] space-y-px">
                  <li><button type="button" className={`side-item side-sub ${category === ALL ? "is-active" : ""}`} onClick={() => onCategory(ALL)}><span>All categories</span></button></li>
                  {c.categories.map((cat) => (
                    <li key={cat.name}>
                      <button type="button" className={`side-item side-sub ${category === cat.name ? "is-active" : ""}`} onClick={() => onCategory(cat.name)}>
                        <span className="truncate">{cat.name}</span><span className="count">{cat.count}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </nav>

      {/* Mobile: two selects */}
      <div className="grid grid-cols-2 gap-2 lg:hidden">
        <label className="min-w-0">
          <span className="sr-only">Collection</span>
          <select value={collection} onChange={(e) => onCollection(e.target.value)} className="field">
            <option value={ALL}>All prompts ({total})</option>
            {collections.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.count})</option>)}
          </select>
        </label>
        <label className="min-w-0">
          <span className="sr-only">Category</span>
          <select value={category} onChange={(e) => onCategory(e.target.value)} disabled={!active} className="field">
            <option value={ALL}>All categories</option>
            {active?.categories.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.count})</option>)}
          </select>
        </label>
      </div>
    </>
  );
}

// ---------- secondary views -------------------------------------------------------
function SubmitView({ collections }: { collections: CollectionInfo[] }) {
  const qc = useQueryClient();
  const { user, signIn } = useAuth();
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [category, setCategory] = useState("Other");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const subs = useQuery({ queryKey: ["subs", user?.id], queryFn: api.mySubmissions, enabled: !!user });
  const submitMut = useMutation({
    mutationFn: () => api.submit(url.trim(), note.trim(), category),
    onSuccess: () => {
      setMsg("Added to the review queue.");
      setUrl(""); setNote("");
      qc.invalidateQueries({ queryKey: ["subs", user?.id] });
      qc.invalidateQueries({ queryKey: ["vault"] });
    },
    onError: (e: Error) => setErr(e.message || "Could not submit. Check the link and try again."),
  });

  return (
    <div className="grid gap-6 lg:grid-cols-2 max-w-5xl">
      <section className="panel">
        <p className="eyebrow">Recommended</p>
        <h2 className="font-display text-lg font-bold mt-1">Analyze a post with the browser extension</h2>
        <p className="text-sm text-[var(--dim)] mt-1.5">Finds the prompt in an Instagram reel or post, or a LinkedIn post, straight from the page. If someone analysed it before, you get the result instantly.</p>
        <ol className="steps mt-4">
          <li><span>Open the reel or post on desktop Chrome.</span></li>
          <li><span>Click the PromptVault icon in the toolbar.</span></li>
          <li><span>Press <b>Analyze this post</b>. Nothing is read until you do.</span></li>
        </ol>
        <p className="text-xs text-[var(--dim)] mt-4 pt-4 border-t border-[var(--border)]">Chrome Web Store listing and mobile app: coming soon.</p>
      </section>

      <section className="panel">
        <p className="eyebrow">Or paste a link</p>
        <h2 className="font-display text-lg font-bold mt-1">Send us a post to review</h2>
        {!user ? (
          <div className="mt-4">
            <p className="text-sm text-[var(--dim)]">Sign in to submit links and follow their review status. Only you and the reviewers can see what you submit.</p>
            <Button variant="primary" className="w-full mt-4" onClick={() => signIn("Sign in to submit a post for review.")}>Sign in to submit</Button>
          </div>
        ) : (<>
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setErr(""); setMsg("");
            if (!/^https?:\/\/\S{4,}/i.test(url.trim())) { setErr("Paste a full link starting with https://"); return; }
            submitMut.mutate();
          }}
        >
          <label className="block">
            <span className="block text-xs font-medium text-[var(--dim)] mb-1">Post link</span>
            <input type="url" inputMode="url" maxLength={500} required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.instagram.com/reel/…" className="field" />
          </label>
          <div className="grid sm:grid-cols-2 gap-3">
            <label className="block min-w-0">
              <span className="block text-xs font-medium text-[var(--dim)] mb-1">Category</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)} className="field">
                <option value="Other">Not sure</option>
                {collections.map((c) => (
                  <optgroup key={c.name} label={c.name}>
                    {c.categories.map((cat) => <option key={cat.name} value={cat.name}>{cat.name}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
            <label className="block min-w-0">
              <span className="block text-xs font-medium text-[var(--dim)] mb-1">What was it for? <span className="opacity-70">(optional)</span></span>
              <input maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Saree product photo" className="field" />
            </label>
          </div>
          <Button type="submit" variant="primary" disabled={submitMut.isPending} className="w-full">{submitMut.isPending ? "Sending…" : "Submit for review"}</Button>
          {err && <p role="alert" className="text-sm text-[var(--danger)]">{err}</p>}
          {msg && <p role="status" className="text-sm text-[var(--ok)]">{msg}</p>}
        </form>
        {subs.data && subs.data.submissions.length > 0 && (
          <div className="mt-5 pt-4 border-t border-[var(--border)]">
            <p className="section-label mb-2">Your submissions</p>
            <ul className="divide-y divide-[var(--border)] text-[13px]">
              {subs.data.submissions.map((s) => (
                <li key={s.id} className="flex justify-between gap-3 py-2 min-w-0">
                  <span className="truncate font-prompt text-xs min-w-0 text-[var(--dim)]">{s.url}</span>
                  <span className={`shrink-0 status status-${s.status}`}>{STATUS_LABEL[s.status as SubmissionStatus] ?? s.status}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        </>)}
      </section>
    </div>
  );
}

function RankingView() {
  const rows: [string, string, string, string][] = [
    ["Semantic match", "45%", "—", "Understands intent and synonyms: “PRD” finds requirements docs, “for my shop” favours business prompts. Rare words count more than common ones."],
    ["Keyword match", "20%", "—", "Exact words and tool names such as Veo 3, Nano Banana, RICE or OKR."],
    ["Success rate", "20%", "30%", "Share of people who tried the prompt and said it worked. One vote per person, and you can change it."],
    ["Viral score", "10%", "55%", "How widely the original post spread. Each new post repeating the prompt adds to it."],
    ["Freshness", "5%", "15%", "A small lift for newer entries, fading over about three weeks."],
  ];
  return (
    <div className="max-w-3xl">
      <h2 className="font-display text-2xl font-bold">How ranking works</h2>
      <p className="text-[15px] text-[var(--dim)] mt-2">Every prompt gets a score from five signals. When you search, how well it matches matters most. When you browse, proven prompts rise. Copies and votes update the ranking for the next person.</p>
      <div className="panel mt-6 p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-[var(--dim)] border-b border-[var(--border)]">
              <th className="font-medium py-2.5 px-4">Signal</th>
              <th className="font-medium py-2.5 px-2 text-right">Search</th>
              <th className="font-medium py-2.5 px-2 text-right">Browse</th>
              <th className="font-medium py-2.5 px-4 hidden sm:table-cell">What it measures</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {rows.map(([s, a, b, d]) => (
              <tr key={s} className="align-top">
                <td className="py-3 px-4 font-medium">{s}<p className="sm:hidden text-xs text-[var(--dim)] font-normal mt-1">{d}</p></td>
                <td className="py-3 px-2 text-right tabular-nums">{a}</td>
                <td className="py-3 px-2 text-right tabular-nums text-[var(--dim)]">{b}</td>
                <td className="py-3 px-4 text-[var(--dim)] hidden sm:table-cell">{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-[var(--dim)] mt-4">Viral and success scores for the creator collection start from curated values. Votes and copies from real people update them. Saves and votes are tied to this browser, with no account and no personal data.</p>
    </div>
  );
}

// ---------- page ------------------------------------------------------------------
export function App() {
  const { user, ready, signIn } = useAuth();
  const pending = usePendingCounts(user?.role === "admin");
  const initial = useMemo(readUrl, []);
  const [view, setView] = useState<View>(initial.view);
  const [query, setQuery] = useState(initial.q);
  const [q, setQ] = useState(initial.q.trim());
  const [collection, setCollection] = useState(initial.collection);
  const [category, setCategory] = useState(initial.category);
  const [page, setPage] = useState(initial.page);
  const [pageSize, setPageSize] = useState(readPageSize);
  const [selectedId, setSelectedId] = useState<number | null>(initial.selected);
  const lastSelected = useRef<PromptDTO | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listTop = useRef<HTMLDivElement>(null);

  const isList = view === "browse" || view === "saved";
  const savedOnly = view === "saved";

  useEffect(() => writeUrl({ view, q, collection, category, page, selected: selectedId }), [view, q, collection, category, page, selectedId]);

  const vault = useQuery({
    // Keyed by user: one account's saved flags / votes are never served from another's cache.
    queryKey: ["vault", user?.id ?? "anon", q, collection, category, savedOnly, page, pageSize],
    enabled: ready && !(savedOnly && !user),
    queryFn: () => api.vault({ q, collection, category, savedOnly, offset: (page - 1) * pageSize, limit: pageSize }),
    placeholderData: keepPreviousData,
  });
  const data = vault.data;
  const prompts = useMemo(() => data?.prompts ?? [], [data]);
  const trending = data?.trending ?? [];
  const collections = data?.collections ?? [];
  const pages = data ? Math.max(1, Math.ceil(data.matched / pageSize)) : 1;
  const hasQuery = q.length > 0;

  const selected = useMemo(() => {
    const found = prompts.find((p) => p.id === selectedId) ?? trending.find((p) => p.id === selectedId)
      ?? (lastSelected.current?.id === selectedId ? lastSelected.current : null);
    if (found) lastSelected.current = found;
    return found;
  }, [prompts, trending, selectedId]);

  // Keep the page in range when filters shrink the result set.
  useEffect(() => { if (data && page > pages) setPage(pages); }, [data, page, pages]);

  const toTop = () => listTop.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  const goPage = (n: number) => { setPage(n); toTop(); };
  const resetPaging = () => { setPage(1); setSelectedId(null); };
  const search = (text: string) => { setQuery(text); setQ(text.trim()); resetPaging(); if (!isList) setView("browse"); };
  const pickCollection = (c: string) => { setCollection(c); setCategory(ALL); resetPaging(); };
  const pickCategory = (c: string) => { setCategory(c); resetPaging(); };
  const changeSize = (n: number) => {
    setPageSize(n);
    setPage(1);
    try { localStorage.setItem(SIZE_KEY, String(n)); } catch { /* private mode */ }
  };
  const switchView = (v: View) => { setView(v); setPage(1); setSelectedId(null); window.scrollTo({ top: 0 }); };

  // Keyboard: "/" search, j/k or arrows move through the list, Esc closes the detail.
  const move = useCallback((d: 1 | -1) => {
    if (!prompts.length) return;
    const i = prompts.findIndex((p) => p.id === selectedId);
    const next = prompts[Math.min(prompts.length - 1, Math.max(0, i === -1 ? 0 : i + d))]!;
    setSelectedId(next.id);
    document.querySelector(`[data-id="${next.id}"]`)?.scrollIntoView({ block: "nearest" });
  }, [prompts, selectedId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
      if (e.key === "Escape") { if (typing) t.blur(); else setSelectedId(null); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey || !isList) return;
      if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); move(1); }
      else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isList, move]);

  // The detail is a sheet below xl: lock page scroll while it's open.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1279px)");
    const lock = !!selected && isList && mq.matches;
    document.documentElement.style.overflow = lock ? "hidden" : "";
    return () => { document.documentElement.style.overflow = ""; };
  }, [selected, isList]);

  const from = data && data.matched > 0 ? (page - 1) * pageSize + 1 : 0;
  const to = data ? Math.min(data.matched, page * pageSize) : 0;

  return (
    <div className="min-h-screen">
      {/* HEADER */}
      <header className="site-header">
        <div className="mx-auto max-w-[1440px] px-4 lg:px-6">
          <div className="flex items-center gap-4 h-14">
            <button type="button" onClick={() => { search(""); switchView("browse"); pickCollection(ALL); }} className="wordmark">PromptVault</button>
            <form role="search" onSubmit={(e) => { e.preventDefault(); search(query); }} className="search">
              <Icon name="search" className="size-4 text-[var(--dim)] shrink-0" />
              <label className="sr-only" htmlFor="search">Search prompts</label>
              <input
                id="search"
                ref={searchRef}
                type="search"
                maxLength={200}
                value={query}
                onChange={(e) => { setQuery(e.target.value); if (!e.target.value) search(""); }}
                placeholder="Search prompts, e.g. product photo for my shop"
                className="flex-1 min-w-0 bg-transparent outline-none text-[15px]"
              />
              <kbd className="kbd hidden sm:inline">/</kbd>
            </form>
            <div className="ml-auto"><AccountMenu onOpenAdmin={() => switchView("admin")} /></div>
          </div>
          <nav aria-label="Sections" className="tabs">
            {VIEWS.filter((v) => !v.admin || user?.role === "admin").map((v) => (
              <button key={v.id} type="button" onClick={() => switchView(v.id)} aria-current={view === v.id ? "page" : undefined} className={v.admin ? "tab tab-admin" : "tab"}>
                {v.label}
                {v.admin && pending.total > 0 && <span className="tab-count" aria-label={`${pending.total} waiting for review`}>{pending.total}</span>}
                {v.id === "saved" && data && data.stats.savedCount > 0 && <span className="tab-count">{data.stats.savedCount}</span>}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px] px-4 lg:px-6 py-6">
        {view === "submit" && <SubmitView collections={collections} />}
        {view === "ranking" && <RankingView />}
        {view === "admin" && (user?.role === "admin" ? <AdminView /> : ready && (
          <div className="empty max-w-xl">
            <p className="font-semibold">Admins only</p>
            <p className="text-sm text-[var(--dim)] mt-1">{user ? "Your account doesn't have admin access." : <>Please <button type="button" className="link" onClick={() => signIn("Sign in with an admin account.")}>sign in</button> with an admin account.</>}</p>
          </div>
        ))}

        {view === "saved" && ready && !user && (
          <div className="empty max-w-xl">
            <p className="font-semibold">Your saved prompts live in your account</p>
            <p className="text-sm text-[var(--dim)] mt-1">Sign in to see and keep prompts across devices.</p>
            <Button variant="primary" className="mt-4" onClick={() => signIn("Sign in to see your saved prompts.")}>Sign in</Button>
          </div>
        )}

        {isList && !(savedOnly && !user) && (
          <div className="layout">
            <aside className="sidebar">
              <Filters collections={collections} collection={collection} category={category} onCollection={pickCollection} onCategory={pickCategory} />
              {data && (
                <dl className="hidden lg:grid stats">
                  <div><dt>Prompts</dt><dd>{fmt(data.stats.total)}</dd></div>
                  <div><dt>Copies</dt><dd>{fmt(data.stats.totalCopies)}</dd></div>
                  <div><dt>In review</dt><dd>{fmt(data.stats.submissions)}</dd></div>
                </dl>
              )}
            </aside>

            <section className="min-w-0" aria-live="polite">
              <div ref={listTop} className="scroll-mt-32" />

              {view === "browse" && !hasQuery && page === 1 && collection === ALL && trending.length > 0 && (
                <div className="mb-5">
                  <p className="section-label mb-2">Trending this week</p>
                  <ol className="trending">
                    {trending.map((p, i) => (
                      <li key={p.id}>
                        <button type="button" onClick={() => setSelectedId(p.id)} className={selectedId === p.id ? "is-selected" : ""}>
                          <span className="tabular-nums text-[var(--dim)] text-xs">{String(i + 1).padStart(2, "0")}</span>
                          <span className="min-w-0">
                            <span className="block font-medium text-sm truncate">{p.title}</span>
                            <span className="block text-xs text-[var(--dim)] truncate">{p.tool} · {p.successRate}% worked</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {/* Toolbar */}
              <div className="toolbar">
                <p className="text-sm text-[var(--dim)] min-w-0">
                  {data ? (
                    hasQuery
                      ? <>Results for <b className="text-[var(--text)] font-semibold">“{q}”</b> <span className="tabular-nums">· {fmt(data.matched)}</span></>
                      : <><span className="tabular-nums">{fmt(data.matched)}</span> {savedOnly ? "saved" : ""} prompt{data.matched === 1 ? "" : "s"}{!savedOnly && <span className="hidden sm:inline"> · best performers first</span>}</>
                  ) : "Loading…"}
                </p>
                <label className="flex items-center gap-2 text-sm text-[var(--dim)] shrink-0 whitespace-nowrap">
                  Per page
                  <select value={pageSize} onChange={(e) => changeSize(Number(e.target.value))} className="field field-sm w-auto">
                    {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
              </div>

              {!hasQuery && view === "browse" && page === 1 && (
                <p className="hidden sm:block text-[13px] text-[var(--dim)] mb-3 -mt-1">
                  Try:{" "}
                  {(QUICK[collection] ?? QUICK[ALL]!).map((t, i) => (
                    <span key={t}>{i > 0 && <span aria-hidden="true"> · </span>}<button type="button" onClick={() => search(t)} className="link">{t}</button></span>
                  ))}
                </p>
              )}

              {vault.isPending && <p className="py-16 text-center text-[var(--dim)]">Loading prompts…</p>}
              {vault.isError && (
                <div className="py-16 text-center">
                  <p>Couldn't load prompts. {vault.error.message}</p>
                  <Button onClick={() => vault.refetch()} className="mt-3">Try again</Button>
                </div>
              )}
              {data && prompts.length === 0 && (
                <div className="empty">
                  {savedOnly && data.stats.savedCount > 0 ? (
                    <>
                      <p className="font-semibold">None of your {data.stats.savedCount} saved prompts match these filters</p>
                      <p className="text-sm text-[var(--dim)] mt-1">
                        <button type="button" className="link" onClick={() => { search(""); pickCollection(ALL); }}>Clear search and filters</button>
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="font-semibold">{savedOnly ? "Nothing saved yet" : "No prompt matches"}</p>
                      <p className="text-sm text-[var(--dim)] mt-1">
                        {savedOnly ? "Open any prompt and press Save to keep it here." : <>Try other words, or <button type="button" className="link" onClick={() => switchView("submit")}>submit the post</button> you saw it in.</>}
                      </p>
                    </>
                  )}
                </div>
              )}

              {prompts.length > 0 && <ul className={`list ${vault.isPlaceholderData ? "opacity-60" : ""}`}>
                {prompts.map((p) => (
                  <PromptRow key={p.id} p={p} selected={p.id === selectedId} showRank={hasQuery} onSelect={() => setSelectedId(p.id === selectedId ? null : p.id)} />
                ))}
              </ul>}

              {data && data.matched > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-3 mt-4">
                  <p className="text-sm text-[var(--dim)] tabular-nums">{fmt(from)}–{fmt(to)} of {fmt(data.matched)}</p>
                  <Pagination page={page} pages={pages} onPage={goPage} />
                </div>
              )}
            </section>

            {/* Detail: a column on xl screens, a sheet below. */}
            {selected && <div className="sheet-backdrop" onClick={() => setSelectedId(null)} aria-hidden="true" />}
            <aside className={`detail ${selected ? "is-open" : ""}`} aria-label="Prompt details">
              {selected ? (
                <PromptDetail key={selected.id} p={selected} showRank={hasQuery} onClose={() => setSelectedId(null)} />
              ) : (
                <div className="detail-empty">
                  <p className="font-medium text-[var(--text)]">Select a prompt</p>
                  <p className="mt-1">Fill in your details, copy it, and tell others whether it worked.</p>
                  <p className="mt-4 text-xs"><kbd className="kbd">j</kbd> <kbd className="kbd">k</kbd> move · <kbd className="kbd">/</kbd> search · <kbd className="kbd">Esc</kbd> close</p>
                </div>
              )}
            </aside>
          </div>
        )}
      </main>
    </div>
  );
}
