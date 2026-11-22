// Builds the whole site for Vercel using its Build Output API (.vercel/output):
//   static/            the React client (from `vite build` → dist/)
//   functions/api.func  the API as one bundled Node function (server/src/vercel.ts)
//   config.json         routing: /api/* → function, files, then SPA fallback
// Docs: https://vercel.com/docs/build-output-api/v3
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".vercel", "output");
const fn = join(out, "functions", "api.func");

rmSync(out, { recursive: true, force: true });
mkdirSync(fn, { recursive: true });

cpSync(join(root, "dist"), join(out, "static"), { recursive: true });

await build({
  entryPoints: [join(root, "server", "src", "vercel.ts")],
  outfile: join(fn, "index.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: false,
  sourcemap: "linked",
  legalComments: "none",
  // CommonJS dependencies inside an ESM bundle need a real `require`.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  plugins: [{
    // The native client is only used for local files, never on Vercel. Keep it
    // (and its .node binaries) out of the bundle; "@libsql/client/web" is bundled.
    name: "skip-native-libsql",
    setup(b) {
      b.onResolve({ filter: /^@libsql\/client$/ }, (a) => ({ path: a.path, external: true }));
    },
  }],
  logLevel: "warning",
});

writeFileSync(join(fn, ".vc-config.json"), JSON.stringify({
  runtime: "nodejs22.x",
  handler: "index.mjs",
  launcherType: "Nodejs",
  shouldAddHelpers: false, // the app reads the raw request body itself
  supportsResponseStreaming: false,
  maxDuration: 30,
}, null, 2));
writeFileSync(join(fn, "package.json"), JSON.stringify({ type: "module" }));

const security = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Content-Security-Policy": [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'",
    "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
  ].join("; "),
};

writeFileSync(join(out, "config.json"), JSON.stringify({
  version: 3,
  routes: [
    { src: "/api(?:/.*)?", dest: "/api" },
    { src: "/assets/(.*)", headers: { ...security, "Cache-Control": "public, max-age=31536000, immutable" }, continue: true },
    { src: "/(.*)", headers: security, continue: true },
    { handle: "filesystem" },
    { src: "/(.*)", dest: "/index.html" },
  ],
}, null, 2));

console.log("Vercel output ready: .vercel/output");
