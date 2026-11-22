// Authentication: scrypt password hashes, short-lived HS256 JWT access tokens,
// and rotating opaque refresh tokens (stored hashed, revocable, with reuse
// detection). Both tokens travel only in HttpOnly SameSite=Strict cookies, so
// page JavaScript can't read them. node:crypto only, no dependencies.

import type { DatabaseSync } from "node:sqlite";
import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { transaction } from "./db.ts";
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
type SessionRow = { id: number; user_id: number; family: string; expires_at: number; revoked_at: number | null };

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function createAuth(db: DatabaseSync, opts: AuthOptions) {
  if (opts.jwtSecret.length < 32) throw new Error("JWT secret must be at least 32 characters");
  const accessTtlSec = opts.accessTtlSec ?? 15 * 60;
  const refreshTtlSec = opts.refreshTtlSec ?? 30 * 24 * 3600;
  // A refresh token revoked this recently was probably used by a parallel tab, not stolen.
  const rotationGraceMs = opts.rotationGraceMs ?? 15_000;
  const admins = new Set((opts.adminEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean));
  // Used to burn the same time on unknown emails as on wrong passwords.
  const dummyHash = hashPassword(randomBytes(16).toString("hex"));

  const stmts = {
    userByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
    userById: db.prepare("SELECT * FROM users WHERE id = ?"),
    insertUser: db.prepare("INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id"),
    setRole: db.prepare("UPDATE users SET role = ?, last_login_at = ? WHERE id = ?"),
    insertSession: db.prepare("INSERT INTO sessions (user_id, token_hash, family, expires_at, created_at, user_agent) VALUES (?, ?, ?, ?, ?, ?) RETURNING id"),
    sessionByHash: db.prepare("SELECT * FROM sessions WHERE token_hash = ?"),
    sessionById: db.prepare("SELECT * FROM sessions WHERE id = ?"),
    revokeSession: db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL"),
    revokeFamily: db.prepare("UPDATE sessions SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL"),
    revokeUser: db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL"),
    pruneSessions: db.prepare("DELETE FROM sessions WHERE expires_at < ?"),
    familyLive: db.prepare("SELECT 1 FROM sessions WHERE family = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1"),
    // Claim this browser's anonymous data on first sign-in.
    claimSaves: db.prepare("UPDATE OR IGNORE saves SET visitor_id = ? WHERE visitor_id = ?"),
    dropSaves: db.prepare("DELETE FROM saves WHERE visitor_id = ?"),
    claimVotes: db.prepare("UPDATE OR IGNORE votes SET visitor_id = ? WHERE visitor_id = ?"),
    dropVotes: db.prepare("DELETE FROM votes WHERE visitor_id = ?"),
    claimSubs: db.prepare("UPDATE submissions SET visitor_id = ? WHERE visitor_id = ?"),
  };

  const toDTO = (u: UserRow): UserDTO => ({ id: u.id, email: u.email, name: u.name, role: u.role === "admin" ? "admin" : "user" });

  function issue(user: UserRow, family: string, userAgent: string): Tokens {
    const now = Date.now();
    const refresh = randomBytes(32).toString("base64url");
    const { id: sid } = stmts.insertSession.get(user.id, sha256(refresh), family, now + refreshTtlSec * 1000, now, userAgent.slice(0, 200)) as { id: number };
    const iat = Math.floor(now / 1000);
    const access = signJwt({ sub: String(user.id), role: user.role, sid, iat, exp: iat + accessTtlSec }, opts.jwtSecret);
    return { access, refresh, accessTtlSec, refreshTtlSec };
  }

  function syncRole(u: UserRow): UserRow {
    const role = admins.has(u.email) ? "admin" : u.role;
    stmts.setRole.run(role, Date.now(), u.id);
    return { ...u, role };
  }

  function claimVisitor(userId: number, visitorId: string | undefined) {
    if (!visitorId || !/^[A-Za-z0-9-]{16,64}$/.test(visitorId)) return;
    const owner = `u:${userId}`;
    transaction(db, () => {
      // Rows that would collide with the account's own save/vote stay with the account.
      stmts.claimSaves.run(owner, visitorId);
      stmts.dropSaves.run(visitorId);
      stmts.claimVotes.run(owner, visitorId);
      stmts.dropVotes.run(visitorId);
      stmts.claimSubs.run(owner, visitorId);
    });
  }

  function validate(email: string, password: string) {
    if (!EMAIL_RE.test(email)) throw new AuthError(400, "invalid_email", "Enter a valid email address.");
    if (password.length < 8) throw new AuthError(400, "weak_password", "Use at least 8 characters for your password.");
    if (password.length > 200) throw new AuthError(400, "weak_password", "That password is too long.");
  }

  return {
    async register(input: { email: string; password: string; name: string; visitorId?: string; userAgent: string }) {
      const email = input.email.trim().toLowerCase();
      validate(email, input.password);
      if (stmts.userByEmail.get(email)) throw new AuthError(409, "email_taken", "An account with this email already exists. Sign in instead.");
      const hash = await hashPassword(input.password);
      let id: number;
      try {
        ({ id } = stmts.insertUser.get(email, input.name.trim().slice(0, 80), hash, admins.has(email) ? "admin" : "user", Date.now()) as { id: number });
      } catch {
        throw new AuthError(409, "email_taken", "An account with this email already exists. Sign in instead.");
      }
      const user = stmts.userById.get(id) as UserRow;
      claimVisitor(user.id, input.visitorId);
      return { user: toDTO(user), tokens: issue(user, randomUUID(), input.userAgent) };
    },

    async login(input: { email: string; password: string; visitorId?: string; userAgent: string }) {
      const email = input.email.trim().toLowerCase();
      const row = stmts.userByEmail.get(email) as UserRow | undefined;
      const ok = row ? await verifyPassword(input.password, row.password_hash) : (await verifyPassword(input.password, await dummyHash), false);
      if (!row || !ok) throw new AuthError(401, "bad_credentials", "Wrong email or password.");
      const user = syncRole(row);
      claimVisitor(user.id, input.visitorId);
      stmts.pruneSessions.run(Date.now());
      return { user: toDTO(user), tokens: issue(user, randomUUID(), input.userAgent) };
    },

    /** Rotates the refresh token. Reusing an already-rotated token revokes the whole family. */
    refresh(refreshToken: string | undefined, userAgent: string) {
      if (!refreshToken) throw new AuthError(401, "no_session", "Not signed in");
      const s = stmts.sessionByHash.get(sha256(refreshToken)) as SessionRow | undefined;
      if (!s) throw new AuthError(401, "no_session", "Not signed in");
      const now = Date.now();
      if (s.revoked_at !== null) {
        if (now - s.revoked_at > rotationGraceMs) stmts.revokeFamily.run(now, s.family); // likely stolen
        throw new AuthError(401, "session_revoked", "Session ended. Sign in again.");
      }
      if (s.expires_at <= now) throw new AuthError(401, "session_expired", "Session expired. Sign in again.");
      const row = stmts.userById.get(s.user_id) as UserRow | undefined;
      if (!row) throw new AuthError(401, "no_session", "Not signed in");
      return transaction(db, () => {
        stmts.revokeSession.run(now, s.id);
        const user = syncRole(row);
        return { user: toDTO(user), tokens: issue(user, s.family, userAgent) };
      });
    },

    logout(refreshToken: string | undefined, everywhere: boolean, userId?: number) {
      const now = Date.now();
      if (everywhere && userId !== undefined) { stmts.revokeUser.run(now, userId); return; }
      if (!refreshToken) return;
      const s = stmts.sessionByHash.get(sha256(refreshToken)) as SessionRow | undefined;
      if (s) stmts.revokeFamily.run(now, s.family);
    },

    /** The signed-in user for an access token, or null. Checks the session is still live. */
    userFromAccess(token: string | undefined): UserDTO | null {
      if (!token) return null;
      const c = verifyJwt(token, opts.jwtSecret); // throws token_expired / invalid_token
      const s = stmts.sessionById.get(c.sid) as SessionRow | undefined;
      // A revoked session's *successor* stays valid, so check the family isn't wholly revoked:
      // the access token's own session is revoked by normal rotation, which is fine for its 15 min.
      if (!s || s.user_id !== Number(c.sub)) throw new AuthError(401, "invalid_token", "Invalid token");
      const row = stmts.userById.get(Number(c.sub)) as UserRow | undefined;
      if (!row) throw new AuthError(401, "invalid_token", "Invalid token");
      if (s.revoked_at !== null && !isFamilyLive(s.family)) throw new AuthError(401, "session_revoked", "Session ended. Sign in again.");
      return toDTO(row);
    },
  };

  function isFamilyLive(family: string): boolean {
    return !!stmts.familyLive.get(family, Date.now());
  }
}

export type Auth = ReturnType<typeof createAuth>;
