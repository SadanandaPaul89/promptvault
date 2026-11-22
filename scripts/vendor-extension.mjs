// Copies Tesseract.js (OCR) into extension/vendor/ — MV3 extensions can't load
// code from a CDN, so the worker, WASM core and English data ship inside it.
// Run: npm run ext:vendor
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = join(root, "node_modules");
const out = join(root, "extension", "vendor", "tesseract");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "core"), { recursive: true });
mkdirSync(join(out, "lang"), { recursive: true });

cpSync(join(nm, "tesseract.js", "dist", "tesseract.esm.min.js"), join(out, "tesseract.esm.min.js"));
cpSync(join(nm, "tesseract.js", "dist", "worker.min.js"), join(out, "worker.min.js"));
// LSTM-only engine (OEM 1). The *.wasm.js builds embed the WASM; the worker picks
// the plain / SIMD / relaxed-SIMD one at runtime.
for (const f of readdirSync(join(nm, "tesseract.js-core"))) {
  if (/^tesseract-core.*lstm\.wasm\.js$/.test(f)) cpSync(join(nm, "tesseract.js-core", f), join(out, "core", f));
}
cpSync(join(nm, "@tesseract.js-data", "eng", "4.0.0", "eng.traineddata.gz"), join(out, "lang", "eng.traineddata.gz"));

console.log("Vendored Tesseract.js into", out);
for (const d of ["", "core", "lang"]) console.log(" ", d || ".", readdirSync(join(out, d)).join(", "));
