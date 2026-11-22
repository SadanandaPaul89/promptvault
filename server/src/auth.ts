// Authentication: scrypt password hashes, short-lived HS256 JWT access tokens,
// and rotating opaque refresh tokens (stored hashed, revocable, with reuse
// detection). Both tokens travel only in HttpOnly SameSite=Strict cookies, so
// page JavaScript can't read them. node:crypto only, no dependencies.

import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import type { Db, Stmt } from "./db.ts";
import type { UserDTO } from "./types.ts";

export class AuthError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------- passwords

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

function scryptAsync(password: string, salt: Buffer, N: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, keylen, { N, r, p, maxmem: SCRYPT.maxmem }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keylen);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const key = await scryptAsync(password, Buffer.from(salt, "base64url"), Number(n), Number(r), Number(p), expected.length);
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// ---------------------------------------------------------------- JWT (HS256)

const ISSUER = "promptvault";
const AUDIENCE = "promptvault-web";
const JWT_HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");

export type AccessClaims = { sub: string; role: string; iat: number; exp: number; iss: string; aud: string; sid: number; jti: string };

export function signJwt(claims: Omit<AccessClaims, "iss" | "aud" | "jti">, secret: string): string {
  const payload = Buffer.from(JSON.stringify({ ...claims, iss: ISSUER, aud: AUDIENCE, jti: randomUUID() })).toString("base64url");
  const sig = createHmac("sha256", secret).update(`${JWT_HEADER}.${payload}`).digest("base64url");
  return `${JWT_HEADER}.${payload}.${sig}`;
}

/** Strict verification: exact header (no alg switching / "none"), signature, iss, aud, exp, iat. */
export function verifyJwt(token: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): AccessClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError(401, "invalid_token", "Invalid token");
  const [header, payload, sig] = parts as [string, string, string];
  if (header !== JWT_HEADER) throw new AuthError(401, "invalid_token", "Invalid token");
  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new AuthError(401, "invalid_token", "Invalid token");
  let c: AccessClaims;
  try {
    c = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AccessClaims;
  } catch {
    throw new AuthError(401, "invalid_token", "Invalid token");
  }
  if (c.iss !== ISSUER || c.aud !== AUDIENCE || typeof c.sub !== "string" || typeof c.exp !== "number" || typeof c.iat !== "number") {
    throw new AuthError(401, "invalid_token", "Invalid token");
  }
  if (c.iat > nowSec + 60) throw new AuthError(401, "invalid_token", "Invalid token");
  if (c.exp <= nowSec) throw new AuthError(401, "token_expired", "Session expired");
  return c;
}

// ---------------------------------------------------------------- cookies

export const ACCESS_COOKIE = "pv_at";
export const REFRESH_COOKIE = "pv_rt";

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) {
      try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed */ }
    }
  }
  return out;
}

export function cookie(name: string, value: string, opts: { maxAgeSec: number; path: string; secure: boolean }): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path}`,
    `Max-Age=${opts.maxAgeSec}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(opts.secure ? ["Secure"] : []),
  ].join("; ");
}

// ---------------------------------------------------------------- service

export type AuthOptions = {
  jwtSecret: string;
  /** Emails that get the admin role (on register and on every login). */
  adminEmails?: string[];
  accessTtlSec?: number;
  refreshTtlSec?: number;
  /** How long a just-rotated refresh token is tolerated (parallel tabs) before reuse counts as theft. */
  rotationGraceMs?: number;
};

export type Tokens = { access: string; refresh: string; accessTtlSec: number; refreshTtlSec: number };

