DROP TABLE IF EXISTS entries;
--> statement-breakpoint
CREATE TABLE prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  master_prompt TEXT NOT NULL,
  category TEXT NOT NULL,
  tool TEXT NOT NULL,
  use_cases TEXT NOT NULL DEFAULT '[]',
  variables TEXT NOT NULL DEFAULT '[]',
  viral_score REAL NOT NULL DEFAULT 0,
  copy_count INTEGER NOT NULL DEFAULT 0,
  worked_votes INTEGER NOT NULL DEFAULT 0,
  total_votes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE saves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reel_url TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'AI Photo',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);
