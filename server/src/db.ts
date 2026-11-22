import type { Client, Config, InArgs, InStatement, ResultSet, Transaction } from "@libsql/client";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
// Imported (not read from disk) so they're bundled into the serverless function.
import viralPrompts from "../seed/viral-prompts.json" with { type: "json" };
import pmLibrary from "../seed/pm-library-seed.json" with { type: "json" };

/** Seed data → collection name. Import a new JSON file and add it here to ship a new collection. */
export const SEED_COLLECTIONS: { collection: string; prompts: SeedPrompt[] }[] = [
  { collection: "Viral Creator Prompts", prompts: viralPrompts as SeedPrompt[] },
  { collection: "Product Management", prompts: pmLibrary as SeedPrompt[] },
];

export type SeedPrompt = {
  title: string;
  masterPrompt: string;
  category: string;
  section?: string;
  tool: string;
  useCases: string[];
  variables: string[];
  viralScore: number;
  copyCount: number;
  workedVotes: number;
  totalVotes: number;
  daysAgo: number;
};

export type PromptRow = {
  id: number;
  seed_key: string | null;
  title: string;
  master_prompt: string;
  collection: string;
  category: string;
  section: string;
  tool: string;
  use_cases: string;
  variables: string;
  viral_score: number;
  copy_count: number;
  worked_votes: number;
  total_votes: number;
  created_at: number;
};

