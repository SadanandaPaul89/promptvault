import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SEED_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "seed");

/** Seed files → collection name. Add a file here to ship a new collection. */
export const SEED_FILES: { file: string; collection: string }[] = [
  { file: "viral-prompts.json", collection: "Viral Creator Prompts" },
  { file: "pm-library-seed.json", collection: "Product Management" },
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

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  seed(db);
  return db;
}

function migrate(db: DatabaseSync) {
  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function seedKey(collection: string, s: SeedPrompt): string {
  return createHash("sha1").update(`${collection}\n${s.title}\n${s.masterPrompt}`).digest("hex");
}

/**
 * Idempotent: inserts seed prompts that aren't in the DB yet (matched by
 * content hash). Existing rows — and their real copies/votes — are never
 * overwritten, so it's safe to run on every boot and to add new seed files.
 */
export function seed(db: DatabaseSync): number {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO prompts
       (seed_key, title, master_prompt, collection, category, section, tool, use_cases, variables,
        viral_score, copy_count, worked_votes, total_votes, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const now = Date.now();
  let added = 0;
  transaction(db, () => {
    for (const { file, collection } of SEED_FILES) {
      const items = JSON.parse(readFileSync(join(SEED_DIR, file), "utf8")) as SeedPrompt[];
      for (const s of items) {
        const r = insert.run(
          seedKey(collection, s), s.title, s.masterPrompt, collection, s.category, s.section ?? s.category, s.tool,
          JSON.stringify(s.useCases ?? []), JSON.stringify(s.variables ?? []),
          s.viralScore ?? 0, s.copyCount ?? 0, s.workedVotes ?? 0, s.totalVotes ?? 0,
          now - (s.daysAgo ?? 0) * 86_400_000,
        );
        added += Number(r.changes);
      }
    }
  });
  return added;
}
