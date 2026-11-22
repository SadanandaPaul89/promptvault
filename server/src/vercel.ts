// Vercel serverless entry: the same app as index.ts, minus the HTTP listener and
// static files (Vercel serves dist/ itself). Bundled by scripts/build-vercel.mjs.
// The database must be remote (Turso): function instances have no lasting disk.

import type { IncomingMessage, ServerResponse } from "node:http";
import { openDatabase } from "./db.ts";
import { createService } from "./api.ts";
import { createApp } from "./app.ts";
import { createAnalyzer } from "./analyze.ts";
import { createAuth } from "./auth.ts";
import { createPromptAdmin } from "./admin-prompts.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

async function init(): Promise<Handler> {
  const env = process.env;
  if (!env.TURSO_DATABASE_URL) throw new Error("TURSO_DATABASE_URL is not set");
  if ((env.JWT_SECRET ?? "").length < 32) throw new Error("JWT_SECRET must be at least 32 characters");
  const db = await openDatabase({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN || undefined });
  return createApp({
    service: createService(db),
    auth: createAuth(db, { jwtSecret: env.JWT_SECRET!, adminEmails: (env.ADMIN_EMAILS ?? "").split(",") }),
    // No whisper.cpp on Vercel: reels are analysed from caption + on-screen text.
    analyzer: createAnalyzer(db),
    promptAdmin: createPromptAdmin(db),
    adminToken: env.ADMIN_TOKEN || undefined,
    trustProxy: true, // Vercel sets X-Forwarded-For / -Proto
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  });
}

// One database connection + app per function instance, reused across requests.
let ready: Promise<Handler> | undefined;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  ready ??= init();
  let app: Handler;
  try {
    app = await ready;
  } catch (e) {
    ready = undefined; // retry on the next request
    console.error("startup failed:", e);
    res.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "Server is misconfigured. Check the function logs." }));
    return;
  }
  await app(req, res);
}
