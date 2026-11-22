import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ImportDefaults, type ImportResult, type ImportRowResult } from "./api";
import { CSV_TEMPLATE, FIELDS, JSON_TEMPLATE, detectVariables, download, parseImport, type Parsed } from "./import-format";

const GUIDE_URL = "https://github.com/SadanandaPaul89/promptvault/blob/main/docs/IMPORTING-PROMPTS.md";
const KNOWN_TOOLS = ["Any AI", "ChatGPT", "Claude", "Gemini", "Nano Banana", "ChatGPT Image", "Midjourney", "Veo 3", "Kling"];
const fmtDate = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Existing collections and their categories, for the pickers. */
export function useCatalog() {
  const q = useQuery({
    queryKey: ["admin-catalog"],
    queryFn: () => api.vault({ q: "", collection: "All", category: "All", savedOnly: false, offset: 0, limit: 1 }),
    staleTime: 60_000,
  });
  return q.data?.collections ?? [];
}

export function useAfterChange() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["vault"] });
    qc.invalidateQueries({ queryKey: ["admin-catalog"] });
    qc.invalidateQueries({ queryKey: ["admin-recent-prompts"] });
  };
}

export function AddPrompts() {
  const [mode, setMode] = useState<"single" | "bulk">("single");
  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="segmented" role="tablist" aria-label="How to add">
          <button type="button" role="tab" aria-selected={mode === "single"} aria-pressed={mode === "single"} onClick={() => setMode("single")}>One prompt</button>
          <button type="button" role="tab" aria-selected={mode === "bulk"} aria-pressed={mode === "bulk"} onClick={() => setMode("bulk")}>Bulk import (CSV / JSON)</button>
        </div>
        <a href={GUIDE_URL} target="_blank" rel="noopener noreferrer" className="link text-sm">Full import guide</a>
      </div>
      {mode === "single" ? <SingleForm /> : <BulkImport />}
      <RecentlyAdded />
    </section>
  );
}

// ---------------------------------------------------------------- shared pickers

export function CollectionFields({ value, onChange, idPrefix, requiredNote }: {
  value: ImportDefaults; onChange: (v: ImportDefaults) => void; idPrefix: string; requiredNote?: string;
}) {
  const collections = useCatalog();
  const cats = collections.find((c) => c.name === value.collection)?.categories.map((c) => c.name) ?? [...new Set(collections.flatMap((c) => c.categories.map((x) => x.name)))];
  const isNew = !!value.collection && !collections.some((c) => c.name === value.collection);
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="block">
        <span className="block text-xs font-medium text-[var(--dim)] mb-1">Collection{requiredNote}</span>
        <input list={`${idPrefix}-collections`} value={value.collection ?? ""} onChange={(e) => onChange({ ...value, collection: e.target.value })} maxLength={60} className="field" placeholder="Pick or type a new one" />
        <datalist id={`${idPrefix}-collections`}>{collections.map((c) => <option key={c.name} value={c.name}>{c.count} prompts</option>)}</datalist>
        {isNew && <span className="block text-xs text-[var(--dim)] mt-1">New collection: it appears in the sidebar after the first prompt is added.</span>}
      </label>
      <label className="block">
        <span className="block text-xs font-medium text-[var(--dim)] mb-1">Category{requiredNote}</span>
        <input list={`${idPrefix}-categories`} value={value.category ?? ""} onChange={(e) => onChange({ ...value, category: e.target.value })} maxLength={60} className="field" placeholder="e.g. Sales" />
        <datalist id={`${idPrefix}-categories`}>{cats.map((c) => <option key={c} value={c} />)}</datalist>
      </label>
      <label className="block">
        <span className="block text-xs font-medium text-[var(--dim)] mb-1">Tool</span>
        <input list={`${idPrefix}-tools`} value={value.tool ?? ""} onChange={(e) => onChange({ ...value, tool: e.target.value })} maxLength={40} className="field" placeholder="Any AI" />
        <datalist id={`${idPrefix}-tools`}>{KNOWN_TOOLS.map((t) => <option key={t} value={t} />)}</datalist>
      </label>
    </div>
  );
}

export function VariableChips({ prompt }: { prompt: string }) {
  const vars = detectVariables(prompt);
  if (!prompt.trim()) return null;
  return (
    <p className="text-xs text-[var(--dim)] mt-1.5">
      {vars.length === 0
        ? <>No fill-in fields yet. Wrap anything the user should change in square brackets, like <code>[TOPIC]</code>.</>
        : <>Fill-in fields: {vars.map((v) => <span key={v} className="var-chip">{v}</span>)}</>}
    </p>
  );
}