const MIGRATIONS: string[] = [
  // v1
  `CREATE TABLE prompts (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     seed_key TEXT UNIQUE,
     title TEXT NOT NULL,
     master_prompt TEXT NOT NULL,
     collection TEXT NOT NULL,
     category TEXT NOT NULL,
     section TEXT NOT NULL DEFAULT '',
     tool TEXT NOT NULL,
     use_cases TEXT NOT NULL DEFAULT '[]',
     variables TEXT NOT NULL DEFAULT '[]',
     viral_score REAL NOT NULL DEFAULT 0,
     copy_count INTEGER NOT NULL DEFAULT 0,
     worked_votes INTEGER NOT NULL DEFAULT 0,
     total_votes INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX idx_prompts_collection ON prompts(collection, category);
   CREATE TABLE saves (
     visitor_id TEXT NOT NULL,
     prompt_id INTEGER NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (visitor_id, prompt_id)
   );
   CREATE TABLE votes (
     visitor_id TEXT NOT NULL,
     prompt_id INTEGER NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
     worked INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (visitor_id, prompt_id)
   );
   CREATE TABLE submissions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     visitor_id TEXT NOT NULL,
     url TEXT NOT NULL,
     note TEXT NOT NULL DEFAULT '',
     category TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     created_at INTEGER NOT NULL
   );
   CREATE INDEX idx_submissions_visitor ON submissions(visitor_id, id);`,
  // v2 — post analyzer cache (one row per canonical post; see canonical.ts).
  // Only derived text is stored, never media.
  `CREATE TABLE analyses (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     canonical_key TEXT NOT NULL UNIQUE,
     platform TEXT NOT NULL,
     source_url TEXT NOT NULL,
     creator TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL,
     post_text TEXT NOT NULL DEFAULT '',
     ocr_text TEXT NOT NULL DEFAULT '',
     transcript TEXT NOT NULL DEFAULT '',
     candidates TEXT NOT NULL DEFAULT '[]',
     prompt_ids TEXT NOT NULL DEFAULT '[]',
     request_count INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX idx_analyses_status ON analyses(status, id);
   CREATE TABLE analysis_requests (
     visitor_id TEXT NOT NULL,
     analysis_id INTEGER NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (visitor_id, analysis_id)
   );`,
  // v3 — accounts. Personal rows (saves, votes, submissions) are owned by
  // "u:{user id}" in their visitor_id column; anonymous rows keep the browser id
  // until claimed on sign-in.
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     email TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL DEFAULT '',
     password_hash TEXT NOT NULL,
     role TEXT NOT NULL DEFAULT 'user',
     created_at INTEGER NOT NULL,
     last_login_at INTEGER
   );
   CREATE TABLE sessions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     token_hash TEXT NOT NULL UNIQUE,
     family TEXT NOT NULL,
     expires_at INTEGER NOT NULL,
     revoked_at INTEGER,
     created_at INTEGER NOT NULL,
     user_agent TEXT NOT NULL DEFAULT ''
   );
   CREATE INDEX idx_sessions_user ON sessions(user_id);
   CREATE INDEX idx_sessions_family ON sessions(family);
   CREATE INDEX idx_submissions_status ON submissions(status, id);`,
];

export type AnalysisRow = {
  id: number;
  canonical_key: string;
  platform: string;
  source_url: string;
  creator: string;
  status: string;
  post_text: string;
  ocr_text: string;
  transcript: string;
  candidates: string;
  prompt_ids: string;
  request_count: number;
  created_at: number;
  updated_at: number;
};

// ---------------------------------------------------------------------------
// Database access. Locally this is a SQLite file; in production it's Turso
// (hosted libSQL) via TURSO_DATABASE_URL. Same client and same SQL either way.

export type Stmt = { sql: string; args?: unknown[] };
type Row = Record<string, unknown>;

/** libSQL rows → plain objects keyed by column name. */
function plain<T>(rs: ResultSet): T[] {
  return rs.rows.map((r) => {
    const o: Row = {};
    rs.columns.forEach((c, i) => { o[c] = r[i]; });
    return o as T;
  });
}

/** What both the database and a transaction can do. */
export interface Queryable {
  get<T>(sql: string, ...args: unknown[]): Promise<T | undefined>;
  all<T>(sql: string, ...args: unknown[]): Promise<T[]>;
  run(sql: string, ...args: unknown[]): Promise<{ changes: number }>;
}

function queryable(exec: (stmt: InStatement) => Promise<ResultSet>): Queryable {
  const go = (sql: string, args: unknown[]) => exec({ sql, args: args as InArgs });
  return {
    async get<T>(sql: string, ...args: unknown[]) { return plain<T>(await go(sql, args))[0]; },
    async all<T>(sql: string, ...args: unknown[]) { return plain<T>(await go(sql, args)); },
    async run(sql: string, ...args: unknown[]) { return { changes: (await go(sql, args)).rowsAffected }; },
  };
}

export type Db = Queryable & {
  /** Runs statements atomically in one round trip; returns each statement's rows. */
  batch<T = Row>(stmts: Stmt[], mode?: "write" | "read"): Promise<T[][]>;
  /** Interactive transaction, only for when later writes depend on earlier results. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Small in-process cache for hot, rarely-changing reads (the prompt catalog). */
  cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T>;
  invalidate(key: string): void;
  close(): void;
};

function wrap(client: Client): Db {
  const cache = new Map<string, { at: number; value: Promise<unknown> }>();
  return {
    ...queryable((s) => client.execute(s)),
    async batch<T>(stmts: Stmt[], mode: "write" | "read" = "write") {
      if (stmts.length === 0) return [];
      const out = await client.batch(stmts.map((s) => ({ sql: s.sql, args: (s.args ?? []) as InArgs })), mode);
      return out.map((rs) => plain<T>(rs));
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>) {
      const tx: Transaction = await client.transaction("write");
      try {
        const result = await fn(queryable((s) => tx.execute(s)));
        await tx.commit();
        return result;
      } catch (e) {
        await tx.rollback().catch(() => {});
        throw e;
      } finally {
        tx.close();
      }
    },
    cached<T>(key: string, ttlMs: number, load: () => Promise<T>) {
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
      const value = load();
      cache.set(key, { at: Date.now(), value });
      value.catch(() => cache.delete(key));
      return value;
    },
    invalidate(key: string) { cache.delete(key); },
    close() { client.close(); },
  };
}

export type DbConfig = { url: string; authToken?: string };

/** TURSO_DATABASE_URL (libsql://…) when set; otherwise a local SQLite file at DATABASE_PATH. */
export function dbConfigFromEnv(env: NodeJS.ProcessEnv, root: string): DbConfig {
  if (env.TURSO_DATABASE_URL) return { url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN || undefined };
  const path = resolveLocal(root, env.DATABASE_PATH ?? "data/promptvault.db");
  return { url: "file:" + path.replace(/\\/g, "/") };
}

function resolveLocal(root: string, p: string): string {
  return /^([A-Za-z]:[\\/]|\/)/.test(p) ? p : join(root, p);
}

export async function openDatabase(config: DbConfig | ":memory:"): Promise<Db> {
  const cfg: DbConfig = config === ":memory:" ? { url: ":memory:" } : config;
  const local = cfg.url.startsWith("file:");
  if (local) mkdirSync(dirname(cfg.url.slice("file:".length)), { recursive: true });
  const client = await connect(cfg);
  if (local) await client.executeMultiple("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  const db = wrap(client);
  await migrate(db);
  await seed(db);
  return db;
}

/**
 * Local files and :memory: use the full client (native SQLite). Remote databases
 * use the pure-JS HTTP client: no native binaries, and stateless HTTP suits
 * serverless functions.
 */
async function connect(cfg: DbConfig): Promise<Client> {
  if (cfg.url === ":memory:" || cfg.url.startsWith("file:")) {
    const { createClient } = await import("@libsql/client");
    return createClient(cfg);
  }
  const { createClient } = await import("@libsql/client/web");
  const url = cfg.url.replace(/^libsql:\/\//, "https://");
  return createClient({ url, authToken: cfg.authToken } satisfies Config);
}

const split = (sql: string): Stmt[] => sql.split(";").map((s) => s.trim()).filter(Boolean).map((sql) => ({ sql }));

/** Schema version lives in a meta table (PRAGMA user_version isn't available on every host). */
async function migrate(db: Db) {
  await db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const stored = await db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'");
  let version = stored ? Number(stored.value) : 0;
  if (!stored) {
    // Local databases created before the meta table tracked their version in user_version.
    try { version = Number((await db.get<{ user_version: number }>("PRAGMA user_version"))?.user_version ?? 0); } catch { version = 0; }
  }
  const setVersion = (v: number): Stmt => ({
    sql: "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    args: [String(v)],
  });
  for (let v = version; v < MIGRATIONS.length; v++) await db.batch([...split(MIGRATIONS[v]!), setVersion(v + 1)]);
  if (!stored && version >= MIGRATIONS.length) await db.batch([setVersion(version)]);
}

function seedKey(collection: string, s: SeedPrompt): string {
  return createHash("sha1").update(`${collection}\n${s.title}\n${s.masterPrompt}`).digest("hex");
}

/**
 * Idempotent: inserts seed prompts that aren't in the DB yet (matched by
 * content hash). Existing rows — and their real copies/votes — are never
 * overwritten. Skipped entirely when the seed files haven't changed since the
 * last run, so a cold start costs one query instead of hundreds of writes.
 */
export async function seed(db: Db): Promise<number> {
  const hash = createHash("sha256").update(JSON.stringify(SEED_COLLECTIONS)).digest("hex");
  const done = await db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'seed_hash'");
  if (done?.value === hash) return 0;

  const now = Date.now();
  const stmts: Stmt[] = [];
  for (const { collection, prompts } of SEED_COLLECTIONS) {
    for (const s of prompts) {
      stmts.push({
        sql: `INSERT OR IGNORE INTO prompts
                (seed_key, title, master_prompt, collection, category, section, tool, use_cases, variables,
                 viral_score, copy_count, worked_votes, total_votes, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        args: [
          seedKey(collection, s), s.title, s.masterPrompt, collection, s.category, s.section ?? s.category, s.tool,
          JSON.stringify(s.useCases ?? []), JSON.stringify(s.variables ?? []),
          s.viralScore ?? 0, s.copyCount ?? 0, s.workedVotes ?? 0, s.totalVotes ?? 0,
          now - (s.daysAgo ?? 0) * 86_400_000,
        ],
      });
    }
  }
  let added = 0;
  // Chunked so each request to a remote database stays small.
  for (let i = 0; i < stmts.length; i += 200) {
    const res = await db.batch(stmts.slice(i, i + 200));
    added += res.filter((rows) => rows.length > 0).length;
  }
  await db.run("INSERT INTO meta (key, value) VALUES ('seed_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", hash);
  db.invalidate("prompts");
  return added;
}
