import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { createService } from "../src/api.ts";
import { createApp, type AppOptions } from "../src/app.ts";
import { createAuth, type AuthOptions } from "../src/auth.ts";

export const TEST_SECRET = "test-secret-test-secret-test-secret-0123456789";

export async function startServer(db: DatabaseSync, opts: Partial<AppOptions> & { authOptions?: Partial<AuthOptions> } = {}) {
  const auth = createAuth(db, { jwtSecret: TEST_SECRET, ...opts.authOptions });
  const server: Server = createServer(createApp({ service: createService(db), auth, ...opts }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base, auth, close: () => new Promise<void>((r) => server.close(() => r())) };
}

type Cookie = { value: string; path: string };

/** A browser-like client: keeps cookies (respecting Path and Max-Age=0) and sends a same-origin Origin. */
export class Client {
  readonly jar = new Map<string, Cookie>();
  private base: string;
  private visitor: string;
  constructor(base: string, visitor = "11111111-1111-1111-1111-111111111111") {
    this.base = base;
    this.visitor = visitor;
  }

  async call<T = Record<string, unknown>>(path: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { "X-Visitor-Id": this.visitor, Origin: this.base, ...opts.headers };
    const cookies = [...this.jar].filter(([, c]) => path.startsWith(c.path)).map(([k, c]) => `${k}=${c.value}`);
    if (cookies.length) headers.Cookie = cookies.join("; ");
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(this.base + path, { method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"), headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(";").map((s) => s.trim());
      const i = pair!.indexOf("=");
      const name = pair!.slice(0, i);
      const value = pair!.slice(i + 1);
      const p = attrs.find((a) => a.toLowerCase().startsWith("path="))?.slice(5) ?? "/";
      if (attrs.some((a) => a.toLowerCase() === "max-age=0") || value === "") this.jar.delete(name);
      else this.jar.set(name, { value, path: p });
    }
    return { status: res.status, headers: res.headers, body: (await res.json()) as T };
  }

  async register(email: string, password = "correct horse battery") {
    return this.call<{ user: { id: number; email: string; role: string } }>("/api/auth/register", { body: { email, password, name: email.split("@")[0], visitorId: this.visitor } });
  }
}
