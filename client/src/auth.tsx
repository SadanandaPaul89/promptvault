import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, setSessionLostHandler, type UserDTO } from "./api";

type AuthState = {
  user: UserDTO | null;
  ready: boolean;
  /** Opens the sign-in dialog. */
  signIn: (reason?: string) => void;
  /** True when signed in; otherwise opens the dialog and returns false. */
  requireAuth: (reason?: string) => boolean;
  signOut: (everywhere?: boolean) => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

/**
 * Drops every cached response except the session itself. Personal data is
 * keyed by user id as well, but clearing on every identity change guarantees
 * nothing from one account is ever rendered for another (or for a signed-out visitor).
 */
function switchIdentity(qc: QueryClient, user: UserDTO | null) {
  qc.cancelQueries();
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
  qc.setQueryData(["me"], { user });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: 5 * 60_000, retry: false });
  const [dialog, setDialog] = useState<{ reason?: string } | null>(null);
  const user = me.data?.user ?? null;

  useEffect(() => {
    setSessionLostHandler(() => switchIdentity(qc, null));
  }, [qc]);

  const signIn = useCallback((reason?: string) => setDialog({ reason }), []);
  const requireAuth = useCallback((reason?: string) => {
    if (user) return true;
    setDialog({ reason });
    return false;
  }, [user]);
  const signOut = useCallback(async (everywhere = false) => {
    try { await api.logout(everywhere); } finally { switchIdentity(qc, null); }
  }, [qc]);

  const value = useMemo(() => ({ user, ready: !me.isPending, signIn, requireAuth, signOut }), [user, me.isPending, signIn, requireAuth, signOut]);
  return (
    <AuthContext.Provider value={value}>
      {children}
      {dialog && (
        <AuthDialog
          reason={dialog.reason}
          onClose={() => setDialog(null)}
          onAuthed={(u) => { switchIdentity(qc, u); setDialog(null); }}
        />
      )}
    </AuthContext.Provider>
  );
}

function AuthDialog({ reason, onClose, onAuthed }: { reason?: string; onClose: () => void; onAuthed: (u: UserDTO) => void }) {
  const [mode, setMode] = useState<"signin" | "register">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, mode]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const r = mode === "signin" ? await api.login(email, password) : await api.register(email, password, name);
      onAuthed(r.user);
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="auth-title" className="modal">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="auth-title" className="font-display text-xl font-bold">{mode === "signin" ? "Sign in" : "Create your account"}</h2>
            <p className="text-sm text-[var(--dim)] mt-1">{reason ?? "Save prompts, vote, and track what you submit."}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="btn btn-ghost -mr-2 -mt-1">
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>

        <form onSubmit={submit} className="mt-5 space-y-3">
          {mode === "register" && (
            <label className="block">
              <span className="block text-xs font-medium text-[var(--dim)] mb-1">Name <span className="opacity-70">(optional)</span></span>
              <input ref={first} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="name" className="field" />
            </label>
          )}
          <label className="block">
            <span className="block text-xs font-medium text-[var(--dim)] mb-1">Email</span>
            <input ref={mode === "signin" ? first : undefined} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} autoComplete="email" className="field" />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-[var(--dim)] mb-1">Password {mode === "register" && <span className="opacity-70">(8+ characters)</span>}</span>
            <input type="password" required minLength={mode === "register" ? 8 : undefined} value={password} onChange={(e) => setPassword(e.target.value)} maxLength={200} autoComplete={mode === "signin" ? "current-password" : "new-password"} className="field" />
          </label>
          {err && <p role="alert" className="text-sm text-[var(--danger)]">{err}</p>}
          <button type="submit" disabled={busy} className="btn btn-primary w-full">{busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}</button>
        </form>

        <p className="text-sm text-[var(--dim)] mt-4 text-center">
          {mode === "signin" ? "New here? " : "Already have an account? "}
          <button type="button" className="link" onClick={() => { setMode(mode === "signin" ? "register" : "signin"); setErr(""); }}>
            {mode === "signin" ? "Create an account" : "Sign in"}
          </button>
        </p>
      </div>
    </div>
  );
}

export function AccountMenu({ onOpenAdmin }: { onOpenAdmin?: () => void }) {
  const { user, ready, signIn, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  if (!ready) return <span className="w-[72px]" aria-hidden="true" />;
  if (!user) return <button type="button" className="btn btn-secondary shrink-0" onClick={() => signIn()}>Sign in</button>;

  const initial = (user.name || user.email).charAt(0).toUpperCase();
  return (
    <div ref={ref} className="relative shrink-0">
      <button type="button" className="avatar" aria-haspopup="menu" aria-expanded={open} aria-label={`Account: ${user.email}`} onClick={() => setOpen(!open)}>
        {initial}
      </button>
      {open && (
        <div role="menu" className="menu">
          <div className="px-3 py-2.5 border-b border-[var(--border)]">
            <p className="text-sm font-medium truncate">{user.name || user.email}</p>
            <p className="text-xs text-[var(--dim)] truncate">{user.email}{user.role === "admin" && " · Admin"}</p>
          </div>
          {user.role === "admin" && onOpenAdmin && (
            <button type="button" role="menuitem" className="menu-item font-medium border-b border-[var(--border)]" onClick={() => { setOpen(false); onOpenAdmin(); }}>
              Admin panel: approve submissions
            </button>
          )}
          <button type="button" role="menuitem" className="menu-item" onClick={() => { setOpen(false); void signOut(false); }}>Sign out</button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => { setOpen(false); void signOut(true); }}>Sign out on all devices</button>
        </div>
      )}
    </div>
  );
}
