import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dbConfigFromEnv, openDatabase } from "./db.ts";
import { createService } from "./api.ts";
import { createApp } from "./app.ts";
import { createAnalyzer } from "./analyze.ts";
import { transcriberFromEnv } from "./stt.ts";
import { createAuth } from "./auth.ts";
import { randomBytes } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const STATIC_DIR = resolve(ROOT, process.env.STATIC_DIR ?? "dist");

const dbConfig = dbConfigFromEnv(process.env, ROOT);
const db = await openDatabase(dbConfig);
const count = (await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM prompts"))!.n;
const dbLabel = dbConfig.url.startsWith("file:") ? dbConfig.url.slice(5) : new URL(dbConfig.url).host;

const transcriber = transcriberFromEnv(process.env);

let jwtSecret = process.env.JWT_SECRET ?? "";
if (jwtSecret.length < 32) {
  if (process.env.NODE_ENV === "production") {
    console.error("JWT_SECRET must be set to at least 32 random characters in production (e.g. openssl rand -base64 48).");
    process.exit(1);
  }
  jwtSecret = randomBytes(48).toString("base64url");
  console.warn("JWT_SECRET not set: using a random dev secret. Access tokens reset on restart; refresh sessions survive.");
}
const auth = createAuth(db, {
  jwtSecret,
  adminEmails: (process.env.ADMIN_EMAILS ?? "").split(","),
});

const server = createServer(
  createApp({
    service: createService(db),
    auth,
    analyzer: createAnalyzer(db, { transcriber }),
    adminToken: process.env.ADMIN_TOKEN || undefined,
    staticDir: STATIC_DIR,
    trustProxy: process.env.TRUST_PROXY === "1",
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  }),
);
server.listen(PORT, HOST, () => {
  console.log(`PromptVault API on http://localhost:${PORT}  (db: ${dbLabel}, ${count} prompts)`);
  console.log(`Post analyzer: STT ${transcriber ? "on (whisper.cpp)" : "off — set WHISPER_BIN + WHISPER_MODEL"}, admins: ${process.env.ADMIN_EMAILS ? process.env.ADMIN_EMAILS : "none — set ADMIN_EMAILS"}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
