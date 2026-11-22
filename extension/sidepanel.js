import Tesseract from "./vendor/tesseract/tesseract.esm.min.js";
import { API_BASE, MAX_RECORD_SECONDS } from "./config.js";
import { readPost, prepareVideo } from "./page.js";
import { recordTab } from "./capture.js";

const $ = (id) => document.getElementById(id);
const SUPPORTED = /^https:\/\/([a-z0-9-]+\.)?(instagram|linkedin)\.com\//i;

// ---------------------------------------------------------------- identity / consent

async function visitorId() {
  const { visitorId: id } = await chrome.storage.local.get("visitorId");
  if (id) return id;
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ visitorId: fresh });
  return fresh;
}

async function api(path, body) {
  const res = await fetch(API_BASE + path, {
    method: body ? "POST" : "GET",
    headers: { "X-Visitor-Id": await visitorId(), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `PromptVault server error (${res.status})`);
  return data;
}

// ---------------------------------------------------------------- OCR (runs locally, in this panel)

let workerPromise;
function ocrWorker() {
  workerPromise ??= Tesseract.createWorker("eng", 1, {
    workerPath: chrome.runtime.getURL("vendor/tesseract/worker.min.js"),
    corePath: chrome.runtime.getURL("vendor/tesseract/core"),
    langPath: chrome.runtime.getURL("vendor/tesseract/lang"),
    workerBlobURL: false,
    gzip: true,
    cacheMethod: "none",
  });
  return workerPromise;
}

async function ocr(blob) {
  const worker = await ocrWorker();
  const { data } = await worker.recognize(blob);
  if (data.confidence < 45) return "";
  // Drop OCR noise: very short lines and lines that are mostly symbols.
  return data.text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= 3 && (l.match(/[A-Za-z]/g) ?? []).length / l.length > 0.5)
    .join("\n");
}

/** Keeps distinct OCR texts; consecutive reel frames often show the same text. */
function dedupeTexts(texts) {
  const words = (s) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const kept = [];
  for (const t of texts.filter((x) => x.length >= 20)) {
    const w = words(t);
    const i = kept.findIndex((k) => {
      const kw = words(k);
      let inter = 0;
      for (const x of w) if (kw.has(x)) inter++;
      return inter / Math.min(w.size, kw.size) > 0.7;
    });
    if (i === -1) kept.push(t);
    else if (t.length > kept[i].length) kept[i] = t;
  }
  return kept.join("\n\n");
}

async function blobToBase64(blob) {
  const url = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
  return String(url).split(",")[1];
}

// ---------------------------------------------------------------- UI helpers

function progress(pct, text) {
  $("progress").hidden = false;
  $("bar-fill").style.width = `${Math.round(pct)}%`;
  $("progress-text").textContent = text;
}

function showError(msg) {
  $("error").hidden = !msg;
  $("error").textContent = msg ?? "";
}

function el(tag, props = {}, children = []) {
  const e = Object.assign(document.createElement(tag), props);
  for (const c of [].concat(children)) e.append(c);
  return e;
}

const STATUS_LABEL = { approved: "Ready", pending: "In review", no_prompt: "No prompt", rejected: "No prompt", dm_gated: "DM-gated" };

function renderResult(r, notes = []) {
  const box = $("result");
  box.replaceChildren();
  box.append(
    el("p", {}, [el("span", { className: `status ${r.status}`, textContent: STATUS_LABEL[r.status] ?? r.status }), r.cached ? el("span", { className: "muted", textContent: "  · from the vault" }) : ""]),
    el("p", { textContent: r.message }),
  );
  for (const n of notes) box.append(el("p", { className: "muted", textContent: n }));
  for (const p of r.prompts ?? []) {
    const copy = el("button", { textContent: "Copy prompt" });
    copy.onclick = async () => {
      await navigator.clipboard.writeText(p.masterPrompt);
      copy.textContent = "Copied ✓";
      fetch(`${API_BASE}/api/prompts/${p.id}/copy`, { method: "POST", headers: { "X-Visitor-Id": await visitorId() } }).catch(() => {});
      setTimeout(() => (copy.textContent = "Copy prompt"), 1500);
    };
    box.append(
      el("div", { className: "card" }, [
        el("h3", { textContent: p.title }),
        el("div", { className: "meta", textContent: `${p.tool} · ${p.category}${p.variables.length ? ` · fill in: ${p.variables.join(", ")}` : ""}` }),
        el("pre", { textContent: p.masterPrompt }),
        copy,
      ]),
    );
  }
  box.append(el("div", { className: "row" }, [el("a", { href: API_BASE, target: "_blank", textContent: "Open PromptVault ↗" })]));
}

// ---------------------------------------------------------------- main flow

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function inTab(tabId, func) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func });
  return res?.result;
}