function RowMessages({ r }: { r: ImportRowResult }) {
  return (
    <>
      {r.errors.map((e, i) => <p key={`e${i}`} className={r.status === "duplicate" ? "text-[var(--dim)]" : "text-[var(--danger)]"}>{e}</p>)}
      {r.warnings.map((w, i) => <p key={`w${i}`} className="text-[var(--warn)]">{w}</p>)}
    </>
  );
}

// ---------------------------------------------------------------- one prompt

function SingleForm() {
  const after = useAfterChange();
  const [where, setWhere] = useState<ImportDefaults>({ collection: "", category: "", tool: "" });
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [tags, setTags] = useState("");
  const [result, setResult] = useState<ImportRowResult | null>(null);
  const mut = useMutation({
    mutationFn: () => api.importPrompts([{ title, masterPrompt: prompt, useCases: tags, ...where }], {}, false),
    onSuccess: (r) => {
      const row = r.rows[0]!;
      setResult(row);
      if (row.status === "new") { setTitle(""); setPrompt(""); setTags(""); after(); }
    },
  });

  return (
    <form className="panel space-y-4" onSubmit={(e) => { e.preventDefault(); setResult(null); mut.mutate(); }}>
      <CollectionFields value={where} onChange={setWhere} idPrefix="one" requiredNote=" *" />
      <label className="block">
        <span className="block text-xs font-medium text-[var(--dim)] mb-1">Title *</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required className="field" placeholder="e.g. LinkedIn hook writer" />
      </label>
      <label className="block">
        <span className="block text-xs font-medium text-[var(--dim)] mb-1">Master prompt *</span>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={8000} required rows={6} className="field font-prompt text-[13px]" placeholder="Write 5 scroll-stopping LinkedIn hooks about [TOPIC] for [AUDIENCE]." />
        <VariableChips prompt={prompt} />
      </label>
      <label className="block">
        <span className="block text-xs font-medium text-[var(--dim)] mb-1">Search keywords <span className="opacity-70">(optional, separate with |)</span></span>
        <input value={tags} onChange={(e) => setTags(e.target.value)} maxLength={600} className="field" placeholder="linkedin | hooks | personal brand" />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="btn btn-primary" disabled={mut.isPending}>{mut.isPending ? "Adding…" : "Add prompt"}</button>
        {mut.isError && <span role="alert" className="text-sm text-[var(--danger)]">{mut.error.message}</span>}
        {result?.status === "new" && <span role="status" className="text-sm text-[var(--ok)]">Added “{result.title}”. It's live in {result.collection} now.</span>}
      </div>
      {result && result.status !== "new" && <div role="alert" className="text-sm"><RowMessages r={result} /></div>}
    </form>
  );
}

// ---------------------------------------------------------------- bulk import

function FormatGuide() {
  return (
    <details className="panel" open>
      <summary className="font-semibold cursor-pointer">Format guide</summary>
      <div className="mt-3 space-y-4 text-sm">
        <p className="text-[var(--dim)]">
          Upload a <b>CSV</b> (from Excel or Google Sheets: File → Download → CSV) or a <b>JSON</b> array. One prompt per row; the first CSV row names the columns.
          Up to 1,000 prompts per file. Nothing is saved until you review the check and press Import.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] min-w-[560px]">
            <thead>
              <tr className="text-left text-xs text-[var(--dim)] border-b border-[var(--border)]">
                <th className="font-medium py-2 pr-3">Column</th><th className="font-medium py-2 pr-3">Required</th>
                <th className="font-medium py-2 pr-3">What it is</th><th className="font-medium py-2">Example</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)] align-top">
              {FIELDS.map((f) => (
                <tr key={f.name}>
                  <td className="py-2 pr-3 whitespace-nowrap"><code>{f.name}</code>{f.aliases && <span className="block text-xs text-[var(--dim)]">or {f.aliases}</span>}</td>
                  <td className="py-2 pr-3">{f.required === "yes*" ? "Yes, or set a default below" : f.required === "yes" ? "Yes" : "No"}</td>
                  <td className="py-2 pr-3 text-[var(--dim)]">{f.description}</td>
                  <td className="py-2 font-prompt text-xs">{f.example}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="list-disc pl-5 space-y-1 text-[var(--dim)]">
          <li><b>Fill-in fields:</b> <code>[TOPIC]</code> or <code>[product name]</code>. Square brackets only; <code>{"{{curly}}"}</code> placeholders are flagged.</li>
          <li><b>CSV text with commas or line breaks</b> must be in double quotes (Excel and Sheets do this for you). A quote inside quotes is written twice: <code>""</code>.</li>
          <li><b>Duplicates are skipped:</b> a prompt whose text is already in the vault, or repeated in the file, isn't added again. Re-importing a file is safe.</li>
          <li>Column names are not case-sensitive and unknown columns are ignored (you'll see a warning).</li>
        </ul>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => download("promptvault-template.csv", CSV_TEMPLATE, "text/csv")}>Download CSV template</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => download("promptvault-template.json", JSON_TEMPLATE, "application/json")}>Download JSON template</button>
        </div>
      </div>
    </details>
  );
}

