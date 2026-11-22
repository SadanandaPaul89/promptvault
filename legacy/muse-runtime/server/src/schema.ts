import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const prompts = sqliteTable("prompts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  masterPrompt: text("master_prompt").notNull(),
  category: text("category").notNull(),
  tool: text("tool").notNull(),
  useCases: text("use_cases").notNull().default("[]"),
  variables: text("variables").notNull().default("[]"),
  viralScore: real("viral_score").notNull().default(0),
  copyCount: integer("copy_count").notNull().default(0),
  workedVotes: integer("worked_votes").notNull().default(0),
  totalVotes: integer("total_votes").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const saves = sqliteTable("saves", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  promptId: integer("prompt_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const submissions = sqliteTable("submissions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  reelUrl: text("reel_url").notNull(),
  note: text("note").notNull().default(""),
  category: text("category").notNull().default("AI Photo"),
  status: text("status").notNull().default("pending"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});