async function refreshTarget() {
  const tab = await activeTab();
  const ok = !!tab?.url && SUPPORTED.test(tab.url);
  $("analyze").disabled = !ok;
  $("target").textContent = ok ? tab.url : "Open an Instagram reel/post or a LinkedIn post.";
  $("listen-row").hidden = !ok;
}

async function analyze() {
  showError("");
  $("result").replaceChildren();
  $("analyze").disabled = true;
  const notes = [];
  try {
    const tab = await activeTab();
    progress(5, "Finding the post…");
    const post = await inTab(tab.id, readPost);
    if (!post?.platform) throw new Error("Open an Instagram or LinkedIn post first.");
    if (!post.postUrl) throw new Error("Couldn't find a single post here. Open the post itself, or scroll so one post fills the screen.");

    // 1. Cache first — free, and instant if anyone analysed this post before.
    progress(10, "Checking the vault…");
    const cached = await api(`/api/analyze?url=${encodeURIComponent(post.postUrl)}`);
    if (cached.found) {
      progress(100, "");
      $("progress").hidden = true;
      return renderResult(cached);
    }

    // 2. Images → OCR, locally. (Skipped for videos: their <img> is just a poster frame.)
    const ocrTexts = [];
    if (!post.video) {
      for (const [i, src] of post.imageUrls.entries()) {
        progress(15 + (i / post.imageUrls.length) * 35, `Reading text in image ${i + 1} of ${post.imageUrls.length}…`);
        try {
          ocrTexts.push(await ocr(await (await fetch(src)).blob()));
        } catch (e) {
          console.warn("image OCR failed", src, e);
        }
      }
    }
    if (post.hasDocument) notes.push("This post has a document carousel. Those can't be read yet, so only the post text was checked.");

    // 3. Reel → record audio + frames while it plays.
    let audio = null;
    if (post.video && $("listen").checked) {
      const prep = await inTab(tab.id, prepareVideo);
      if (!prep?.ok) throw new Error(prep?.reason || "Couldn't play the reel.");
      const seconds = Math.min(MAX_RECORD_SECONDS, Math.ceil(prep.duration || 30));
      let rec;
      try {
        rec = await recordTab(tab.id, { seconds, rect: prep.rect, viewport: prep.viewport }, (t, total) =>
          progress(15 + (t / total) * 45, `Listening… ${Math.floor(t)}s / ${Math.ceil(total)}s — keep this panel open`),
        );
      } catch (e) {
        throw new Error(`Couldn't record this tab (${e.message}). Click the PromptVault toolbar icon on this tab once, then retry.`);
      }
      audio = rec.audio;
      if (!audio) notes.push("The reel was silent, so only the on-screen text and caption were checked.");
      for (const [i, frame] of rec.frames.entries()) {
        progress(60 + (i / rec.frames.length) * 25, `Reading on-screen text ${i + 1} of ${rec.frames.length}…`);
        ocrTexts.push(await ocr(frame));
      }
    }

    // 4. Send derived text (+ audio for STT). Media is discarded server-side after transcription.
    progress(90, audio ? "Transcribing and finding prompts… (can take a minute)" : "Finding prompts…");
    const result = await api("/api/analyze", {
      url: post.postUrl,
      creator: post.creator,
      text: post.text,
      ocrText: dedupeTexts(ocrTexts),
      audio: audio ? { mime: audio.type, data: await blobToBase64(audio) } : undefined,
    });
    progress(100, "");
    $("progress").hidden = true;
    renderResult(result, notes);
  } catch (e) {
    $("progress").hidden = true;
    showError(e.message || String(e));
  } finally {
    $("analyze").disabled = false;
  }
}

async function init() {
  const { consent } = await chrome.storage.local.get("consent");
  $("consent").hidden = !!consent;
  $("app").hidden = !consent;
  $("consent-ok").onclick = async () => {
    await chrome.storage.local.set({ consent: true });
    $("consent").hidden = true;
    $("app").hidden = false;
  };
  $("analyze").onclick = analyze;
  chrome.tabs.onActivated.addListener(refreshTarget);
  chrome.tabs.onUpdated.addListener((_id, info) => { if (info.url) refreshTarget(); });
  await refreshTarget();
}

init();