type UserRow = { id: number; email: string; name: string; password_hash: string; role: string; created_at: number };
type SessionWithUser = UserRow & { sid: number; user_id: number; family: string; expires_at: number; revoked_at: number | null };

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const VISITOR_RE = /^[A-Za-z0-9-]{16,64}$/;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function createAuth(db: Db, opts: AuthOptions) {
  if (opts.jwtSecret.length < 32) throw new Error("JWT secret must be at least 32 characters");
  const accessTtlSec = opts.accessTtlSec ?? 15 * 60;
  const refreshTtlSec = opts.refreshTtlSec ?? 30 * 24 * 3600;
  // A refresh token revoked this recently was probably used by a parallel tab, not stolen.
  const rotationGraceMs = opts.rotationGraceMs ?? 15_000;
  const admins = new Set((opts.adminEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean));
  // Used to burn the same time on unknown emails as on wrong passwords.
  const dummyHash = hashPassword(randomBytes(16).toString("hex"));

  const toDTO = (u: UserRow): UserDTO => ({ id: u.id, email: u.email, name: u.name, role: u.role === "admin" ? "admin" : "user" });

  /** A new refresh session. Run it (as the last statement of a batch), then finish with the session id it returns. */
  function newSession(user: UserRow, family: string, userAgent: string) {
    const now = Date.now();
    const refresh = randomBytes(32).toString("base64url");
    const stmt: Stmt = {
      sql: "INSERT INTO sessions (user_id, token_hash, family, expires_at, created_at, user_agent) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
      args: [user.id, sha256(refresh), family, now + refreshTtlSec * 1000, now, userAgent.slice(0, 200)],
    };
    const finish = (sid: number): Tokens => {
      const iat = Math.floor(now / 1000);
      const access = signJwt({ sub: String(user.id), role: user.role, sid, iat, exp: iat + accessTtlSec }, opts.jwtSecret);
      return { access, refresh, accessTtlSec, refreshTtlSec };
    };
    return { stmt, finish };
  }

  /** Runs `before` and the session insert atomically, returning the new tokens. */
  async function issue(user: UserRow, family: string, userAgent: string, before: Stmt[] = []): Promise<Tokens> {
    const s = newSession(user, family, userAgent);
    const results = await db.batch<{ id: number }>([...before, s.stmt]);
    return s.finish(results[results.length - 1]![0]!.id);
  }

  /** Admin role from ADMIN_EMAILS is applied at every sign-in and refresh. */
  function syncRole(u: UserRow): { user: UserRow; stmt: Stmt } {
    const role = admins.has(u.email) ? "admin" : u.role;
    return { user: { ...u, role }, stmt: { sql: "UPDATE users SET role = ?, last_login_at = ? WHERE id = ?", args: [role, Date.now(), u.id] } };
  }

  /** Moves this browser's anonymous saves/votes/submissions into the account. */
  function claimVisitor(userId: number, visitorId: string | undefined): Stmt[] {
    if (!visitorId || !VISITOR_RE.test(visitorId)) return [];
    const owner = `u:${userId}`;
    // Rows that would collide with the account's own save/vote stay with the account.
    return [
      { sql: "UPDATE OR IGNORE saves SET visitor_id = ? WHERE visitor_id = ?", args: [owner, visitorId] },
      { sql: "DELETE FROM saves WHERE visitor_id = ?", args: [visitorId] },
      { sql: "UPDATE OR IGNORE votes SET visitor_id = ? WHERE visitor_id = ?", args: [owner, visitorId] },
      { sql: "DELETE FROM votes WHERE visitor_id = ?", args: [visitorId] },
      { sql: "UPDATE submissions SET visitor_id = ? WHERE visitor_id = ?", args: [owner, visitorId] },
    ];
  }

  function validate(email: string, password: string) {
    if (!EMAIL_RE.test(email)) throw new AuthError(400, "invalid_email", "Enter a valid email address.");
    if (password.length < 8) throw new AuthError(400, "weak_password", "Use at least 8 characters for your password.");
    if (password.length > 200) throw new AuthError(400, "weak_password", "That password is too long.");
  }

  const emailTaken = () => new AuthError(409, "email_taken", "An account with this email already exists. Sign in instead.");

  return {
    async register(input: { email: string; password: string; name: string; visitorId?: string; userAgent: string }) {
      const email = input.email.trim().toLowerCase();
      validate(email, input.password);
      if (await db.get("SELECT 1 AS ok FROM users WHERE email = ?", email)) throw emailTaken();
      const hash = await hashPassword(input.password);
      let user: UserRow | undefined;
      try {
        user = await db.get<UserRow>(
          "INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *",
          email, input.name.trim().slice(0, 80), hash, admins.has(email) ? "admin" : "user", Date.now(),
        );
      } catch {
        throw emailTaken(); // lost a race with a concurrent sign-up
      }
      const tokens = await issue(user!, randomUUID(), input.userAgent, claimVisitor(user!.id, input.visitorId));
      return { user: toDTO(user!), tokens };
    },

    async login(input: { email: string; password: string; visitorId?: string; userAgent: string }) {
      const email = input.email.trim().toLowerCase();
      const row = await db.get<UserRow>("SELECT * FROM users WHERE email = ?", email);
      const ok = row ? await verifyPassword(input.password, row.password_hash) : (await verifyPassword(input.password, await dummyHash), false);
      if (!row || !ok) throw new AuthError(401, "bad_credentials", "Wrong email or password.");
      const { user, stmt } = syncRole(row);
      const tokens = await issue(user, randomUUID(), input.userAgent, [
        stmt,
        ...claimVisitor(user.id, input.visitorId),
        { sql: "DELETE FROM sessions WHERE expires_at < ?", args: [Date.now()] },
      ]);
      return { user: toDTO(user), tokens };
    },

    /** Rotates the refresh token. Reusing an already-rotated token revokes the whole family. */
    async refresh(refreshToken: string | undefined, userAgent: string) {
      if (!refreshToken) throw new AuthError(401, "no_session", "Not signed in");
      const s = await db.get<SessionWithUser>(
        `SELECT u.*, s.id AS sid, s.user_id, s.family, s.expires_at, s.revoked_at
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
        sha256(refreshToken),
      );
      if (!s) throw new AuthError(401, "no_session", "Not signed in");
      const now = Date.now();
      if (s.revoked_at !== null) {
        if (now - s.revoked_at > rotationGraceMs) {
          // Likely stolen: end every session descended from this sign-in.
          await db.run("UPDATE sessions SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL", now, s.family);
        }
        throw new AuthError(401, "session_revoked", "Session ended. Sign in again.");
      }
      if (s.expires_at <= now) throw new AuthError(401, "session_expired", "Session expired. Sign in again.");
      const { user, stmt } = syncRole(s);
      const tokens = await issue(user, s.family, userAgent, [
        { sql: "UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", args: [now, s.sid] },
        stmt,
      ]);
      return { user: toDTO(user), tokens };
    },

    async logout(refreshToken: string | undefined, everywhere: boolean, userId?: number) {
      const now = Date.now();
      if (everywhere && userId !== undefined) {
        await db.run("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", now, userId);
        return;
      }
      if (!refreshToken) return;
      await db.run(
        "UPDATE sessions SET revoked_at = ? WHERE family = (SELECT family FROM sessions WHERE token_hash = ?) AND revoked_at IS NULL",
        now, sha256(refreshToken),
      );
    },

    /** The signed-in user for an access token, or null. Checks the session is still live (one query). */
    async userFromAccess(token: string | undefined): Promise<UserDTO | null> {
      if (!token) return null;
      const c = verifyJwt(token, opts.jwtSecret); // throws token_expired / invalid_token
      // The access token's own session is revoked by normal rotation, which is fine for its 15 minutes,
      // so what matters is that the family (this sign-in) still has a live session.
      const row = await db.get<UserRow & { user_id: number; live: number }>(
        `SELECT u.*, s.user_id,
                (s.revoked_at IS NULL OR EXISTS (
                   SELECT 1 FROM sessions f WHERE f.family = s.family AND f.revoked_at IS NULL AND f.expires_at > ?)) AS live
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
        Date.now(), c.sid,
      );
      if (!row || row.user_id !== Number(c.sub)) throw new AuthError(401, "invalid_token", "Invalid token");
      if (!row.live) throw new AuthError(401, "session_revoked", "Session ended. Sign in again.");
      return toDTO(row);
    },
  };
}

export type Auth = ReturnType<typeof createAuth>;
