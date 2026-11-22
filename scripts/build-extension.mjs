// Packages the browser extension as dist/promptvault-extension.zip, so the site
// can offer it for download (Install extension button). The zip holds one folder,
// "promptvault-extension/", that users pick in chrome://extensions → Load unpacked.
//
// The packaged copy talks to the deployed API instead of localhost. The origin is:
//   EXTENSION_API_BASE                      if set (e.g. https://promptvault.example.com)
//   https://$VERCEL_PROJECT_PRODUCTION_URL  on Vercel (set automatically at build time)
//   http://localhost:3000                   otherwise (local builds)
//
// Run: npm run ext:zip (also part of `npm run build` and `npm run build:vercel`).
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { crc32, deflateRawSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "extension");
const outFile = join(root, "dist", "promptvault-extension.zip");
const FOLDER = "promptvault-extension";
const DEV_ORIGIN = "http://localhost:3000";

const origin = (() => {
  const raw = process.env.EXTENSION_API_BASE
    || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : DEV_ORIGIN);
  const u = new URL(raw);
  if (u.protocol !== "https:" && u.hostname !== "localhost") throw new Error(`EXTENSION_API_BASE must be https: ${raw}`);
  return u.origin;
})();

// MV3 can't load code from a CDN, so OCR ships inside the extension.
if (!existsSync(join(src, "vendor", "tesseract", "worker.min.js"))) {
  execFileSync(process.execPath, [join(root, "scripts", "vendor-extension.mjs")], { stdio: "inherit" });
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** File contents, with the API origin swapped in where the extension names it. */
function contents(rel, buf) {
  if (rel === "config.js") {
    const out = buf.toString("utf8").replace(`"${DEV_ORIGIN}"`, JSON.stringify(origin));
    if (!out.includes(JSON.stringify(origin))) throw new Error("config.js: API_BASE not found");
    return Buffer.from(out);
  }
  if (rel === "manifest.json") {
    const m = JSON.parse(buf.toString("utf8"));
    m.host_permissions = m.host_permissions.map((h) => (h === `${DEV_ORIGIN}/*` ? `${origin}/*` : h));
    if (!m.host_permissions.includes(`${origin}/*`)) throw new Error("manifest.json: localhost host permission not found");
    return Buffer.from(JSON.stringify(m, null, 2) + "\n");
  }
  return buf;
}

// --- minimal zip writer (deflate, no zip64: the extension is well under 4 GB) ---
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  // Fixed DOS timestamp (1 Jan 2024) so the zip is byte-for-byte reproducible.
  const time = 0, date = ((2024 - 1980) << 9) | (1 << 5) | 1;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data, { level: 9 });
    const useDeflate = packed.length < data.length;
    const body = useDeflate ? packed : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);              // version needed
    local.writeUInt16LE(0x0800, 6);          // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);            // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const entries = walk(src)
  .map((p) => relative(src, p).split(sep).join("/"))
  .filter((rel) => rel !== "README.md")
  .sort()
  .map((rel) => ({ name: `${FOLDER}/${rel}`, data: contents(rel, readFileSync(join(src, rel))) }));

mkdirSync(dirname(outFile), { recursive: true });
const out = zip(entries);
writeFileSync(outFile, out);
console.log(`Extension packaged for ${origin}: dist/promptvault-extension.zip (${entries.length} files, ${(out.length / 1024 / 1024).toFixed(1)} MB)`);
if (origin === DEV_ORIGIN) console.log("  (local build: set EXTENSION_API_BASE to package it for a deployed site)");
