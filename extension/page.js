// Functions injected into the Instagram / LinkedIn tab with
// chrome.scripting.executeScript. Each must be fully self-contained (Chrome
// serializes the function source), so helpers are defined inside.
//
// They read only what the user is already looking at, in their own session,
// and only when they click Analyze. Selectors are layered with fallbacks
// because both sites change their markup often.

/**
 * Finds the post the user is looking at and returns its URL, text, creator,
 * image URLs and (if any) the video to record. Marks that video with
 * data-pv-target so `prepareVideo` can find it.
 */
export function readPost() {
  const vw = innerWidth;
  const vh = innerHeight;
  const visibleArea = (el) => {
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    return w * h;
  };
  /** The candidate that covers the most of the viewport (the one being viewed). */
  const mostVisible = (els) => {
    let best = null;
    let bestA = 0;
    for (const el of els) {
      const a = visibleArea(el);
      if (a > bestA) { best = el; bestA = a; }
    }
    return best;
  };
  const text = (el) => (el?.textContent ?? "").replace(/\s+\n/g, "\n").trim();
  const meta = (p) => document.querySelector(`meta[property="${p}"], meta[name="${p}"]`)?.getAttribute("content") ?? "";
  const bigImages = (root, exclude) => {
    const out = [];
    for (const img of root.querySelectorAll("img")) {
      if (exclude && img.closest(exclude)) continue;
      const r = img.getBoundingClientRect();
      if (img.naturalWidth < 300 || r.width < 150) continue;
      if (/profile (picture|photo)/i.test(img.alt)) continue;
      const src = img.currentSrc || img.src;
      if (src.startsWith("http") && !out.includes(src)) out.push(src);
    }
    return out.slice(0, 10);
  };
  const videoInfo = (root) => {
    document.querySelectorAll("video[data-pv-target]").forEach((v) => v.removeAttribute("data-pv-target"));
    const v = mostVisible(root.querySelectorAll("video"));
    if (!v) return null;
    v.setAttribute("data-pv-target", "1");
    const r = v.getBoundingClientRect();
    return {
      duration: Number.isFinite(v.duration) ? v.duration : 0,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      viewport: { width: vw, height: vh },
    };
  };

  const host = location.hostname;
  let path = location.pathname;
  const isPostPath = (p) => /\/(p|reel|reels|tv)\/[A-Za-z0-9_-]{5,}/.test(p);

  // ---------------------------------------------------------------- Instagram
  if (/(^|\.)instagram\.com$/.test(host)) {
    // A post/reel page, a post opened as a modal, or the feed / reels tab.
    const dialog = [...document.querySelectorAll('div[role="dialog"]')].find((d) => d.querySelector("video, img") && visibleArea(d) > 0);
    const roots = dialog ? [dialog] : [...document.querySelectorAll("article, main")];
    const root = mostVisible(roots) ?? document.body;

    let postUrl = isPostPath(path) ? location.href : "";
    if (!postUrl) {
      // Feed: the post's timestamp links to its permalink.
      const link = [...root.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')].find((a) => a.querySelector("time")) ?? root.querySelector('a[href*="/p/"], a[href*="/reel/"]');
      if (link) postUrl = new URL(link.getAttribute("href"), location.origin).href;
    }

    // Caption: <h1> on post pages; else the longest text span in the post's
    // comment/caption list; else og:description — but only if it's for THIS post
    // (meta tags go stale after in-app navigation).
    let caption = text(root.querySelector("h1"));
    if (!caption) {
      const spans = [...root.querySelectorAll("ul li span, span[dir='auto']")].map(text).sort((a, b) => b.length - a.length);
      if (spans[0] && spans[0].length > 40) caption = spans[0];
    }
    const ogUrl = meta("og:url");
    if (!caption && ogUrl && postUrl && new URL(ogUrl, location.origin).pathname.split("/").filter(Boolean).pop() === new URL(postUrl).pathname.split("/").filter(Boolean).pop()) {
      const m = meta("og:description").match(/:\s*["“]([\s\S]*)["”]\.?\s*$/);
      caption = m ? m[1] : "";
    }

    const creatorLink = root.querySelector('header a[href^="/"][role="link"], header a[href^="/"]');
    const creator = creatorLink ? "@" + creatorLink.getAttribute("href").split("/").filter(Boolean)[0] : "";

    return { platform: "instagram", postUrl, creator, text: caption, imageUrls: bigImages(root, "header"), video: videoInfo(root) };
  }

  // ---------------------------------------------------------------- LinkedIn
  if (/(^|\.)linkedin\.com$/.test(host)) {
    const posts = [...document.querySelectorAll('[data-urn^="urn:li:activity:"], [data-urn^="urn:li:ugcPost:"], [data-id^="urn:li:activity:"], .feed-shared-update-v2, article')];
    // On a single-post page prefer the post whose URN is in the URL.
    const urnInPath = decodeURIComponent(path).match(/urn:li:(activity|ugcPost|share):\d+/)?.[0];
    const root = (urnInPath && posts.find((p) => (p.getAttribute("data-urn") ?? p.getAttribute("data-id")) === urnInPath)) || mostVisible(posts) || document.querySelector("main") || document.body;

    let postUrl = "";
    if (/\/(feed\/update|posts)\//.test(path)) postUrl = location.href;
    else {
      const urn = root.getAttribute("data-urn") ?? root.getAttribute("data-id") ?? root.closest("[data-urn]")?.getAttribute("data-urn");
      if (urn && /^urn:li:(activity|ugcPost|share):\d+$/.test(urn)) postUrl = `https://www.linkedin.com/feed/update/${urn}/`;
    }

    // textContent (not innerText) so text hidden behind "…see more" is included.
    const body = root.querySelector(
      ".update-components-text, .feed-shared-inline-show-more-text, .feed-shared-update-v2__description, [data-test-id='main-feed-activity-card__commentary'], .attributed-text-segment-list__content",
    );
    const creatorEl = root.querySelector(".update-components-actor__title span[aria-hidden='true'], .update-components-actor__name, [data-test-id='main-feed-activity-card__entity-lockup'] a");

    return {
      platform: "linkedin",
      postUrl,
      creator: text(creatorEl).split("\n")[0].slice(0, 100),
      text: text(body),
      imageUrls: bigImages(root, ".update-components-actor, .feed-shared-actor"),
      video: videoInfo(root),
      // LinkedIn document carousels render in a cross-origin iframe we can't read.
      hasDocument: !!root.querySelector("iframe[src*='native-document'], .document-s-container, .update-components-document"),
    };
  }

  return { platform: null, postUrl: "", creator: "", text: "", imageUrls: [], video: null };
}

/** Rewinds the target video, unmutes it and plays it so tab audio can be recorded. */
export async function prepareVideo() {
  const v = document.querySelector("video[data-pv-target]");
  if (!v) return { ok: false, reason: "Video not found — scroll the reel into view and retry." };
  v.currentTime = 0;
  v.muted = false;
  if (v.volume === 0) v.volume = 1;
  try {
    await v.play();
  } catch {
    return { ok: false, reason: "The reel won't play with sound — click it once to unmute, then retry." };
  }
  await new Promise((r) => setTimeout(r, 400));
  const r = v.getBoundingClientRect();
  return {
    ok: !v.paused,
    reason: v.paused ? "The reel is paused — press play, then retry." : "",
    duration: Number.isFinite(v.duration) ? v.duration : 0,
    muted: v.muted,
    rect: { x: r.left, y: r.top, width: r.width, height: r.height },
    viewport: { width: innerWidth, height: innerHeight },
  };
}

/**
 * Fallback recorder that runs inside the page: records the reel's own <video>
 * via captureStream(), so it needs no tabCapture / activeTab grant. Self-contained
 * (injected with chrome.scripting). Returns base64 audio + JPEG data-URL frames.
 * @param {number} seconds
 */
export async function recordVideoInPage(seconds) {
  const FRAME_EVERY_MS = 1000, MAX_FRAMES = 30, FRAME_CHANGE = 10, SILENCE = 0.01;
  const v = document.querySelector("video[data-pv-target]");
  if (!v) return { error: "Video not found — scroll the reel into view and retry." };
  if (typeof v.captureStream !== "function") return { error: "This browser can't record the video element." };

  let stream;
  try {
    stream = v.captureStream();
  } catch (e) {
    return { error: e.message || String(e) };
  }

  const sigOf = (src) => {
    const c = document.createElement("canvas");
    c.width = c.height = 16;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(src, 0, 0, 16, 16);
    const d = g.getImageData(0, 0, 16, 16).data;
    const out = new Uint8Array(256);
    for (let i = 0; i < 256; i++) out[i] = (d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11) | 0;
    return out;
  };
  const changed = (a, b) => {
    if (!a) return true;
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum / a.length > FRAME_CHANGE;
  };

  // Audio: record + measure peak (to skip uploading silent reels).
  const audioTracks = stream.getAudioTracks();
  let recorder = null, ctx = null, analyser = null, peak = 0;
  const chunks = [];
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
  if (audioTracks.length) {
    const audioStream = new MediaStream(audioTracks);
    recorder = new MediaRecorder(audioStream, { mimeType, audioBitsPerSecond: 32000 });
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    ctx = new AudioContext();
    analyser = ctx.createAnalyser();
    ctx.createMediaStreamSource(audioStream).connect(analyser); // not to destination: the page already plays it
  }
  const stopped = recorder ? new Promise((r) => { recorder.onstop = r; }) : Promise.resolve();
  const samples = new Float32Array(analyser ? analyser.fftSize : 0);

  const frames = [];
  let lastSig = null, framesBlocked = false;
  const total = Math.max(3, seconds);
  const started = performance.now();
  recorder?.start(1000);

  try {
    await new Promise((resolve) => {
      const meter = analyser && setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        for (const s of samples) peak = Math.max(peak, Math.abs(s));
      }, 200);
      const tick = setInterval(() => {
        const elapsed = (performance.now() - started) / 1000;
        if (!framesBlocked && frames.length < MAX_FRAMES && v.videoWidth > 50) {
          try {
            const sig = sigOf(v);
            if (changed(lastSig, sig)) {
              lastSig = sig;
              const c = document.createElement("canvas");
              c.width = v.videoWidth;
              c.height = v.videoHeight;
              c.getContext("2d").drawImage(v, 0, 0);
              frames.push(c.toDataURL("image/jpeg", 0.92));
            }
          } catch {
            framesBlocked = true; // cross-origin video: canvas is tainted, keep audio only
          }
        }
        if (elapsed >= total || v.ended) {
          clearInterval(tick);
          if (meter) clearInterval(meter);
          resolve();
        }
      }, FRAME_EVERY_MS);
    });
  } finally {
    if (recorder && recorder.state !== "inactive") recorder.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    await ctx?.close();
  }

  let audio = null;
  if (recorder && peak > SILENCE && chunks.length) {
    const blob = new Blob(chunks, { type: mimeType });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    audio = { mime: mimeType, data: btoa(bin) };
  }
  return { audio, frames };
}