function BulkImport() {
  const after = useAfterChange();
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [defaults, setDefaults] = useState<ImportDefaults>({ collection: "", category: "", tool: "" });
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [parseError, setParseError] = useState("");
  const [check, setCheck] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [problemsOnly, setProblemsOnly] = useState(false);

  const reset = () => { setCheck(null); setDone(null); setParsed(null); setParseError(""); };

  const checkMut = useMutation({
    mutationFn: (p: Parsed) => api.importPrompts(p.rows, defaults, true),
    onSuccess: (r) => { setCheck(r); setProblemsOnly(r.summary.invalid + r.summary.duplicate > 0 && r.summary.total > 20); },
  });
  const importMut = useMutation({
    mutationFn: () => api.importPrompts(parsed!.rows, defaults, false),
    onSuccess: (r) => { setDone(r); setCheck(null); after(); },
  });

  const runCheck = () => {
    setCheck(null); setDone(null); setParseError("");
    try {
      const p = parseImport(text, fileName);
      setParsed(p);
      checkMut.mutate(p);
    } catch (e) {
      setParsed(null);
      setParseError((e as Error).message);
    }
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 3_000_000) { setParseError("That file is over 3 MB. Split it into smaller files."); return; }
    reset();
    setFileName(f.name);
    setText(await f.text());
  };

  const shown = useMemo(() => (check ? check.rows.filter((r) => !problemsOnly || r.status !== "new" || r.warnings.length > 0) : []), [check, problemsOnly]);

  if (done) {
    return (
      <div className="panel">
        <p className="font-semibold text-[var(--ok)]">Imported {done.summary.imported} prompt{done.summary.imported === 1 ? "" : "s"}.</p>
        <p className="text-sm text-[var(--dim)] mt-1">
          {done.summary.duplicate > 0 && `${done.summary.duplicate} duplicate${done.summary.duplicate === 1 ? "" : "s"} skipped. `}
          {done.summary.invalid > 0 && `${done.summary.invalid} row${done.summary.invalid === 1 ? "" : "s"} with errors skipped: fix them in your file and import it again (already-added prompts are skipped automatically).`}
          {done.summary.duplicate + done.summary.invalid === 0 && "They're live in the vault now."}
        </p>
        <button type="button" className="btn btn-secondary mt-4" onClick={() => { reset(); setText(""); setFileName(""); }}>Import another file</button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {!check && <FormatGuide />}

      <div className="panel space-y-4">
        <div>
          <p className="section-label mb-2">1 · Your file</p>
          <div className="flex flex-wrap items-center gap-3">
            <input ref={fileRef} type="file" accept=".csv,.json,.txt,text/csv,application/json" className="hidden" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ""; }} />
            <button type="button" className="btn btn-secondary" onClick={() => fileRef.current?.click()}>Choose CSV or JSON file</button>
            <span className="text-sm text-[var(--dim)]">{fileName ? `Loaded ${fileName}` : "or paste below"}</span>
          </div>
          <textarea
            value={text}
            onChange={(e) => { setText(e.target.value); setFileName(""); setCheck(null); }}
            rows={7}
            spellCheck={false}
            className="field font-prompt text-xs mt-3"
            placeholder={"title,masterPrompt,category,collection\nLinkedIn hook writer,\"Write 5 hooks about [TOPIC]\",Writing,Creator Toolkit"}
            aria-label="Paste CSV or JSON"
          />
        </div>

        <div>
          <p className="section-label mb-1">2 · Defaults <span className="normal-case tracking-normal font-normal">(used when a row leaves the column empty)</span></p>
          <CollectionFields value={defaults} onChange={(d) => { setDefaults(d); setCheck(null); }} idPrefix="bulk" />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn btn-primary" disabled={!text.trim() || checkMut.isPending} onClick={runCheck}>
            {checkMut.isPending ? "Checking…" : "3 · Check file"}
          </button>
          <span className="text-sm text-[var(--dim)]">Nothing is saved yet.</span>
        </div>
        {(parseError || checkMut.isError) && <p role="alert" className="text-sm text-[var(--danger)]">{parseError || checkMut.error?.message}</p>}
      </div>

      {check && (
        <div className="panel space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold mr-2">Check: {check.summary.total} row{check.summary.total === 1 ? "" : "s"}{parsed && ` (${parsed.format.toUpperCase()})`}</p>
            <span className="status status-added">{check.summary.new} ready</span>
            {check.summary.duplicate > 0 && <span className="status">{check.summary.duplicate} duplicate</span>}
            {check.summary.invalid > 0 && <span className="status status-rejected">{check.summary.invalid} with errors</span>}
            <label className="ml-auto text-sm text-[var(--dim)] flex items-center gap-2">
              <input type="checkbox" checked={problemsOnly} onChange={(e) => setProblemsOnly(e.target.checked)} /> Only rows needing attention
            </label>
          </div>

          <div className="overflow-x-auto border border-[var(--border)] rounded-lg max-h-[480px] overflow-y-auto">
            <table className="w-full text-[13px] min-w-[640px]">
              <thead className="sticky top-0 bg-[var(--surface)]">
                <tr className="text-left text-xs text-[var(--dim)] border-b border-[var(--border)]">
                  <th className="font-medium py-2 px-3 w-12">Row</th>
                  <th className="font-medium py-2 px-3">Prompt</th>
                  <th className="font-medium py-2 px-3">Where</th>
                  <th className="font-medium py-2 px-3">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)] align-top">
                {shown.map((r) => (
                  <tr key={r.row}>
                    <td className="py-2 px-3 tabular-nums text-[var(--dim)]">{r.row}</td>
                    <td className="py-2 px-3">
                      <p className="font-medium">{r.title || <span className="text-[var(--dim)]">(no title)</span>}</p>
                      {r.variables.length > 0 && <p className="mt-1">{r.variables.map((v) => <span key={v} className="var-chip">{v}</span>)}</p>}
                    </td>
                    <td className="py-2 px-3 text-[var(--dim)]">{[r.collection, r.category, r.tool].filter(Boolean).join(" · ")}</td>
                    <td className="py-2 px-3">
                      <span className={`status ${r.status === "new" ? "status-added" : r.status === "invalid" ? "status-rejected" : ""}`}>
                        {r.status === "new" ? "Ready" : r.status === "invalid" ? "Error" : "Duplicate"}
                      </span>
                      <div className="text-xs mt-1 space-y-0.5"><RowMessages r={r} /></div>
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && <tr><td colSpan={4} className="py-6 text-center text-[var(--dim)]">Every row is ready.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn btn-primary" disabled={check.summary.new === 0 || importMut.isPending} onClick={() => importMut.mutate()}>
              {importMut.isPending ? "Importing…" : `Import ${check.summary.new} prompt${check.summary.new === 1 ? "" : "s"}`}
            </button>
            {check.summary.invalid + check.summary.duplicate > 0 && check.summary.new > 0 && (
              <span className="text-sm text-[var(--dim)]">Rows with errors or duplicates are skipped.</span>
            )}
            <button type="button" className="btn btn-ghost" onClick={() => setCheck(null)}>Edit file</button>
            {importMut.isError && <span role="alert" className="text-sm text-[var(--danger)]">{importMut.error.message}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- recently added

function RecentlyAdded() {
  const after = useAfterChange();
  const q = useQuery({ queryKey: ["admin-recent-prompts"], queryFn: api.recentPrompts });
  const [confirm, setConfirm] = useState<number | null>(null);
  const del = useMutation({ mutationFn: (id: number) => api.deletePrompt(id), onSuccess: () => { setConfirm(null); after(); } });
  if (!q.data || q.data.prompts.length === 0) return null;
  return (
    <div className="mt-8">
      <p className="section-label mb-2">Recently added by admins</p>
      <ul className="panel p-0 divide-y divide-[var(--border)]">
        {q.data.prompts.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">{p.title}</p>
              <p className="text-xs text-[var(--dim)]">{p.collection} · {p.category} · {p.tool} · {fmtDate(p.createdAt)}</p>
            </div>
            {confirm === p.id ? (
              <span className="inline-flex items-center gap-2">
                <span className="text-xs text-[var(--dim)]">Delete for everyone?</span>
                <button type="button" className="btn btn-primary btn-sm" disabled={del.isPending} onClick={() => del.mutate(p.id)} aria-label={`Confirm delete ${p.title}`}>Delete</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>Cancel</button>
              </span>
            ) : (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm(p.id)} aria-label={`Delete ${p.title}`}>Delete</button>
            )}
          </li>
        ))}
      </ul>
      {del.isError && <p role="alert" className="text-sm text-[var(--danger)] mt-2">{del.error.message}</p>}
    </div>
  );
}
